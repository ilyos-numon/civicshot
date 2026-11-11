import { test, expect, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgencyRequest, IssueByToken, Location, ReportResult, StatusResponse } from '../../src/shared/types.ts';
import { startSmtpSink, type SmtpSink } from './helpers/smtp-sink.ts';

const API = `http://localhost:${Number(process.env.API_PORT ?? process.env.PORT ?? 8870)}`;
const SINK_PORT = Number(process.env.SINK_PORT ?? 8976);
const ALT_PORT = SINK_PORT + 10; // 재기동용 별도 서버 (8986)
const CLOSED_PORT = SINK_PORT + 20; // 아무도 듣지 않는 포트 (모의 기관 다운)
const ALT = `http://localhost:${ALT_PORT}`;
const LIVE = 'I_UNDERSTAND_REAL_REPORTS_WILL_BE_SENT';
const PHOTO = readFileSync('tests/e2e/fixtures/photos/streetlight.jpg');
const M_PER_DEG_LAT = 111_195;

test.describe.configure({ mode: 'serial' });

interface Srv { proc: ChildProcess; dir: string; log: () => string }

async function startServer(extra: Record<string, string>): Promise<Srv> {
  const dir = mkdtempSync(join(tmpdir(), 'civicshot-submit-'));
  let out = '';
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(ALT_PORT), DATA_DIR: dir, SELF_BASE_URL: ALT, ...extra };
  for (const k of ['SUBMISSION_ADAPTER', 'SUBMISSION_LIVE_CONFIRM', 'DEMO_MODE', 'SMTP_URL', 'OPEN311_ENDPOINT']) if (!(k in extra)) delete env[k];
  const proc = spawn(process.execPath, ['src/server/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${ALT}/health`)).ok) return { proc, dir, log: () => out };
    } catch { /* 기동 중 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server did not start:\n${out}`);
}

async function stopServer(s: Srv | undefined): Promise<void> {
  if (!s) return;
  if (s.proc.exitCode === null) {
    const done = new Promise((r) => s.proc.once('exit', r));
    s.proc.kill();
    await done;
  }
  rmSync(s.dir, { recursive: true, force: true });
}

async function upload(r: APIRequestContext, base: string): Promise<string> {
  const res = await r.post(`${base}/api/photos`, { multipart: { file: { name: 's.jpg', mimeType: 'image/jpeg', buffer: PHOTO } } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function locate(r: APIRequestContext, base: string, lat: number, lng: number): Promise<Location> {
  const res = await r.post(`${base}/api/locate`, { data: { lat, lng, facility: 'streetlight' } });
  expect(res.status()).toBe(200);
  return (await res.json()) as Location;
}

function reportBody(photoId: string, location: Location) {
  return {
    photoId, facility: 'streetlight', fault: 'light_out', location,
    form: { title: '가로등 점등 불량 신고', body: '가로등이 밤새 꺼져 있어요. 확인 부탁드려요.', source: 'template' },
    reporterToken: `rt-${Math.random().toString(36).slice(2)}`,
  };
}

async function report(r: APIRequestContext, base: string, lat: number, lng: number) {
  const photoId = await upload(r, base);
  const location = await locate(r, base, lat, lng);
  return r.post(`${base}/api/reports`, { data: reportBody(photoId, location) });
}

// 실행마다 다른 기준점 (중구 안쪽, 이전 실행 이슈와 겹치지 않게). 끝나면 완료 처리해 병합 후보에서 뺀다.
const BASE_LAT = 37.5625 + Math.random() * 0.002;
const BASE_LNG = 126.9950 + Math.random() * 0.004;
const created: string[] = [];

test.describe('기본 서버 (mock 기관)', () => {
  let first: ReportResult;
  let photoForCompletion: string;

  test.afterAll(async ({ request }) => {
    for (const id of created) {
      const done = await request.get(`${API}/api/issues/${id}`);
      if (done.ok() && ((await done.json()) as { status: string }).status !== 'completed') {
        await request.patch(`${API}/api/admin/issues/${id}`, { data: { status: 'completed', completionPhotoId: photoForCompletion } });
      }
    }
  });

  test('신고 → 201, 접수번호·토큰, 모의 기관에 요청 1건, by-token received', async ({ request }) => {
    const before = ((await (await request.get(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[]).length;
    const res = await report(request, API, BASE_LAT, BASE_LNG);
    expect(res.status()).toBe(201);
    expect(res.headers()['cache-control']).toBe('no-store');
    first = (await res.json()) as ReportResult;
    created.push(first.issueId);
    expect(first.receiptNo).toMatch(/^\d{4}-\d{4}-\d{4}$/);
    expect(first.statusToken.length).toBeGreaterThanOrEqual(22);
    expect(first.statusUrl).toMatch(new RegExp(`/s/${first.statusToken}$`));
    expect(first).toMatchObject({ merged: false, reportCount: 1, status: 'received' });
    expect(first.agencyRef).toBeTruthy();
    const list = (await (await request.get(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[];
    expect(list.length).toBe(before + 1);
    expect(list.filter((a) => a.id === first.agencyRef)).toHaveLength(1);
    const o311 = await request.get(`${API}/mock-agency/v2/requests/${first.agencyRef}.json`);
    expect(o311.status()).toBe(200);
    expect(((await o311.json()) as Array<{ service_code: string }>)[0]!.service_code).toBe('streetlight');
    const bt = await request.get(`${API}/api/issues/by-token/${first.statusToken}`);
    expect(bt.status()).toBe(200);
    expect(((await bt.json()) as IssueByToken).status).toBe('received');
    const byId = await request.get(`${API}/api/issues/${first.issueId}`);
    expect(byId.status()).toBe(200);
    const all = (await (await request.get(`${API}/api/issues?status=received&limit=50`)).json()) as Array<{ id: string }>;
    expect(all.some((i) => i.id === first.issueId)).toBe(true);
  });

  test('8 m 떨어진 두 번째 신고 → 병합, 모의 기관 요청은 그대로 1건', async ({ request }) => {
    const before = ((await (await request.get(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[]).length;
    const res = await report(request, API, BASE_LAT + 8 / M_PER_DEG_LAT, BASE_LNG);
    expect(res.status()).toBe(201);
    const second = (await res.json()) as ReportResult;
    expect(second).toMatchObject({ issueId: first.issueId, merged: true, reportCount: 2, receiptNo: first.receiptNo });
    const after = ((await (await request.get(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[]).length;
    expect(after).toBe(before);
  });

  test('25 m 떨어진 신고 → 다른 이슈', async ({ request }) => {
    const res = await report(request, API, BASE_LAT - 25 / M_PER_DEG_LAT, BASE_LNG);
    expect(res.status()).toBe(201);
    const third = (await res.json()) as ReportResult;
    created.push(third.issueId);
    expect(third.issueId).not.toBe(first.issueId);
    expect(third.merged).toBe(false);
  });

  test('모의 기관 PATCH → 웹훅으로 상태 반영, completed 는 사진 필수', async ({ request }) => {
    const by = async () => (await (await request.get(`${API}/api/issues/by-token/${first.statusToken}`)).json()) as IssueByToken;
    const p1 = await request.patch(`${API}/mock-agency/admin/requests/${first.agencyRef}`, { data: { status: 'assigned' } });
    expect(p1.status()).toBe(200);
    await expect.poll(async () => (await by()).status, { timeout: 2000 }).toBe('assigned');

    const noPhoto = await request.patch(`${API}/mock-agency/admin/requests/${first.agencyRef}`, { data: { status: 'completed' } });
    expect(noPhoto.status()).toBe(422);
    expect(((await noPhoto.json()) as { error: string }).error).toBeTruthy();

    photoForCompletion = await upload(request, API);
    const p2 = await request.patch(`${API}/mock-agency/admin/requests/${first.agencyRef}`, { data: { status: 'completed', completionPhotoId: photoForCompletion } });
    expect(p2.status()).toBe(200);
    await expect.poll(async () => (await by()).status, { timeout: 2000 }).toBe('completed');
    const done = await by();
    expect(done.completionPhotoId).toBe(photoForCompletion);
    expect(done.completionPhotoUrl).toContain(`/api/photos/${photoForCompletion}`);
    expect((await request.get(`${API}${done.completionPhotoUrl}`)).status()).toBe(200);
  });

  test('실패 케이스: 사진 없음·본문 누락·응급·모르는 토큰·웹훅 오류', async ({ request }) => {
    const location = await locate(request, API, BASE_LAT, BASE_LNG);
    const noPhoto = await request.post(`${API}/api/reports`, { data: reportBody('no-such-photo', location) });
    expect(noPhoto.status()).toBe(422);
    expect(await noPhoto.json()).toEqual({ error: 'photo_not_found' });

    const missing = await request.post(`${API}/api/reports`, { data: { photoId: 'x' } });
    expect(missing.status()).toBe(422);
    expect(((await missing.json()) as { error: string }).error).toBe('invalid_input');

    const photoId = await upload(request, API);
    const emergency = await request.post(`${API}/api/reports`, { data: { ...reportBody(photoId, location), facility: 'emergency' } });
    expect(emergency.status()).toBe(422);
    expect(((await emergency.json()) as { error: string }).error).toBe('emergency');

    const unknown = await request.get(`${API}/api/issues/by-token/AAAAAAAAAAAAAAAAAAAAAA`);
    expect(unknown.status()).toBe(404);
    expect((await request.get(`${API}/api/issues/nope`)).status()).toBe(404);

    const whUnknown = await request.post(`${API}/api/webhooks/agency`, { data: { agencyRef: 'mock-none', status: 'assigned' } });
    expect(whUnknown.status()).toBe(404);
    const whBad = await request.post(`${API}/api/webhooks/agency`, { data: { agencyRef: first.agencyRef, status: 'exploded' } });
    expect(whBad.status()).toBe(422);
  });
});

test.describe('별도 서버', () => {
  let srv: Srv | undefined;
  let sink: SmtpSink | undefined;
  test.afterEach(async () => {
    await stopServer(srv);
    srv = undefined;
  });
  test.afterAll(async () => {
    await sink?.close();
  });

  test('모의 기관 다운 → 503 submission_failed, 시도 3행', async ({ request }) => {
    srv = await startServer({ SELF_BASE_URL: `http://localhost:${CLOSED_PORT}`, SUBMISSION_RETRY_BASE_MS: '0' });
    const photoId = await upload(request, ALT);
    const location = await locate(request, ALT, 37.5636, 126.9976);
    const res = await request.post(`${ALT}/api/reports`, { data: reportBody(photoId, location) });
    expect(res.status()).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('submission_failed');
    const db = new DatabaseSync(join(srv.dir, 'civicshot.db'));
    const rows = db.prepare('SELECT ok FROM submission_attempts').all() as Array<{ ok: number }>;
    const issues = db.prepare('SELECT status FROM issues').all() as Array<{ status: string }>;
    db.close();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ok === 0)).toBe(true);
    expect(issues).toEqual([{ status: 'received' }]);
  });

  const guards: Array<[string, Record<string, string>, string | undefined]> = [
    ['기본', {}, undefined],
    ['open311 확인 문구 없음', { SUBMISSION_ADAPTER: 'open311' }, 'open311'],
    ['DEMO_MODE=1 + 확인 문구', { DEMO_MODE: '1', SUBMISSION_ADAPTER: 'open311', SUBMISSION_LIVE_CONFIRM: LIVE }, 'open311'],
  ];
  for (const [name, env, refused] of guards) {
    test(`가드: ${name} → adapter mock`, async ({ request }) => {
      srv = await startServer(env);
      const st = (await (await request.get(`${ALT}/api/status`)).json()) as StatusResponse;
      expect(st.adapter).toBe('mock');
      expect(st.live).toBe(false);
      expect(st.refused).toBe(refused);
    });
  }

  test('이메일 어댑터 → 로컬 sink 에 1통, 첨부 1개', async ({ request }) => {
    sink = await startSmtpSink(SINK_PORT);
    const smtpUrl = sink.url;
    expect(new URL(smtpUrl).hostname).toBe('localhost'); // live 문구는 로컬 sink 에만
    const to = 'intake@example.test';
    srv = await startServer({ SUBMISSION_ADAPTER: 'email', SUBMISSION_LIVE_CONFIRM: LIVE, SMTP_URL: smtpUrl, SUBMISSION_EMAIL_TO: to, SUBMISSION_EMAIL_FROM: 'noreply@example.test' });
    const st = (await (await request.get(`${ALT}/api/status`)).json()) as StatusResponse;
    expect(st).toMatchObject({ adapter: 'email', live: true });
    const res = await report(request, ALT, 37.5636, 126.9976);
    expect(res.status()).toBe(201);
    const body = (await res.json()) as ReportResult;
    expect(sink.messages).toHaveLength(1);
    const mail = sink.messages[0]!;
    expect(sink.envelopes[0]!.to).toEqual([to]);
    expect(mail.subject).toContain(body.receiptNo);
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.contentType).toBe('image/jpeg');
    expect(mail.text).toContain('가로등이 밤새 꺼져 있어요');
  });
});
