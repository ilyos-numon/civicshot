// README 데모 녹화: 격리 서버(API 8881, Vite 8883)를 띄우고 Pixel 7 화면으로 신고 흐름을 webm 으로 남긴다.
// 화면 5장은 assets/screenshots/ 에 저장한다. make-demo-gif.sh 가 실행하고 webm 을 GIF 로 바꾼다.
// 사용: node scripts/record-demo.ts <video-dir>
import { chromium, devices, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API_PORT = 8881;
const WEB_PORT = 8883;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const VIDEO_DIR = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-video-')));
const SHOT_DIR = path.resolve('assets/screenshots');
const FIXED_PHOTO = path.resolve('tests/e2e/fixtures/photos/streetlight.jpg');
const PIXEL = devices['Pixel 7'];
const SIZE = PIXEL.viewport;

fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-demo-data-'));

// 키·실제 발송 설정이 섞이지 않도록 관련 변수를 지운 환경
const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of ['VITE_VAPID_PUBLIC_KEY', 'SUBMISSION_ADAPTER', 'SUBMISSION_LIVE_CONFIRM', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CLIENT_DIST_DIR', 'VISION_BACKEND', 'LLM_BACKEND', 'LLM_BASE_URL', 'LLM_API_KEY', 'PUSH_SINK_URL']) delete env[k];

const procs: ChildProcess[] = [];
async function startProc(args: string[], extra: NodeJS.ProcessEnv, ready: string): Promise<void> {
  if (await fetch(ready).then(() => true, () => false)) throw new Error(`port already in use: ${ready}`);
  let out = '';
  const p = spawn(process.execPath, args, { env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stdout?.on('data', (d) => (out += d));
  p.stderr?.on('data', (d) => (out += d));
  procs.push(p);
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(ready)).ok) return;
    } catch {
      /* 기동 중 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`process did not start: ${args.join(' ')}\n${out}`);
}
async function stopAll(): Promise<void> {
  for (const p of procs.reverse()) {
    if (p.exitCode !== null) continue;
    const done = new Promise((r) => p.once('exit', r));
    p.kill('SIGTERM');
    const t = setTimeout(() => p.kill('SIGKILL'), 3000);
    await done;
    clearTimeout(t);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
const pause = (p: Page, ms: number) => p.waitForTimeout(ms);

async function main(): Promise<void> {
  await startProc(
    ['src/server/main.ts'],
    {
      PORT: String(API_PORT), DATA_DIR: dataDir, CLIENT_DIST_DIR: path.join(dataDir, 'no-dist'), DEMO_MODE: '1',
      SELF_BASE_URL: API, PUBLIC_BASE_URL: WEB, VISION_BACKEND: 'fixture', LLM_BACKEND: 'template', GEOCODER: 'offline',
    },
    `${API}/health`,
  );
  await startProc(
    ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(WEB_PORT), '--strictPort'],
    { API_PORT: String(API_PORT), VITE_API_MODE: 'real' },
    `${WEB}/`,
  );

  const browser = await chromium.launch();
  // Vite 첫 변환이 녹화에 들어가지 않도록 미리 한 번 연다.
  {
    const warm = await browser.newContext({ ...PIXEL });
    const w = await warm.newPage();
    await w.goto(`${WEB}/`);
    await w.getByTestId('screen-capture').waitFor();
    await w.goto(`${WEB}/admin`);
    await w.getByTestId('screen-admin').waitFor();
    await warm.close();
  }

  const context = await browser.newContext({ ...PIXEL, baseURL: WEB, recordVideo: { dir: VIDEO_DIR, size: SIZE } });
  // 이 흐름은 지도 타일을 쓰지 않지만, 혹시 그려지더라도 외부로 나가지 않게 막는다.
  await context.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  const page = await context.newPage();
  const t0 = Date.now();
  const log = (s: string) => process.stdout.write(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}\n`);

  // 1) 첫 화면 → 샘플 "가로등"
  await page.goto('/');
  await page.getByTestId('screen-capture').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await pause(page, 2000);
  await shot(page, 'capture');
  log('capture');
  await page.getByTestId('sample-streetlight').click();

  // 2) 자동 확인
  await page.getByTestId('screen-confirm').waitFor({ timeout: 40_000 });
  await page.getByTestId('field-department').filter({ hasNotText: /^$/ }).waitFor();
  await pause(page, 2000);
  await shot(page, 'confirm');
  log('confirm');

  // 3) 양식 미리보기
  await page.getByTestId('btn-next').click();
  await page.getByTestId('screen-preview').waitFor();
  await page.waitForFunction(`(document.querySelector('[data-testid="form-body"]')?.value ?? '') !== ''`, undefined, { timeout: 15_000 });
  await pause(page, 2000);
  log('preview');

  // 4) 신고하기 → 접수증(접수번호·QR)
  await page.getByTestId('btn-submit').click();
  await page.getByTestId('screen-receipt').waitFor({ timeout: 15_000 });
  await page.waitForFunction(`(() => { const i = document.querySelector('[data-testid="qr-image"]'); return !!i && i.complete && i.naturalWidth > 0; })()`);
  await pause(page, 2000);
  await shot(page, 'receipt');
  log('receipt');
  const token = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);

  // 5) 진행 상황 보기
  await page.getByRole('link', { name: '진행 상황 보기' }).click();
  await page.getByTestId('screen-status').waitFor();
  await pause(page, 1200);
  log('status');

  const issue = (await (await fetch(`${API}/api/issues/by-token/${token}`)).json()) as { id: string };
  const current = page.getByTestId('status-steps').locator('[aria-current="step"]');

  // 6) 관리자 화면에서 "배정"
  await page.goto('/admin');
  await page.getByTestId('screen-admin').waitFor();
  const select = page.getByTestId(`admin-status-${issue.id}`);
  const row = page.getByTestId(`admin-row-${issue.id}`);
  await row.waitFor();
  await pause(page, 1000);
  await select.selectOption('assigned');
  await page.waitForFunction(`document.querySelector('[data-testid="admin-row-${issue.id}"]')?.getAttribute('data-status') === 'assigned'`);
  await pause(page, 1000);
  log('admin assigned');

  // 7) 신고자 화면에 "배정"
  await page.goto(`/s/${token}`);
  await current.filter({ hasText: '배정' }).waitFor({ timeout: 10_000 });
  await pause(page, 2000);
  log('status assigned');

  // 8) 관리자: "완료" + 완료 사진
  await page.goto('/admin');
  await row.waitFor();
  await pause(page, 600);
  await select.selectOption('completed');
  await page.getByRole('dialog').waitFor();
  await page.getByTestId('admin-complete-photo').setInputFiles(FIXED_PHOTO);
  await page.waitForFunction(`!document.querySelector('[data-testid="admin-save"]')?.disabled`);
  await pause(page, 1000);
  await page.getByTestId('admin-save').click();
  await page.waitForFunction(`document.querySelector('[data-testid="admin-row-${issue.id}"]')?.getAttribute('data-status') === 'completed'`);
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await pause(page, 800);
  await shot(page, 'admin');
  log('admin completed');

  // 9) 신고자 화면에 "완료" + 완료 사진
  await page.goto(`/s/${token}`);
  await current.filter({ hasText: '완료' }).waitFor({ timeout: 10_000 });
  await page.waitForFunction(`(() => { const i = document.querySelector('[data-testid="completion-photo"]'); return !!i && i.complete && i.naturalWidth > 0; })()`);
  await pause(page, 600);
  await shot(page, 'status');
  await pause(page, 1400);
  log('status completed');

  await context.close(); // 영상 파일을 마무리한다
  await browser.close();
}

try {
  await main();
} finally {
  await stopAll();
}
