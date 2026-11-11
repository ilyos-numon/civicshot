import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgencyRequest, Issue, IssueByToken } from '../../src/shared/types.ts';

// 화면–서버 연결 확인용 격리 서버 쌍: API 8984 + Vite(real 모드) 8985.
const API_PORT = 8984;
const WEB_PORT = 8985;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const PHOTOS = 'tests/e2e/fixtures/photos';
const STREETLIGHT = join(PHOTOS, 'streetlight.jpg');
const BENCH = join(PHOTOS, 'bench.jpg');
const NOGPS = join(PHOTOS, 'nogps.jpg');
// 1x1 투명 PNG (지도 타일 대신)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

mkdirSync(SHOT_DIR, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.use({ baseURL: WEB });
// 개발 서버가 처음 화면을 변환하는 데 시간이 걸린다.
test.setTimeout(90_000);
// 상태 화면은 5초마다 다시 읽는다 — 한 주기 + 응답 시간 안에 바뀌어야 한다.
const POLL_WINDOW = 7_000;

interface Proc { proc: ChildProcess; log: () => string }

async function spawnAndWait(args: string[], env: NodeJS.ProcessEnv, ready: string): Promise<Proc> {
  // 이미 누가 쓰고 있으면 다른 서버에 붙지 않도록 바로 실패한다.
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
  p.proc.kill();
  // 열린 연결 때문에 바로 안 끝나면 강제로 끝낸다.
  const t = setTimeout(() => p.proc.kill('SIGKILL'), 3_000);
  await done;
  clearTimeout(t);
}

let api: Proc | undefined;
let web: Proc | undefined;
let dataDir = '';

test.beforeAll(async () => {
  test.setTimeout(90_000);
  dataDir = mkdtempSync(join(tmpdir(), 'cs-wire-'));
  const base = { ...process.env };
  delete base.VITE_VAPID_PUBLIC_KEY;
  api = await spawnAndWait(
    ['src/server/main.ts'],
    {
      ...base,
      PORT: String(API_PORT),
      ALLOW_TEST_ROUTES: '1',
      DATA_DIR: dataDir,
      PUSH_SINK_URL: '',
      SELF_BASE_URL: API,
      PUBLIC_BASE_URL: WEB,
    },
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

test.beforeEach(async ({ context }) => {
  await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
});

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOT_DIR, name), fullPage: true });

async function byToken(token: string): Promise<IssueByToken> {
  const res = await fetch(`${API}/api/issues/by-token/${token}`);
  expect(res.ok).toBe(true);
  return (await res.json()) as IssueByToken;
}

async function patchAgency(agencyRef: string, body: object): Promise<void> {
  const res = await fetch(`${API}/mock-agency/admin/requests/${agencyRef}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

async function uploadPhotoDirect(path: string): Promise<string> {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)], { type: 'image/jpeg' }), 'done.jpg');
  const res = await fetch(`${API}/api/photos`, { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 사진을 올려 미리보기 화면까지 간다. */
async function toPreview(page: Page, photo: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(photo);
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
  await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('screen-preview')).toBeVisible();
  await expect(page.getByTestId('form-title')).not.toHaveValue('', { timeout: 10_000 });
}

async function submitAndToken(page: Page): Promise<string> {
  await page.getByTestId('btn-submit').click();
  await expect(page.getByTestId('screen-receipt')).toBeVisible({ timeout: 15_000 });
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
}

let firstToken = '';

test('사진 → 확인 → 신고 → 접수증(QR) → 상태 화면이 배정으로 바뀐다(폴링)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(STREETLIGHT);
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('field-facility')).toContainText('가로등');
  await expect(page.getByTestId('field-facility')).toContainText('(자동)');
  await expect(page.getByTestId('field-location')).toContainText('중구');
  await expect(page.getByTestId('field-department')).not.toContainText('확인이 필요해요');

  await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('screen-preview')).toBeVisible();
  await expect(page.getByTestId('form-title')).toHaveValue(/가로등/, { timeout: 10_000 });
  await expect(page.getByTestId('form-body')).not.toHaveValue('');

  firstToken = await submitAndToken(page);
  await expect(page.getByTestId('receipt-no')).toHaveText(/^\d{4}-\d{4}-\d{4}$/);
  await expect(page.getByText('처음 신고예요', { exact: false })).toBeVisible();
  const qr = page.getByTestId('qr-image');
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  // 푸시 공개키가 없는 환경: 토글은 꺼진 채 한 줄 안내
  await expect(page.getByRole('switch', { name: /처리되면 알려주세요/ })).toBeDisabled();
  await expect(page.getByTestId('notify-note')).toHaveText('이 기기에서는 알림을 쓸 수 없어요');
  await shot(page, 'wire-receipt.png');

  await page.getByRole('link', { name: '진행 상황 보기' }).click();
  await expect(page.getByTestId('screen-status')).toBeVisible();
  const current = page.getByTestId('status-steps').locator('[aria-current="step"]');
  await expect(current).toContainText('접수');
  await expect(page.getByTestId('report-count')).toContainText('1건');

  const issue = await byToken(firstToken);
  expect(issue.agencyRef).toBeTruthy();
  await patchAgency(issue.agencyRef!, { status: 'assigned' });
  // 새로고침 없이 5초 폴링 안에 바뀐다
  await expect(current).toContainText('배정', { timeout: POLL_WINDOW });
  await shot(page, 'wire-status-assigned.png');
});

test('같은 곳을 다시 신고하면 하나로 묶여 "이미 2명"이 보인다', async ({ page }) => {
  await toPreview(page, STREETLIGHT);
  const token = await submitAndToken(page);
  expect(token).toBe(firstToken);
  await expect(page.getByText('이미 2명이 신고했어요', { exact: false })).toBeVisible();
  expect((await byToken(firstToken)).reportCount).toBe(2);
});

test('완료로 바뀌면 상태 화면에 완료 사진이 보이고 폴링이 멈춘다', async ({ page }) => {
  await page.goto(`/s/${firstToken}`);
  const current = page.getByTestId('status-steps').locator('[aria-current="step"]');
  await expect(current).toContainText('배정');
  const issue = await byToken(firstToken);
  const photoId = await uploadPhotoDirect(BENCH);
  await patchAgency(issue.agencyRef!, { status: 'completed', completionPhotoId: photoId });
  await expect(current).toContainText('완료', { timeout: POLL_WINDOW });
  const img = page.getByTestId('completion-photo');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

  let polls = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/issues/by-token/')) polls++;
  });
  await page.waitForTimeout(6_000);
  expect(polls).toBe(0);
});

test('사진에 위치가 없으면 지도 시트가 열리고 고른 위치로 진행한다', async ({ page }) => {
  // nogps 사진은 시설 판정 결과가 '지원하지 않음'이라, 이 경우만 판정 응답을 가로등으로 바꿔 위치 흐름을 본다.
  await page.route('**/api/classify', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ facility: 'streetlight', fault: 'flicker', confidence: 0.9, candidates: [], source: 'fixture' }),
    }),
  );
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(NOGPS);
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('location-picker')).toBeVisible();
  await expect(page.getByTestId('btn-next')).toBeDisabled();
  await page.getByTestId('btn-pick-location').click();
  await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByTestId('field-location')).not.toContainText('확인이 필요해요');
  await expect(page.getByTestId('field-department')).not.toContainText('확인이 필요해요');
  await expect(page.getByTestId('btn-next')).toBeEnabled();

  // 위치가 있을 때도 "위치 고치기"로 같은 지도를 연다
  await page.getByRole('button', { name: '위치 고치기' }).click();
  await expect(page.getByTestId('location-picker')).toBeVisible();
});

test('알아보지 못한 사진은 범위 밖 안내를 보여 준다', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(NOGPS);
  await expect(page.getByTestId('screen-emergency')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText('이 시설은 아직 받지 않아요')).toBeVisible();
});

test('없는 접수번호는 찾을 수 없다고 알려 준다', async ({ page }) => {
  await page.goto('/s/zzz');
  await expect(page.getByText('찾을 수 없는 접수번호예요')).toBeVisible();
});

let benchToken = '';

test('오프라인에서 신고하면 대기열에 담았다가 연결되면 자동으로 보낸다', async ({ page, context }) => {
  const before = (await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[];
  await toPreview(page, BENCH);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await page.getByTestId('btn-submit').click();
  await expect(page.getByTestId('queued-notice')).toContainText('연결되면 자동으로 보낼게요');
  await page.waitForTimeout(500);
  expect(((await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[]).length).toBe(before.length);

  await context.setOffline(false);
  await expect
    .poll(async () => ((await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[]).length, { timeout: 15_000 })
    .toBe(before.length + 1);
  const list = (await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[];
  const added = list.find((r) => !before.some((b) => b.id === r.id))!;
  expect(added.serviceCode).toBe('bench');
  // 신고에 붙은 사진이 서버에 실제로 있다
  const photoPath = new URL(added.mediaUrl!).pathname;
  expect(photoPath).toMatch(/^\/api\/photos\/.+/);
  expect((await fetch(`${API}${photoPath}`)).status).toBe(200);
  const issues = (await (await fetch(`${API}/api/issues`)).json()) as Issue[];
  benchToken = issues.find((i) => i.agencyRef === added.id)!.statusToken;
});

test('관리자: 상태를 배정으로 바꾸면 신고자 화면에 반영되고, 완료는 사진 없이 저장할 수 없다', async ({ page, browser }) => {
  expect(benchToken).not.toBe('');
  await page.goto('/admin');
  await expect(page.getByTestId('screen-admin')).toBeVisible();
  await expect(page.getByTestId('admin-seed')).toHaveCount(0);
  const issue = await byToken(benchToken);
  const row = page.getByTestId(`admin-row-${issue.id}`);
  await expect(row).toHaveAttribute('data-status', 'received');
  const select = page.getByTestId(`admin-status-${issue.id}`);
  await select.selectOption('assigned');
  await expect(row).toHaveAttribute('data-status', 'assigned');
  await expect(page.getByRole('status').filter({ hasText: `접수번호 ${issue.receiptNo} 신고를 '배정'으로 바꿨어요` })).toBeVisible();

  const citizen = await browser.newPage({ baseURL: WEB });
  await citizen.goto(`/s/${benchToken}`);
  await expect(citizen.getByTestId('status-steps').locator('[aria-current="step"]')).toContainText('배정');
  await citizen.close();

  await select.selectOption('completed');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('admin-save')).toBeDisabled();
  await page.getByRole('button', { name: '취소' }).click();
  await expect(select).toHaveValue('assigned');
  await page.waitForTimeout(1800);
  await shot(page, 'wire-admin.png');
});
