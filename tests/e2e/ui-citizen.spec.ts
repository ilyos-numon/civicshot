import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expectTapTarget } from './helpers/a11y.ts';

const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const PHOTO = join('tests/e2e/fixtures/photos/streetlight.jpg');
const BANNED = /모델|분류기|지오코딩|API|LLM/;

mkdirSync(SHOT_DIR, { recursive: true });

function countApi(page: Page): { n: number; urls: string[] } {
  const c = { n: 0, urls: [] as string[] };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) {
      c.n++;
      c.urls.push(r.url());
    }
  });
  return c;
}

async function noBannedWords(page: Page) {
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(BANNED);
}

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOT_DIR, name), fullPage: true });

test('사진 한 장으로 접수·상태까지 간다 (목업, /api 요청 0건)', async ({ page }) => {
  const api = countApi(page);
  await page.goto('/');
  await expect(page.getByTestId('screen-capture')).toBeVisible();
  await expect(page.getByRole('heading', { name: '찍고끝' })).toBeVisible();
  await expectTapTarget(page.locator('label[for="pick-photo"]'));
  await noBannedWords(page);
  await shot(page, 'mock-capture.png');

  await page.getByTestId('pick-photo').setInputFiles(PHOTO);
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('field-facility')).toContainText('가로등');
  await expect(page.getByTestId('field-fault')).toContainText('점등 불량');
  await expect(page.getByTestId('field-facility')).toContainText('(자동)');
  await expect(page.getByTestId('field-department')).not.toBeEmpty();
  await expectTapTarget(page.getByTestId('btn-next'));
  await expectTapTarget(page.getByRole('button', { name: '시설 고치기' }));
  await noBannedWords(page);
  await shot(page, 'mock-confirm.png');

  await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('screen-preview')).toBeVisible();
  await expect(page.getByTestId('form-title')).not.toHaveValue('');
  await expect(page.getByTestId('form-body')).not.toHaveValue('');
  await page.getByTestId('form-body').fill('밤마다 가로등이 꺼져 있어 어둡습니다. 점검 부탁드립니다.');
  await expect(page.getByTestId('form-body')).toHaveValue(/점검 부탁드립니다/);
  await expectTapTarget(page.getByTestId('btn-submit'));
  await noBannedWords(page);
  await shot(page, 'mock-preview.png');

  await page.getByTestId('btn-submit').click();
  await expect(page.getByTestId('screen-receipt')).toBeVisible();
  await expect(page.getByTestId('receipt-no')).toHaveText(/\S+/);
  await expect(page.getByTestId('qr-image')).toBeVisible();
  await expect(page.getByText('처음 신고예요', { exact: false })).toBeVisible();
  await expect(page.getByRole('switch', { name: /처리되면 알려주세요/ })).toBeVisible();
  await noBannedWords(page);
  await shot(page, 'mock-receipt.png');

  await page.getByRole('link', { name: '진행 상황 보기' }).click();
  await expect(page.getByTestId('screen-status')).toBeVisible();
  const steps = page.getByTestId('status-steps');
  await expect(steps.locator('[aria-current="step"]')).toContainText('접수');
  await expect(page.getByTestId('report-count')).toContainText('1건');
  await expect(page.getByText('중구청 도로관리과')).toBeVisible();
  await expectTapTarget(page.getByTestId('btn-me-too'));
  await noBannedWords(page);
  await shot(page, 'mock-status.png');

  expect(api.n, `api requests: ${api.urls.join(', ')}`).toBe(0);
});

test('응급으로 보이면 112·119 전화 버튼 2개만 보인다', async ({ page }) => {
  const api = countApi(page);
  await page.addInitScript(() => sessionStorage.setItem('cs-scenario', 'emergency'));
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(PHOTO);
  await expect(page.getByTestId('screen-emergency')).toBeVisible({ timeout: 15_000 });
  const tel = page.locator('a[href^="tel:"]');
  await expect(tel).toHaveCount(2);
  await expect(page.locator('a[href="tel:112"]')).toBeVisible();
  await expect(page.locator('a[href="tel:119"]')).toBeVisible();
  await expect(page.getByTestId('screen-emergency').locator('button, a[href]:not([href^="tel:"])')).toHaveCount(0);
  for (const l of await tel.all()) await expectTapTarget(l);
  await noBannedWords(page);
  await shot(page, 'mock-emergency.png');
  expect(api.n).toBe(0);
});

test('인터넷이 끊기면 안내 띠가 보인다', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await noBannedWords(page);
  await context.setOffline(false);
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
});
