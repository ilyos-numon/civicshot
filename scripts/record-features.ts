// README 기능별 장면 녹화. 사용법: node scripts/record-features.ts <scene> <outDir>
// 장면마다 새 임시 DATA_DIR 로 서버를 띄우고, <outDir>/<scene>.json 에 영상 목록·앞부분 자를 길이·건너뛸 구간을 적는다.
import { chromium, devices, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeLlm, type FakeLlm } from '../tests/e2e/helpers/fake-llm.ts';

const SCENE = process.argv[2] ?? '';
const OUT = path.resolve(process.argv[3] ?? 'test-results/feature-gifs');
const SHOT_DIR = path.resolve('assets/screenshots');
const PHOTO = (n: string) => path.resolve(`tests/e2e/fixtures/photos/${n}.jpg`);
const PIXEL = devices['Pixel 7'];
const MOBILE = PIXEL.viewport;
const ADMIN_HALF = { width: 560, height: MOBILE.height };

const GROUP_F = { api: 8891, web: 8892 };
const GROUP_Q = { api: 8894, web: 8895, fake: 8896 };
const Q_SCENES = new Set(['location-picker', 'emergency', 'check-and-limit']);
const ALL = ['sample-to-receipt', 'admin-to-citizen', 'merge-duplicates', 'offline-queue', 'qr-status', 'location-picker', 'emergency', 'check-and-limit'];
if (!ALL.includes(SCENE)) throw new Error(`unknown scene: ${SCENE} (one of ${ALL.join(', ')})`);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feature-data-'));

