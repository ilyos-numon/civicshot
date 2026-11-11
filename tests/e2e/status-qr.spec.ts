import { test, expect, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { IssueByToken, Location, ReportResult } from '../../src/shared/types.ts';

const API = `http://localhost:${Number(process.env.API_PORT ?? process.env.PORT ?? 8870)}`;
const SINK_PORT = Number(process.env.SINK_PORT ?? 8974);
const SINK = `http://localhost:${SINK_PORT}`;
const ALT_PORT = SINK_PORT + 10; // 별도 서버용 포트: 8984
const ALT = `http://localhost:${ALT_PORT}`;
const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results';
const PHOTO = readFileSync('tests/e2e/fixtures/photos/streetlight.jpg');
const ENDPOINT = `https://push.example.test/sub/${Math.random().toString(36).slice(2)}`;
const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: 'test-p256dh', auth: 'test-auth' } };

test.describe.configure({ mode: 'serial' });

interface Proc { proc: ChildProcess; log: () => string }

async function spawnAndWait(args: string[], env: NodeJS.ProcessEnv, health: string): Promise<Proc> {
  let out = '';
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(health)).ok) return { proc, log: () => out }; } catch { /* 기동 중 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`process did not start:\n${out}`);
}

async function stop(p: Proc | undefined): Promise<void> {
  if (!p || p.proc.exitCode !== null) return;
  const done = new Promise((r) => p.proc.once('exit', r));
  p.proc.kill();
  await done;
}

async function report(r: APIRequestContext, base: string, lat: number, lng: number): Promise<ReportResult & { photoId: string }> {
  const up = await r.post(`${base}/api/photos`, { multipart: { file: { name: 's.jpg', mimeType: 'image/jpeg', buffer: PHOTO } } });
  expect(up.status()).toBe(201);
  const photoId = ((await up.json()) as { id: string }).id;
  const loc = await r.post(`${base}/api/locate`, { data: { lat, lng, facility: 'streetlight' } });
  expect(loc.status()).toBe(200);
  const res = await r.post(`${base}/api/reports`, {
    data: {
      photoId, facility: 'streetlight', fault: 'light_out', location: (await loc.json()) as Location,
      form: { title: '가로등 점등 불량 신고', body: '가로등이 밤새 꺼져 있어요. 확인 부탁드려요.', source: 'template' },
      reporterToken: `rt-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(res.status()).toBe(201);
  return { ...((await res.json()) as ReportResult), photoId };
}

const LAT = 37.5625 + Math.random() * 0.002;
const LNG = 126.9950 + Math.random() * 0.004;

test.describe('QR·상태 페이지 (기본 서버)', () => {
  let r: ReportResult & { photoId: string };

  test.afterAll(async ({ request }) => {
    if (r) await request.patch(`${API}/api/admin/issues/${r.issueId}`, { data: { status: 'completed', completionPhotoId: r.photoId } });
  });

  test('qr.svg 는 상태 주소를 담은 SVG', async ({ request }) => {
    r = await report(request, API, LAT, LNG);
    const res = await request.get(`${API}/api/issues/by-token/${r.statusToken}/qr.svg`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/svg+xml');
    expect(res.headers()['cache-control']).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('<svg');
    expect(body).toBe(await QRCode.toString(r.statusUrl, { type: 'svg', margin: 1 }));
    expect(body).not.toBe(await QRCode.toString(`${r.statusUrl}x`, { type: 'svg', margin: 1 }));
  });

  test('없는 토큰 → 404 페이지·qr 404', async ({ request }) => {
    const res = await request.get(`${API}/s/x`);
    expect(res.status()).toBe(404);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(await res.text()).toContain('찾을 수 없는 접수번호예요');
    expect((await request.get(`${API}/api/issues/by-token/x/qr.svg`)).status()).toBe(404);
  });

  test('구독: 없는 issueId 404, 본문 오류 400', async ({ request }) => {
    expect((await request.post(`${API}/api/push/subscribe`, { data: { issueId: 'nope', subscription: SUBSCRIPTION } })).status()).toBe(404);
    expect((await request.post(`${API}/api/push/subscribe`, { data: { issueId: r.issueId } })).status()).toBe(400);
    expect((await request.post(`${API}/api/push/subscribe`, { data: { subscription: SUBSCRIPTION } })).status()).toBe(400);
    expect((await request.post(`${API}/api/push/subscribe`, { headers: { 'Content-Type': 'application/json' }, data: 'not json' })).status()).toBe(400);
  });
});

test.describe('/s/:token 상태 페이지 (CLIENT_DIST_DIR 고정 서버)', () => {
  let srv: Proc | undefined;
  let dir = '';

  const start = async (clientDist: string): Promise<void> => {
    dir = mkdtempSync(join(tmpdir(), 'civicshot-status-'));
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(ALT_PORT), DATA_DIR: join(dir, 'data'), SELF_BASE_URL: ALT, CLIENT_DIST_DIR: clientDist };
    for (const k of ['SUBMISSION_ADAPTER', 'SUBMISSION_LIVE_CONFIRM', 'PUSH_SINK_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete env[k];
    srv = await spawnAndWait(['src/server/main.ts'], env, `${ALT}/health`);
  };

  test.afterEach(async () => {
    await stop(srv);
    srv = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  test('SPA 빌드가 없으면 서버 렌더 상태 페이지', async ({ request, page }) => {
    await start(join(tmpdir(), `civicshot-no-dist-${Math.random().toString(36).slice(2)}`));
    const r = await report(request, ALT, LAT, LNG);
    const res = await request.get(`${ALT}/s/${r.statusToken}`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(r.receiptNo);
    expect(html).toContain('접수');
    expect(html).toContain('가로등');
    expect(html).toContain('name="viewport"');
    expect(html).not.toMatch(/모델|분류기|지오코딩|API|LLM/);
    await page.goto(`${ALT}/s/${r.statusToken}`);
    await expect(page.getByTestId('receipt-no')).toHaveText(r.receiptNo);
    await expect(page.getByTestId('status-steps')).toHaveText('접수');
    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, 'status-page-ssr.png'), fullPage: true });
  });

  test('SPA 빌드가 있으면 그 index.html 을 그대로 준다', async ({ request }) => {
    const dist = mkdtempSync(join(tmpdir(), 'civicshot-dist-'));
    const marker = `spa-marker-${Math.random().toString(36).slice(2)}`;
    writeFileSync(join(dist, 'index.html'), `<!doctype html><html><body><div id="root"></div><!-- ${marker} --></body></html>`);
    try {
      await start(dist);
      const r = await report(request, ALT, LAT, LNG);
      const res = await request.get(`${ALT}/s/${r.statusToken}`);
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('text/html');
      const html = await res.text();
      expect(html).toContain(marker);
      expect(html).toContain('<div id="root">');
      expect(html).not.toContain(r.receiptNo);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

test.describe('완료 알림 (sink 서버)', () => {
  let sink: Proc | undefined;
  let srv: Proc | undefined;
  let dir = '';

  test.beforeAll(async () => {
    sink = await spawnAndWait(['tests/e2e/helpers/sink.ts'], { ...process.env, SINK_PORT: String(SINK_PORT) }, `${SINK}/health`);
    dir = mkdtempSync(join(tmpdir(), 'civicshot-push-'));
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(ALT_PORT), DATA_DIR: dir, SELF_BASE_URL: ALT, PUSH_SINK_URL: `${SINK}/push` };
    for (const k of ['SUBMISSION_ADAPTER', 'SUBMISSION_LIVE_CONFIRM', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete env[k];
    srv = await spawnAndWait(['src/server/main.ts'], env, `${ALT}/health`);
  });

  test.afterAll(async () => {
    await stop(srv);
    await stop(sink);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const received = async (r: APIRequestContext) => (await (await r.get(`${SINK}/received`)).json()) as Array<{ payload: { title: string; body: string; url: string }; subscription: { endpoint: string } }>;

  test('assigned 는 0건, completed 는 정확히 1건, 재 PATCH 해도 1건', async ({ request }) => {
    await request.delete(`${SINK}/received`);
    const r = await report(request, ALT, LAT, LNG);
    const sub = await request.post(`${ALT}/api/push/subscribe`, { data: { issueId: r.issueId, subscription: SUBSCRIPTION } });
    expect(sub.status()).toBe(201);
    expect(((await sub.json()) as { id: string }).id).toBeTruthy();

    const p1 = await request.patch(`${ALT}/mock-agency/admin/requests/${r.agencyRef}`, { data: { status: 'assigned' } });
    expect(p1.ok()).toBe(true);
    expect(await received(request)).toHaveLength(0);

    const p2 = await request.patch(`${ALT}/mock-agency/admin/requests/${r.agencyRef}`, { data: { status: 'completed', completionPhotoId: r.photoId } });
    expect(p2.ok()).toBe(true);
    const got = await received(request);
    expect(got).toHaveLength(1);
    expect(got[0]!.payload.title).toBe('고쳐졌어요');
    expect(got[0]!.payload.body).toBe('신고하신 가로등이 처리 완료됐어요');
    expect(got[0]!.payload.url).toMatch(new RegExp(`/s/${r.statusToken}$`));
    expect(got[0]!.subscription.endpoint).toBe(ENDPOINT);
    expect(((await (await request.get(`${ALT}/api/issues/by-token/${r.statusToken}`)).json()) as IssueByToken).status).toBe('completed');

    const p3 = await request.patch(`${ALT}/mock-agency/admin/requests/${r.agencyRef}`, { data: { status: 'completed', completionPhotoId: r.photoId } });
    expect(p3.ok()).toBe(true);
    expect(await received(request)).toHaveLength(1);

    expect(srv!.log()).not.toContain(ENDPOINT);
    expect(srv!.log()).not.toContain('push.example.test');
  });
});
