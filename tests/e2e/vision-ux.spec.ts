import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeLlm, type FakeLlm } from './helpers/fake-llm.ts';

// 첫 화면의 외부 전송 고지 · 사진 확인 실패 · 요청 많음.
const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const BENCH = 'tests/e2e/fixtures/photos/bench.jpg';
// 샘플 사진은 가짜 LLM 을 거치지 않으므로, 외부 호출 경로를 타는 비샘플(GPS 없음) 사진을 쓴다.
const NOGPS_PHOTO = 'tests/e2e/fixtures/photos/nogps.jpg';
const NOTICE = '사진은 확인을 위해 해외에 있는 외부 서비스로 보내질 수 있어요. 기기 정보와 위치는 함께 보내지 않아요.';
const BANNED = /모델|분류기|지오코딩|API|LLM/g;

const API_PORT = 8987;
const WEB_PORT = 8988;
const FAKE_PORT = 8989;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;

interface Proc { proc: ChildProcess; log: () => string }
let apiProc: Proc | undefined;
let webProc: Proc | undefined;
let fake: FakeLlm | undefined;
let dataDir = '';

mkdirSync(SHOT_DIR, { recursive: true });
test.setTimeout(90_000);
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB });

async function spawnAndWait(args: string[], env: NodeJS.ProcessEnv, ready: string): Promise<Proc> {
  const busy = await fetch(ready).then(() => true, () => false);
  if (busy) throw new Error(`port already in use: ${ready}`);
  let out = '';
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (out += d));
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(ready)).ok) return { proc, log: () => out };
    } catch {
      /* 기동 중 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGKILL');
  throw new Error(`process did not start:\n${out}`);
}

async function stop(p: Proc | undefined): Promise<void> {
  if (!p || p.proc.exitCode !== null) return;
  const done = new Promise((r) => p.proc.once('exit', r));
  p.proc.kill('SIGTERM');
  const t = setTimeout(() => p.proc.kill('SIGKILL'), 3_000);
  await done;
  clearTimeout(t);
}

async function noBannedWords(page: Page) {
  const text = await page.evaluate(() => document.body.innerText);
  expect(text.match(BANNED) ?? []).toHaveLength(0);
}

test.beforeAll(async () => {
  test.setTimeout(90_000);
  fake = await startFakeLlm(FAKE_PORT);
  dataDir = mkdtempSync(join(tmpdir(), 'cs-vision-ux-'));
  const base = { ...process.env };
  delete base.VITE_VAPID_PUBLIC_KEY;
  apiProc = await spawnAndWait(
    ['src/server/main.ts'],
    {
      ...base,
      PORT: String(API_PORT),
      DATA_DIR: dataDir,
      PUSH_SINK_URL: '',
      SELF_BASE_URL: API,
      PUBLIC_BASE_URL: WEB,
      VISION_BACKEND: 'qwen',
      LLM_BASE_URL: fake.url,
      LLM_API_KEY: 'test-key',
      RATE_LIMIT_PER_MINUTE: '0',
      RATE_LIMIT_PER_DAY: '0',
      RATE_LIMIT_DAILY_TOTAL: '0',
    },
    `${API}/health`,
  );
  webProc = await spawnAndWait(
    ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(WEB_PORT), '--strictPort'],
    { ...base, API_PORT: String(API_PORT), VITE_API_MODE: 'real' },
    `${WEB}/`,
  );
});

test.afterAll(async () => {
  await stop(webProc);
  await stop(apiProc);
  await fake?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test.beforeEach(async ({ context }) => {
  fake?.setMode('ok');
  await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
});

test('외부 전송 고지가 고정 문구로 보인다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  const notice = page.getByTestId('external-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText(NOTICE);
  for (const s of ['streetlight', 'bench', 'sidewalk']) await expect(page.getByTestId(`sample-${s}`)).toBeInViewport();
  await noBannedWords(page);
  await page.screenshot({ path: join(SHOT_DIR, 'vision-ux-notice.png') });
});

test('사진이 외부로 나가지 않는 서버면 고지가 없다', async ({ page }) => {
  await page.route('**/api/status', (r) =>
    r.fulfill({ json: { adapter: 'mock', live: false, backends: { vision: 'fixture', llm: 'template', geocoder: 'offline' } } }),
  );
  const seen = page.waitForResponse('**/api/status');
  await page.goto('/');
  await seen;
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByTestId('external-notice')).toHaveCount(0);
  await noBannedWords(page);
});

test('사진 확인 실패 → 다시 해 보면 확인 화면으로 간다', async ({ page }) => {
  fake!.setMode('error');
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(NOGPS_PHOTO);
  const box = page.getByTestId('vision-unavailable');
  await expect(box).toBeVisible({ timeout: 40_000 });
  await expect(box).toContainText('사진을 확인하지 못했어요. 다시 해 볼래요?');
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  await expect(page.getByTestId('screen-emergency')).toHaveCount(0);
  await expect(page.getByText('이 시설은 아직 받지 않아요')).toHaveCount(0);
  await expect(page.getByTestId('sample-bench')).toBeEnabled();
  await noBannedWords(page);
  await page.screenshot({ path: join(SHOT_DIR, 'vision-ux-unavailable.png') });

  fake!.setMode('ok');
  await box.getByRole('button', { name: '다시 해 볼게요' }).click();
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('field-facility')).toContainText('벤치');
  await noBannedWords(page);
});

test('요청이 많으면(분 단위) 몇 초 뒤에 다시 하라고 안내한다', async ({ page }) => {
  await page.route('**/api/classify', (r) =>
    r.fulfill({ status: 429, json: { error: 'rate_limited', scope: 'minute', retryAfterSec: 30 } }),
  );
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(BENCH);
  const box = page.getByTestId('rate-limited');
  await expect(box).toBeVisible({ timeout: 40_000 });
  await expect(box).toContainText('지금은 확인 요청이 많아요. 약 30초 뒤에 다시 해 주세요.');
  await expect(box).toContainText('샘플 사진으로는 계속 체험할 수 있어요.');
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  for (const s of ['streetlight', 'bench', 'sidewalk']) await expect(page.getByTestId(`sample-${s}`)).toBeEnabled();
  await expect(page.getByTestId('pick-photo')).toBeAttached();
  await noBannedWords(page);
  await page.screenshot({ path: join(SHOT_DIR, 'vision-ux-rate-limited.png') });
});

test('하루 한도를 넘으면 내일 다시 하라고 안내한다', async ({ page }) => {
  await page.route('**/api/classify', (r) =>
    r.fulfill({ status: 429, json: { error: 'rate_limited', scope: 'day', retryAfterSec: 40000 } }),
  );
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(BENCH);
  const box = page.getByTestId('rate-limited');
  await expect(box).toBeVisible({ timeout: 40_000 });
  await expect(box).toContainText('오늘은 여기까지 확인할 수 있어요. 내일 다시 해 주세요.');
  await expect(box).toContainText('샘플 사진으로는 계속 체험할 수 있어요.');
  await expect(box).not.toContainText('초 뒤');
  await expect(page.getByTestId('sample-bench')).toBeEnabled();
  await noBannedWords(page);
});
