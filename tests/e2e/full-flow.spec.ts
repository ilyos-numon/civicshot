import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { AgencyRequest, StatusResponse } from '../../src/shared/types.ts';
import { startFakeLlm, type FakeLlm } from './helpers/fake-llm.ts';
import {
  BENCH, POLL_WINDOW, PNG, SHOT_DIR, STREETLIGHT, byToken, cleanEnv, expectImageLoaded, expectNoBannedWords,
  reportAt, shot, spawnAndWait, startApi, startVite, stop, uploadPhoto, type Proc,
} from './helpers/flow.ts';

// 전체 흐름: 사진 → 분류 → 관할 → 양식 → 제출 → 모의 기관 → 관리자 → 신고자 화면 → QR → 푸시.
// E2E_BASE_URL 이 있으면(배포된 데모/컨테이너) 서버를 띄우지 않고 성공 경로 1개만 그 주소에 대해 돈다.
// 그 환경에서는 `_test` 라우트·푸시 sink·응급 시나리오(가짜 LLM 서버 필요)·관리자 직접 호출을 쓸 수 없어 건너뛴다.
const REMOTE = process.env.E2E_BASE_URL;

const API_PORT = 8994;
const WEB_PORT = 8995;
const SINK_PORT = 8993;
const EM_API_PORT = 8996;
const EM_WEB_PORT = 8997;
const FAKE_PORT = 8998;
const API = `http://localhost:${API_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const SINK = `http://localhost:${SINK_PORT}`;
const EM_API = `http://localhost:${EM_API_PORT}`;
const EM_WEB = `http://localhost:${EM_WEB_PORT}`;

mkdirSync(SHOT_DIR, { recursive: true });
// 샘플 사진은 가짜 LLM 을 거치지 않으므로, 외부 호출 경로를 타는 비샘플(GPS 없음) 사진을 쓴다.
const NOGPS_PHOTO = 'tests/e2e/fixtures/photos/nogps.jpg';

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: REMOTE ?? WEB });
test.setTimeout(120_000);

test.beforeEach(async ({ context }) => {
  await context.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
});

/** 사진 업로드부터 접수증까지. 스크린샷은 shots 가 true 일 때만. */
async function reportViaUi(page: Page, shots: boolean): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  if (shots) await shot(page, 'capture.png');
  await page.getByTestId('pick-photo').setInputFiles(STREETLIGHT);
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 40_000 });
  await expect(page.getByTestId('field-facility')).toContainText('가로등');
  await expect(page.getByTestId('field-fault')).toContainText('점등 불량');
  await expect(page.getByTestId('field-facility')).toContainText('(자동)');
  await expect(page.getByTestId('field-location')).toContainText('중구');
  await expect(page.getByTestId('field-department')).not.toContainText('확인이 필요해요');
  await expect(page.getByTestId('field-department')).not.toHaveText('');
  await expectNoBannedWords(page);
  if (shots) await shot(page, 'confirm.png');

  await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('screen-preview')).toBeVisible();
  // 배포 대상은 실제 모델이 양식을 만들어 응답이 느리다(서버 제한 20초 + 여유).
  await expect(page.getByTestId('form-title')).toHaveValue(/가로등/, {
    timeout: process.env.E2E_BASE_URL ? 35_000 : 10_000,
  });
  await expect(page.getByTestId('form-body')).not.toHaveValue('');
  await expect(page.getByTestId('form-title')).toBeEditable();
  await expect(page.getByTestId('form-body')).toBeEditable();
  await expectNoBannedWords(page);
  if (shots) await shot(page, 'preview.png');

  await page.getByTestId('btn-submit').click();
  await expect(page.getByTestId('screen-receipt')).toBeVisible({ timeout: 15_000 });
  const token = decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  await expect(page.getByTestId('receipt-no')).toHaveText(/^\d{4}-\d{4}-\d{4}$/);
  await expectImageLoaded(page, 'qr-image');
  await expect(page.getByText('처음 신고예요', { exact: false })).toBeVisible();
  await expectNoBannedWords(page);
  if (shots) await shot(page, 'receipt.png');

  await page.getByRole('link', { name: '진행 상황 보기' }).click();
  await expect(page.getByTestId('screen-status')).toBeVisible();
  await expect(page.getByTestId('status-steps').locator('[aria-current="step"]')).toContainText('접수');
  await expectNoBannedWords(page);
  if (shots) await shot(page, 'status.png');
  return token;
}

