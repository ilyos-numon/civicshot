import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import exifr from 'exifr';

// 첫 화면의 샘플 사진 체험 버튼.
const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const SAMPLES = [
  { name: 'streetlight', label: '가로등' },
  { name: 'bench', label: '벤치' },
  { name: 'sidewalk', label: '보도블록' },
] as const;

mkdirSync(SHOT_DIR, { recursive: true });
test.setTimeout(90_000);

test.beforeEach(async ({ context }) => {
  await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
});

test('첫 화면에 샘플 영역이 보이고 금칙어가 없다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  await expect(page.getByText('사진이 없나요? 샘플로 체험해 보기')).toBeVisible();
  const vh = page.viewportSize()!.height;
  for (const s of SAMPLES) {
    const btn = page.getByTestId(`sample-${s.name}`);
    await expect(btn).toHaveText(s.label);
    await expect(btn).toBeInViewport();
    const box = (await btn.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(48);
    expect(box.y + box.height).toBeLessThanOrEqual(vh);
  }
  await expect(page.getByTestId('pick-photo')).toBeAttached();
  const text = await page.evaluate(() => document.body.innerText);
  expect(text.match(/모델|분류기|지오코딩|API|LLM/g) ?? []).toHaveLength(0);
  await page.screenshot({ path: join(SHOT_DIR, 'samples-capture.png') });
});

test('샘플 파일에 위치 정보가 들어 있다', async ({ request }) => {
  for (const s of SAMPLES) {
    const res = await request.get(`/samples/${s.name}.jpg`);
    expect(res.ok()).toBe(true);
    const body = await res.body();
    expect(body.length).toBeLessThanOrEqual(300 * 1024);
    const gps = await exifr.gps(body);
    expect(typeof gps?.latitude).toBe('number');
    expect(typeof gps?.longitude).toBe('number');
  }
});

for (const s of SAMPLES) {
  test(`샘플 ${s.label} → 확인 화면에 시설이 자동으로 채워진다`, async ({ page }) => {
    await page.goto('/');
    await page.getByTestId(`sample-${s.name}`).click();
    await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('field-facility')).toContainText(s.label);
    await expect(page.getByTestId('field-facility')).toContainText('(자동)');
  });
}

// 끝까지 가는 시나리오: 공유 DB 의 다른 이슈와 섞이지 않도록 격리 서버 쌍(API 8974 + Vite 8975)을 쓴다.
test.describe('격리 서버', () => {
  const API_PORT = 8974;
  const WEB_PORT = 8975;
  const API = `http://localhost:${API_PORT}`;
  const WEB = `http://localhost:${WEB_PORT}`;
  interface Proc { proc: ChildProcess; log: () => string }
  let api: Proc | undefined;
  let web: Proc | undefined;
  let dataDir = '';

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
    proc.kill();
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

  test.use({ baseURL: WEB });

  test.beforeAll(async () => {
    test.setTimeout(90_000);
    dataDir = mkdtempSync(join(tmpdir(), 'cs-samples-'));
    const base = { ...process.env };
    delete base.VITE_VAPID_PUBLIC_KEY;
    api = await spawnAndWait(
      ['src/server/main.ts'],
      { ...base, PORT: String(API_PORT), DATA_DIR: dataDir, PUSH_SINK_URL: '', SELF_BASE_URL: API, PUBLIC_BASE_URL: WEB },
      `${API}/health`,
    );
    web = await spawnAndWait(
      ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(WEB_PORT), '--strictPort'],
      { ...base, API_PORT: String(API_PORT), VITE_API_MODE: 'real' },
      `${WEB}/`,
    );
  });

  test.afterAll(async () => {
    await stop(web);
    await stop(api);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  test('샘플 가로등 → 다음 → 신고하기 → 접수번호', async ({ page }: { page: Page }) => {
    await page.goto('/');
    await page.getByTestId('sample-streetlight').click();
    await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('field-facility')).toContainText('가로등');
    await expect(page.getByTestId('field-facility')).toContainText('(자동)');
    await page.getByTestId('btn-next').click();
    await expect(page.getByTestId('screen-preview')).toBeVisible();
    await expect(page.getByTestId('form-title')).not.toHaveValue('', { timeout: 10_000 });
    await page.getByTestId('btn-submit').click();
    await expect(page.getByTestId('screen-receipt')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('receipt-no')).toHaveText(/^\d{4}-\d{4}-\d{4}$/);
  });
});