const env: NodeJS.ProcessEnv = { ...process.env };
for (const k of ['VITE_VAPID_PUBLIC_KEY', 'SUBMISSION_ADAPTER', 'SUBMISSION_LIVE_CONFIRM', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CLIENT_DIST_DIR', 'VISION_BACKEND', 'VISION_MODEL', 'LLM_BACKEND', 'LLM_BASE_URL', 'LLM_API_KEY', 'PUSH_SINK_URL', 'GEOCODER', 'RATE_LIMIT_PER_MINUTE', 'RATE_LIMIT_PER_DAY', 'RATE_LIMIT_DAILY_TOTAL']) delete env[k];

const procs: ChildProcess[] = [];
let fake: FakeLlm | null = null;
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
  await fake?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const q = Q_SCENES.has(SCENE);
const API = `http://localhost:${q ? GROUP_Q.api : GROUP_F.api}`;
const WEB = `http://localhost:${q ? GROUP_Q.web : GROUP_F.web}`;

async function startServers(): Promise<void> {
  const common = { DATA_DIR: dataDir, CLIENT_DIST_DIR: path.join(dataDir, 'no-dist'), DEMO_MODE: '1', SELF_BASE_URL: API, PUBLIC_BASE_URL: WEB, LLM_BACKEND: 'template', GEOCODER: 'offline', PUSH_SINK_URL: '' };
  if (q) {
    fake = await startFakeLlm(GROUP_Q.fake);
    await startProc(['src/server/main.ts'], {
      ...common, PORT: String(GROUP_Q.api), VISION_BACKEND: 'qwen', LLM_BASE_URL: fake.url, LLM_API_KEY: 'demo-not-a-key', VISION_TIMEOUT_MS: '5000',
      RATE_LIMIT_PER_MINUTE: SCENE === 'check-and-limit' ? '2' : '0', RATE_LIMIT_PER_DAY: '0', RATE_LIMIT_DAILY_TOTAL: '0',
    }, `${API}/health`);
  } else {
    await startProc(['src/server/main.ts'], { ...common, PORT: String(GROUP_F.api), VISION_BACKEND: 'fixture' }, `${API}/health`);
  }
  await startProc(
    ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(q ? GROUP_Q.web : GROUP_F.web), '--strictPort'],
    { API_PORT: String(q ? GROUP_Q.api : GROUP_F.api), VITE_API_MODE: 'real' },
    `${WEB}/`,
  );
}

// ---- 녹화 도우미 -------------------------------------------------------
interface Rec { name: string; ctx: BrowserContext; page: Page; origin: number }
const recs: Rec[] = [];
let t0 = 0;
const cuts: [number, number][] = [];
const now = () => (Date.now() - t0) / 1000;

async function blockTiles(ctx: BrowserContext): Promise<void> {
  // 위치 보정 장면 밖에서는 지도 타일 요청을 보내지 않는다.
  if (SCENE !== 'location-picker') await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
}

async function newRec(browser: Browser, name: string, opts: { mobile: boolean; label?: string }): Promise<Rec> {
  const size = opts.mobile ? MOBILE : ADMIN_HALF;
  const ctx = await browser.newContext({
    ...(opts.mobile ? PIXEL : { viewport: size, deviceScaleFactor: 1 }),
    baseURL: WEB,
    recordVideo: { dir: path.join(OUT, `${SCENE}-raw`), size },
  });
  await blockTiles(ctx);
  if (opts.label) {
    const label = opts.label;
    await ctx.addInitScript((text: string) => {
      const add = () => {
        if (document.getElementById('feat-caption')) return;
        const el = document.createElement('div');
        el.id = 'feat-caption';
        el.textContent = text;
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;background:#111827;color:#fff;font:600 20px/1 system-ui,sans-serif;text-align:center;padding:12px 0;letter-spacing:.02em';
        document.body.appendChild(el);
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
      else add();
    }, label);
  }
  const page = await ctx.newPage();
  const rec = { name, ctx, page, origin: Date.now() };
  recs.push(rec);
  return rec;
}

const pause = (p: Page, ms: number) => p.waitForTimeout(ms);
const shot = (p: Page, name: string) => p.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
async function settle(p: Page): Promise<void> {
  await p.evaluate(() => document.fonts.ready);
}
async function waitQr(p: Page): Promise<void> {
  await p.waitForFunction(`(() => { const i = document.querySelector('[data-testid="qr-image"]'); return !!i && i.complete && i.naturalWidth > 0; })()`);
}
const tokenOf = (p: Page) => decodeURIComponent(new URL(p.url()).pathname.split('/').pop()!);

/** 첫 화면에서 샘플을 눌러 미리보기 화면까지 간다. */
async function toPreview(p: Page, waits = 1000): Promise<void> {
  await p.getByTestId('sample-streetlight').click();
  await p.getByTestId('screen-confirm').waitFor({ timeout: 40_000 });
  await p.getByTestId('field-department').filter({ hasNotText: /^$/ }).waitFor();
  await pause(p, waits);
  await p.getByTestId('btn-next').click();
  await p.getByTestId('screen-preview').waitFor();
  await p.waitForFunction(`(document.querySelector('[data-testid="form-body"]')?.value ?? '') !== ''`, undefined, { timeout: 15_000 });
  await pause(p, waits);
}

/** 녹화 없는 컨텍스트로 화면을 한 번 열어 Vite 첫 변환을 끝내 둔다. */
async function warm(browser: Browser): Promise<void> {
  const ctx = await browser.newContext({ ...PIXEL, baseURL: WEB });
  await blockTiles(ctx);
  const w = await ctx.newPage();
  await w.goto('/');
  await w.getByTestId('screen-capture').waitFor();
  await w.goto('/admin');
  await w.getByTestId('screen-admin').waitFor();
  await ctx.close();
}

/** 시민이 샘플로 한 번 신고해 둔다(녹화 없음). 접수 토큰을 돌려준다. */
async function seedReport(browser: Browser): Promise<string> {
  const ctx = await browser.newContext({ ...PIXEL, baseURL: WEB });
  await blockTiles(ctx);
  const p = await ctx.newPage();
  await p.goto('/');
  await p.getByTestId('screen-capture').waitFor();
  await toPreview(p, 0);
  await p.getByTestId('btn-submit').click();
  await p.getByTestId('screen-receipt').waitFor({ timeout: 15_000 });
  const token = tokenOf(p);
  await ctx.close();
  return token;
}

/** 장면 도중 주소를 옮긴다. 빈 화면 구간은 영상에서 잘라 낸다. */
async function jump(p: Page, url: string, ready: () => Promise<unknown>): Promise<void> {
  const a = now();
  await p.goto(url);
  await ready();
  await settle(p);
  cuts.push([a, now() + 0.15]);
}

async function openCapture(p: Page): Promise<void> {
  await p.goto('/');
  await p.getByTestId('screen-capture').waitFor();
  await settle(p);
}

// ---- 장면 -------------------------------------------------------------
async function sampleToReceipt(browser: Browser): Promise<void> {
  const { page } = await newRec(browser, 'main', { mobile: true });
  await openCapture(page);
  t0 = Date.now();
  await pause(page, 1300);
  await shot(page, 'feat-sample-1-capture');
  await page.getByTestId('sample-streetlight').hover();
  await pause(page, 400);
  await page.getByTestId('sample-streetlight').click();
  await page.getByTestId('screen-confirm').waitFor({ timeout: 40_000 });
  await page.getByTestId('field-department').filter({ hasNotText: /^$/ }).waitFor();
  await pause(page, 1500);
  await shot(page, 'feat-sample-2-confirm');
  await page.getByTestId('btn-next').click();
  await page.getByTestId('screen-preview').waitFor();
  await page.waitForFunction(`(document.querySelector('[data-testid="form-body"]')?.value ?? '') !== ''`, undefined, { timeout: 15_000 });
  await pause(page, 1500);
  await shot(page, 'feat-sample-3-preview');
  await page.getByTestId('btn-submit').click();
  await page.getByTestId('screen-receipt').waitFor({ timeout: 15_000 });
  await waitQr(page);
  await pause(page, 1500);
  await shot(page, 'feat-sample-4-receipt');
  await page.getByTestId('qr-image').scrollIntoViewIfNeeded();
  await pause(page, 1000);
}

async function adminToCitizen(browser: Browser): Promise<void> {
  const token = await seedReport(browser);
  const issue = (await (await fetch(`${API}/api/issues/by-token/${token}`)).json()) as { id: string };
  const admin = await newRec(browser, 'left', { mobile: false, label: '담당자 화면' });
  const citizen = await newRec(browser, 'right', { mobile: true, label: '신고자 화면' });
  await admin.page.goto('/admin');
  await citizen.page.goto(`/s/${token}`);
  const row = admin.page.getByTestId(`admin-row-${issue.id}`);
  const select = admin.page.getByTestId(`admin-status-${issue.id}`);
  const current = citizen.page.getByTestId('status-steps').locator('[aria-current="step"]');
  await row.waitFor();
  await current.filter({ hasText: '접수' }).waitFor();
  await settle(admin.page);
  await settle(citizen.page);
  t0 = Date.now();
  await pause(admin.page, 1300);

  const step = async (value: string, ko: string, shotName?: string) => {
    await select.selectOption(value);
    await admin.page.waitForFunction(`document.querySelector('[data-testid="admin-row-${issue.id}"]')?.getAttribute('data-status') === '${value}'`);
    await pause(admin.page, 900);
    const a = now();
    await current.filter({ hasText: ko }).waitFor({ timeout: 10_000 });
    const b = now();
    if (b - a > 1.2) cuts.push([a + 0.4, b - 0.4]);
    await pause(citizen.page, 1300);
    if (shotName) await citizen.page.screenshot({ path: path.join(SHOT_DIR, `${shotName}.png`), style: '#feat-caption{display:none}' });
  };
  await step('assigned', '배정', 'feat-status-assigned');
  await step('in_progress', '처리중');

  await select.selectOption('completed');
  await admin.page.getByRole('dialog').waitFor();
  await pause(admin.page, 700);
  await admin.page.getByTestId('admin-complete-photo').setInputFiles(PHOTO('bench'));
  await admin.page.waitForFunction(`!document.querySelector('[data-testid="admin-save"]')?.disabled`);
  await pause(admin.page, 900);
  await admin.page.getByTestId('admin-save').click();
  await admin.page.waitForFunction(`document.querySelector('[data-testid="admin-row-${issue.id}"]')?.getAttribute('data-status') === 'completed'`);
  await admin.page.getByRole('dialog').waitFor({ state: 'detached' });
  await pause(admin.page, 700);
  const a = now();
  await current.filter({ hasText: '완료' }).waitFor({ timeout: 10_000 });
  await citizen.page.waitForFunction(`(() => { const i = document.querySelector('[data-testid="completion-photo"]'); return !!i && i.complete && i.naturalWidth > 0; })()`);
  const b = now();
  if (b - a > 1.2) cuts.push([a + 0.4, b - 0.4]);
  await citizen.page.getByTestId('completion-photo').scrollIntoViewIfNeeded();
  await pause(citizen.page, 1500);
  await citizen.page.screenshot({ path: path.join(SHOT_DIR, 'feat-status-completed.png'), style: '#feat-caption{display:none}' });

  // 현황판 스크린샷(데스크톱 1280, 녹화와 별개)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: WEB });
  await blockTiles(ctx);
  const p = await ctx.newPage();
  await p.goto('/admin');
  await p.getByTestId(`admin-row-${issue.id}`).waitFor();
  await settle(p);
  await pause(p, 500);
  await shot(p, 'feat-admin-board');
  await ctx.close();
}

async function mergeDuplicates(browser: Browser): Promise<void> {
  const token = await seedReport(browser);
  const issue = (await (await fetch(`${API}/api/issues/by-token/${token}`)).json()) as { id: string };
  const { page } = await newRec(browser, 'main', { mobile: true });
  await openCapture(page);
  t0 = Date.now();
  await pause(page, 1000);
  await toPreview(page, 1000);
  await page.getByTestId('btn-submit').click();
  await page.getByTestId('screen-receipt').waitFor({ timeout: 15_000 });
  await waitQr(page);
  const count = page.getByText(/이미 \d+명이 신고했어요/);
  await count.waitFor();
  await count.scrollIntoViewIfNeeded();
  await count.evaluate((el) => { (el as HTMLElement).style.outline = '3px solid #f59e0b'; (el as HTMLElement).style.outlineOffset = '4px'; });
  await pause(page, 1800);
  await shot(page, 'feat-merge-count');
  const row = page.getByTestId(`admin-row-${issue.id}`);
  await jump(page, '/admin', () => row.waitFor());
  await row.scrollIntoViewIfNeeded();
  await row.locator('.ad-count').evaluate((el) => { (el as HTMLElement).style.outline = '3px solid #f59e0b'; (el as HTMLElement).style.outlineOffset = '3px'; });
  await pause(page, 2000);
}

async function offlineQueue(browser: Browser): Promise<void> {
  const rec = await newRec(browser, 'main', { mobile: true });
  const { page, ctx } = rec;
  await openCapture(page);
  t0 = Date.now();
  await pause(page, 900);
  await toPreview(page, 900);
  await ctx.setOffline(true);
  await page.getByTestId('offline-banner').waitFor();
  await pause(page, 1300);
  await page.getByTestId('btn-submit').click();
  const notice = page.getByTestId('queued-notice');
  await notice.waitFor();
  await notice.scrollIntoViewIfNeeded();
  await pause(page, 1500);
  await shot(page, 'feat-offline-queued');
  const before = ((await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as unknown[]).length;
  await ctx.setOffline(false);
  for (let i = 0; i < 150; i++) {
    if (((await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as unknown[]).length > before) break;
    await pause(page, 100);
  }
  await pause(page, 800);
  const row = page.locator('[data-testid^="admin-row-"]').first();
  await jump(page, '/admin', () => row.waitFor());
  await row.evaluate((el) => { (el as HTMLElement).style.outline = '3px solid #f59e0b'; });
  await pause(page, 2000);
}

async function qrStatus(browser: Browser): Promise<void> {
  const rec = await newRec(browser, 'main', { mobile: true });
  const { page } = rec;
  await openCapture(page);
  await toPreview(page, 0);
  await page.getByTestId('btn-submit').click();
  await page.getByTestId('screen-receipt').waitFor({ timeout: 15_000 });
  await waitQr(page);
  await settle(page);
  t0 = Date.now();
  await pause(page, 1200);
  const qr = page.getByTestId('qr-image');
  await qr.scrollIntoViewIfNeeded();
  await qr.evaluate((el) => {
    const s = (el as HTMLElement).style;
    s.transition = 'transform .5s ease, box-shadow .5s ease';
    s.transform = 'scale(1.25)';
    s.boxShadow = '0 0 0 6px #f59e0b';
  });
  await pause(page, 1500);
  const token = tokenOf(page);
  await jump(page, `/s/${token}`, () => page.getByTestId('status-steps').locator('[aria-current="step"]').filter({ hasText: '접수' }).waitFor());
  await pause(page, 2800);
}

async function locationPicker(browser: Browser): Promise<void> {
  fake!.setMode('ok');
  const { page } = await newRec(browser, 'main', { mobile: true });
  await openCapture(page);
  t0 = Date.now();
  await pause(page, 1000);
  await page.getByTestId('pick-photo').setInputFiles(PHOTO('nogps'));
  await page.getByTestId('screen-confirm').waitFor({ timeout: 40_000 });
  await page.getByTestId('field-facility').filter({ hasText: '벤치' }).waitFor();
  // 자동으로 열린 지도 시트를 닫아 위치 칸이 비어 있는 것을 먼저 보여 준다.
  if (await page.getByRole('dialog').isVisible()) {
    await pause(page, 600);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await page.getByTestId('field-location').scrollIntoViewIfNeeded();
  await pause(page, 1500);
  await page.getByTestId('field-location').getByRole('button').click();
  const picker = page.getByTestId('location-picker');
  await picker.waitFor();
  const map = page.getByTestId('location-map');
  await map.locator('.leaflet-tile-loaded').first().waitFor({ timeout: 20_000 });
  await pause(page, 1300);
  const m = (await map.boundingBox())!;
  const cx = m.x + m.width / 2;
  const cy = m.y + m.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 70, cy - 50, { steps: 14 });
  await page.mouse.up();
  await pause(page, 1200);
  await shot(page, 'feat-location-picker');
  await page.getByTestId('btn-pick-location').click();
  await page.getByRole('dialog').waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByTestId('field-location').filter({ hasNotText: '확인이 필요해요' }).waitFor();
  await page.getByTestId('field-location').scrollIntoViewIfNeeded();
  await pause(page, 2000);
}

async function emergency(browser: Browser): Promise<void> {
  fake!.setMode('emergency');
  const { page } = await newRec(browser, 'main', { mobile: true });
  await openCapture(page);
  t0 = Date.now();
  await pause(page, 1600);
  await page.getByTestId('pick-photo').setInputFiles(PHOTO('nogps'));
  await page.getByTestId('screen-emergency').waitFor({ timeout: 40_000 });
  await settle(page);
  await pause(page, 1500);
  await shot(page, 'feat-emergency');
  await pause(page, 2500);
}

async function checkAndLimit(browser: Browser): Promise<void> {
  fake!.setMode('error');
  const { page } = await newRec(browser, 'main', { mobile: true });
  await openCapture(page);
  await page.getByTestId('external-notice').waitFor();
  await shot(page, 'feat-external-notice');
  t0 = Date.now();
  await pause(page, 1200);
  await page.getByTestId('pick-photo').setInputFiles(PHOTO('nogps'));
  const box = page.getByTestId('vision-unavailable');
  await box.waitFor({ timeout: 40_000 });
  await box.scrollIntoViewIfNeeded();
  await pause(page, 1500);
  await shot(page, 'feat-vision-unavailable');
  fake!.setMode('ok');
  await box.getByRole('button', { name: '다시 해 볼게요' }).click();
  await page.getByTestId('screen-confirm').waitFor({ timeout: 40_000 });
  await page.getByRole('dialog').waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await page.getByRole('dialog').isVisible()) await page.keyboard.press('Escape');
  await pause(page, 1400);
  // 분당 한도(2회)를 이미 썼다: 다른 사진을 또 올리면 잠시 뒤에 하라는 안내가 나온다.
  await page.getByRole('button', { name: '다시 찍기' }).click();
  await page.getByTestId('screen-capture').waitFor();
  await pause(page, 700);
  await page.getByTestId('pick-photo').setInputFiles(PHOTO('nogps'));
  const limited = page.getByTestId('rate-limited');
  await limited.waitFor({ timeout: 40_000 });
  await limited.scrollIntoViewIfNeeded();
  await pause(page, 1500);
  await shot(page, 'feat-rate-limited');
  await pause(page, 1000);
}

const SCENES: Record<string, (b: Browser) => Promise<void>> = {
  'sample-to-receipt': sampleToReceipt,
  'admin-to-citizen': adminToCitizen,
  'merge-duplicates': mergeDuplicates,
  'offline-queue': offlineQueue,
  'qr-status': qrStatus,
  'location-picker': locationPicker,
  emergency,
  'check-and-limit': checkAndLimit,
};

async function main(): Promise<void> {
  await startServers();
  const browser = await chromium.launch();
  try {
    await warm(browser);
    await SCENES[SCENE](browser);
    const end = now();
    const inputs: { file: string; lead: number }[] = [];
    for (const r of recs) {
      const video = r.page.video();
      await r.ctx.close(); // 영상 파일을 마무리한다
      const src = await video!.path();
      const file = path.join(OUT, `${SCENE}-${r.name}.webm`);
      fs.renameSync(src, file);
      inputs.push({ file, lead: Math.max(0, (t0 - r.origin) / 1000) });
    }
    fs.rmSync(path.join(OUT, `${SCENE}-raw`), { recursive: true, force: true });
    fs.writeFileSync(path.join(OUT, `${SCENE}.json`), JSON.stringify({ inputs, duration: end, cuts }));
    process.stdout.write(`${SCENE}: body ${end.toFixed(1)}s, cuts ${JSON.stringify(cuts)}\n`);
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  await stopAll();
}