if (REMOTE) {
  test('성공 경로: 사진 → 확인 → 신고 → 접수증 → 상태 (배포 대상)', async ({ page }) => {
    await reportViaUi(page, false);
  });
} else {
  let api: Proc | undefined;
  let web: Proc | undefined;
  let sink: Proc | undefined;
  let dataDir = '';

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    dataDir = mkdtempSync(join(tmpdir(), 'cs-full-'));
    const base = cleanEnv();
    sink = await spawnAndWait(['tests/e2e/helpers/sink.ts'], { ...base, SINK_PORT: String(SINK_PORT) }, `${SINK}/health`);
    api = await startApi(
      { ...base, ALLOW_TEST_ROUTES: '1', DATA_DIR: dataDir, CLIENT_DIST_DIR: join(dataDir, 'no-dist'), SELF_BASE_URL: API, PUBLIC_BASE_URL: WEB, PUSH_SINK_URL: `${SINK}/push` },
      API_PORT,
    );
    web = await startVite(WEB_PORT, API_PORT, base);
  });

  test.afterAll(async () => {
    await stop(web);
    await stop(api);
    await stop(sink);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  let token = '';
  let issueId = '';
  let receiptNo = '';
  const received = async () => (await (await fetch(`${SINK}/received`)).json()) as Array<{ payload: { title: string } }>;

  test('1. 성공 경로: 사진 → 확인 → 양식 → 접수증(QR) → 상태 "접수"', async ({ page }) => {
    token = await reportViaUi(page, true);
    const issue = await byToken(API, token);
    issueId = issue.id;
    receiptNo = issue.receiptNo;
    expect(issue.agencyRef).toBeTruthy();
    const list = (await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[];
    expect(list.filter((r) => r.id === issue.agencyRef)).toHaveLength(1);
  });

  test('2. 관리자 배정→처리중→완료(사진) → 신고자 화면 반영, 푸시는 완료 때 1건', async ({ page, browser }) => {
    expect(token).not.toBe('');
    // 헤드리스에서는 브라우저 푸시 구독이 불가하므로 API 로 구독을 등록한다.
    await fetch(`${SINK}/received`, { method: 'DELETE' });
    const sub = await fetch(`${API}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId, subscription: { endpoint: `${SINK}/endpoint-test`, keys: { p256dh: 'test', auth: 'test' } } }),
    });
    expect(sub.status).toBe(201);

    const citizen = await browser.newPage({ baseURL: WEB });
    await citizen.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await citizen.goto(`/s/${token}`);
    const current = citizen.getByTestId('status-steps').locator('[aria-current="step"]');
    await expect(current).toContainText('접수');

    await page.goto('/admin');
    await expect(page.getByTestId('screen-admin')).toBeVisible();
    const row = page.getByTestId(`admin-row-${issueId}`);
    await expect(row).toContainText(receiptNo);
    const select = page.getByTestId(`admin-status-${issueId}`);

    await select.selectOption('assigned');
    await expect(row).toHaveAttribute('data-status', 'assigned');
    await expect(current).toContainText('배정', { timeout: POLL_WINDOW });
    await select.selectOption('in_progress');
    await expect(row).toHaveAttribute('data-status', 'in_progress');
    await expect(current).toContainText('처리중', { timeout: POLL_WINDOW });
    expect(await received()).toHaveLength(0);

    await select.selectOption('completed');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('admin-save')).toBeDisabled();
    await page.getByTestId('admin-complete-photo').setInputFiles(BENCH);
    await expect(page.getByTestId('admin-save')).toBeEnabled();
    await expectNoBannedWords(page);
    await shot(page, 'admin-complete.png');
    await page.getByTestId('admin-save').click();
    await expect(row).toHaveAttribute('data-status', 'completed');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectNoBannedWords(page);
    await shot(page, 'admin-board.png');

    await expect(current).toContainText('완료', { timeout: POLL_WINDOW });
    await expectImageLoaded(citizen, 'completion-photo');
    await expectNoBannedWords(citizen);
    await shot(citizen, 'status-completed.png');
    await citizen.close();

    // 푸시 sink: 정확히 1건, 같은 완료를 다시 보내도 1건
    await expect.poll(async () => (await received()).length).toBe(1);
    expect((await received())[0]!.payload.title).toBe('고쳐졌어요');
    const issue = await byToken(API, token);
    const photoId = await uploadPhoto(API, BENCH);
    const again = await fetch(`${API}/mock-agency/admin/requests/${issue.agencyRef}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'completed', completionPhotoId: photoId }),
    });
    expect(again.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500)); // 부정 단언: 추가 전송이 없는지 잠깐 지켜본다
    expect(await received()).toHaveLength(1);
  });

  test('3. QR 상태 페이지: qr.svg 본문, 서버 렌더 /s/<token>, SPA 상태, 없는 토큰', async ({ page, request }) => {
    expect(token).not.toBe('');
    const svg = await request.get(`${API}/api/issues/by-token/${token}/qr.svg`);
    expect(svg.status()).toBe(200);
    expect(await svg.text()).toBe(await QRCode.toString(`${WEB}/s/${token}`, { type: 'svg', margin: 1 }));

    const ssr = await request.get(`${API}/s/${token}`);
    expect(ssr.status()).toBe(200);
    const html = await ssr.text();
    expect(html).toContain(receiptNo);
    expect(html).toContain('완료');

    await page.goto(`/s/${token}`);
    await expect(page.getByTestId('status-steps').locator('[aria-current="step"]')).toContainText('완료');
    await expectNoBannedWords(page);

    await page.goto('/s/zzz');
    await expect(page.getByText('찾을 수 없는 접수번호예요')).toBeVisible();
    await expectNoBannedWords(page);
  });

  test('4. 8 m 떨어진 같은 시설 신고는 한 건으로 합쳐지고 25 m 이상은 따로 간다', async () => {
    const lat = 37.5625 + Math.random() * 0.002;
    const lng = 126.995 + Math.random() * 0.004;
    const a = await reportAt(API, lat, lng);
    expect(a.merged).toBe(false);
    const b = await reportAt(API, lat + 0.000072, lng);
    expect(b.merged).toBe(true);
    expect(b.issueId).toBe(a.issueId);
    expect(b.reportCount).toBe(2);
    const reqs = (await (await fetch(`${API}/mock-agency/admin/requests`)).json()) as AgencyRequest[];
    expect(reqs.filter((r) => r.id === a.agencyRef)).toHaveLength(1);
    // 위도 0.0003 ≈ 33 m
    const c = await reportAt(API, lat + 0.0003, lng);
    expect(c.merged).toBe(false);
    expect(c.issueId).not.toBe(a.issueId);
  });

  test('5. 실패 경로: 없는 토큰 404, 5 MB 초과 400, 제출 가드 mock', async () => {
    expect((await fetch(`${API}/api/issues/by-token/zzz`)).status).toBe(404);

    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(5 * 1024 * 1024 + 1024)], { type: 'image/jpeg' }), 'big.jpg');
    const big = await fetch(`${API}/api/photos`, { method: 'POST', body: fd });
    expect(big.status).toBe(400);
    expect(((await big.json()) as { error: string }).error).toBe('unsupported_file');

    const st = (await (await fetch(`${API}/api/status`)).json()) as StatusResponse;
    expect(st.adapter).toBe('mock');
    expect(st.live).toBe(false);
  });

  test.describe('응급 분류 (가짜 LLM, 별도 서버 쌍)', () => {
    let fake: FakeLlm | undefined;
    let emApi: Proc | undefined;
    let emWeb: Proc | undefined;
    let emDir = '';

    test.beforeAll(async () => {
      emDir = mkdtempSync(join(tmpdir(), 'cs-full-em-'));
      const base = cleanEnv();
      fake = await startFakeLlm(FAKE_PORT);
      fake.setMode('emergency');
      emApi = await startApi(
        {
          ...base, ALLOW_TEST_ROUTES: '1', DATA_DIR: emDir, SELF_BASE_URL: EM_API, PUBLIC_BASE_URL: EM_WEB, PUSH_SINK_URL: '',
          VISION_BACKEND: 'qwen', LLM_BASE_URL: fake.url, LLM_API_KEY: 'test-key', VISION_MODEL: 'fake-vl', VISION_TIMEOUT_MS: '5000',
        },
        EM_API_PORT,
      );
      emWeb = await startVite(EM_WEB_PORT, EM_API_PORT, base);
    });

    test.afterAll(async () => {
      await stop(emWeb);
      await stop(emApi);
      await fake?.close();
      if (emDir) rmSync(emDir, { recursive: true, force: true });
    });

    test('5a. 응급 사진: classify → emergency, form → 422, 화면은 112·119 전화 링크만', async ({ page }) => {
      const photoId = await uploadPhoto(EM_API, NOGPS_PHOTO, 37.5636, 126.9976);
      const cls = await fetch(`${EM_API}/api/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId }),
      });
      expect(cls.status).toBe(200);
      expect(((await cls.json()) as { facility: string }).facility).toBe('emergency');
      const form = await fetch(`${EM_API}/api/form`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoId, facility: 'emergency', fault: null, addressLabel: '서울특별시 중구', department: '중구청' }),
      });
      expect(form.status).toBe(422);
      expect(((await form.json()) as { error: string }).error).toBe('emergency');

      await page.goto(`${EM_WEB}/`);
      await page.getByTestId('pick-photo').setInputFiles(NOGPS_PHOTO);
      await expect(page.getByTestId('screen-emergency')).toBeVisible({ timeout: 40_000 });
      const tel = page.locator('a[href^="tel:"]');
      await expect(tel).toHaveCount(2);
      await expect(page.locator('a[href="tel:112"]')).toHaveCount(1);
      await expect(page.locator('a[href="tel:119"]')).toHaveCount(1);
      await expect(page.getByTestId('btn-next')).toHaveCount(0);
      await expectNoBannedWords(page);
    });
  });
}
