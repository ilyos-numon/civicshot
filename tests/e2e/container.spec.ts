import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Location, ReportResult } from '../../src/shared/types.ts';
import { cleanEnv, startApi, stop, type Proc } from './helpers/flow.ts';

// 컨테이너·배포본 확인. E2E_BASE_URL 이 있으면 그 주소를, 없으면 로컬 dist 로 띄운 서버(PORT 8984)를 본다.
const REMOTE = process.env.E2E_BASE_URL;
const LOCAL_PORT = 8984;
const BASE = REMOTE ?? `http://localhost:${LOCAL_PORT}`;
const DIST = 'dist/client';
// 샘플 사진의 촬영 위치와 떨어진 좌표: 같은 대상에서 full-flow 가 "처음 신고" 를 기대하므로 묶이지 않게 한다.
const LAT = 37.4979 + Math.random() * 0.002;
const LNG = 127.0276 + Math.random() * 0.002;

test.describe.configure({ mode: 'serial' });

let server: Proc | undefined;
let dataDir: string | undefined;

test.beforeAll(async () => {
  if (REMOTE) return;
  test.setTimeout(240_000);
  if (!existsSync(join(DIST, 'index.html'))) execSync('npm run build', { stdio: 'inherit' });
  dataDir = mkdtempSync(join(tmpdir(), 'civicshot-container-'));
  server = await startApi({ ...cleanEnv(), DEMO_MODE: '1', CLIENT_DIST_DIR: DIST, DATA_DIR: dataDir }, LOCAL_PORT);
});

test.afterAll(async () => {
  await stop(server);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test('/health 와 /api/status 는 mock 어댑터', async ({ request }) => {
  const h = await request.get(`${BASE}/health`);
  expect(h.status()).toBe(200);
  expect(await h.json()).toEqual({ ok: true, adapter: 'mock' });
  const s = await (await request.get(`${BASE}/api/status`)).json();
  expect(s.adapter).toBe('mock');
  expect(s.live).toBe(false);
});

test('첫 화면이 렌더된다', async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page).toHaveTitle('찍고끝');
  await expect(page.locator('#root')).not.toBeEmpty();
});

test('SPA 폴백·API 404·정적 파일', async ({ request }) => {
  const spa = await request.get(`${BASE}/receipt/x`);
  expect(spa.status()).toBe(200);
  expect(spa.headers()['content-type']).toContain('text/html');
  const nope = await request.get(`${BASE}/api/nope`);
  expect(nope.status()).toBe(404);
  expect(nope.headers()['content-type']).toContain('application/json');
  expect(await nope.json()).toHaveProperty('error');
  for (const p of ['/manifest.webmanifest', '/samples/streetlight.jpg']) {
    expect((await request.get(`${BASE}${p}`)).status(), p).toBe(200);
  }
  const sw = await request.get(`${BASE}/sw.js`);
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toBe('no-cache');
});

test('샘플 사진으로 신고 1건', async ({ request }) => {
  const img = await request.get(`${BASE}/samples/streetlight.jpg`);
  expect(img.status()).toBe(200);
  const up = await request.post(`${BASE}/api/photos`, {
    multipart: {
      file: { name: 'p.jpg', mimeType: 'image/jpeg', buffer: await img.body() },
      lat: String(LAT),
      lng: String(LNG),
    },
  });
  expect(up.status()).toBe(201);
  const photoId = ((await up.json()) as { id: string }).id;

  const status = (await (await request.get(`${BASE}/api/status`)).json()) as { backends: { vision: string } };
  // qwen 모드에서는 classify 를 건너뛴다: 실제 모델 호출·요청 한도 소비를 피함.
  if (status.backends.vision !== 'qwen') {
    const cls = await request.post(`${BASE}/api/classify`, { data: { photoId } });
    expect(cls.status()).toBe(200);
  }

  const loc = await request.post(`${BASE}/api/locate`, { data: { lat: LAT, lng: LNG, facility: 'streetlight' } });
  expect(loc.status()).toBe(200);
  const location = (await loc.json()) as Location;

  const form = await request.post(`${BASE}/api/form`, {
    data: { photoId, facility: 'streetlight', fault: 'light_out', addressLabel: location.addressLabel, department: location.department },
  });
  expect(form.status()).toBe(200);

  const rep = await request.post(`${BASE}/api/reports`, {
    data: {
      photoId,
      facility: 'streetlight',
      fault: 'light_out',
      location,
      form: await form.json(),
      reporterToken: `rt-${Math.random().toString(36).slice(2)}`,
    },
  });
  expect(rep.status()).toBe(201);
  const r = (await rep.json()) as ReportResult;
  expect(r.receiptNo.length).toBeGreaterThan(0);
  expect(r.statusToken.length).toBeGreaterThan(0);
});
