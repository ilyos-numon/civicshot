import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expectTapTarget } from './helpers/a11y.ts';

const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const PHOTO = join('tests/e2e/fixtures/photos/streetlight.jpg');
const BANNED = /모델|분류기|지오코딩|API|LLM/;

mkdirSync(SHOT_DIR, { recursive: true });

function countApi(page: Page): { n: number } {
  const c = { n: 0 };
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) c.n++;
  });
  return c;
}

async function noBannedWords(page: Page) {
  expect(await page.locator('body').innerText()).not.toMatch(BANNED);
}

async function openSeeded(page: Page) {
  await page.goto('/admin');
  await expect(page.getByTestId('screen-admin')).toBeVisible();
  await expect(page.getByTestId('admin-empty')).toBeVisible();
  await page.getByTestId('admin-seed').click();
  await expect(page.locator('[data-testid^="admin-row-"]')).toHaveCount(4, { timeout: 15_000 });
}

test('빈 현황판은 안내 문구와 데모 배너를 보여 준다', async ({ page }) => {
  const api = countApi(page);
  await page.goto('/admin');
  await expect(page.getByTestId('admin-empty')).toContainText('접수된 신고가 없어요');
  await expect(page.getByText('데모용 관리자 화면이에요. 실제 지자체와 연결되어 있지 않아요')).toBeVisible();
  await expectTapTarget(page.getByTestId('admin-seed'));
  await noBannedWords(page);
  expect(api.n).toBe(0);
});

test.describe('데스크톱', () => {
  test.use({ viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

  test('목록·필터·상태 변경·완료 사진 (/api 요청 0건)', async ({ page }) => {
    const api = countApi(page);
    await openSeeded(page);

    // 필터로 건수 변화
    await expect(page.getByTestId('admin-filter-received')).toContainText('2');
    await page.getByTestId('admin-filter-received').click();
    await expect(page.locator('[data-testid^="admin-row-"]')).toHaveCount(2);
    await page.getByTestId('admin-filter-in_progress').click();
    await expect(page.locator('[data-testid^="admin-row-"]')).toHaveCount(1);
    await page.getByTestId('admin-filter-all').click();
    await expect(page.locator('[data-testid^="admin-row-"]')).toHaveCount(4);

    // received → assigned
    const row = page.locator('[data-testid^="admin-row-"][data-status="received"]').first();
    const id = (await row.getAttribute('data-testid'))!.replace('admin-row-', '');
    const select = page.getByTestId(`admin-status-${id}`);
    await expect(select).toHaveAttribute('aria-label', /처리 상태/);
    await expectTapTarget(select);
    await select.selectOption('assigned');
    await expect(page.getByTestId(`admin-row-${id}`)).toHaveAttribute('data-status', 'assigned');
    await expect(select).toHaveValue('assigned');
    await expect(page.getByTestId('admin-filter-assigned')).toContainText('2');

    // completed → 다이얼로그, 사진 없으면 저장 불가
    await select.selectOption('completed');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByTestId('admin-save')).toBeDisabled();
    await expect(page.getByText('완료 사진이 있어야 저장할 수 있어요')).toBeVisible();
    // 취소하면 원래 상태 유지
    await page.getByRole('button', { name: '취소' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(select).toHaveValue('assigned');

    await select.selectOption('completed');
    await page.getByTestId('admin-complete-photo').setInputFiles(PHOTO);
    await expect(page.getByTestId('admin-save')).toBeEnabled();
    await page.getByTestId('admin-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId(`admin-row-${id}`)).toHaveAttribute('data-status', 'completed');
    await expect(select).toHaveValue('completed');
    await expect(page.getByTestId('admin-filter-completed')).toContainText('1');

    await noBannedWords(page);
    await page.waitForTimeout(1800); // 갱신 강조가 사라진 뒤 찍는다
    await page.screenshot({ path: join(SHOT_DIR, 'mock-admin-board.png'), fullPage: true });
    expect(api.n).toBe(0);
  });
});

test('모바일: 완료 다이얼로그', async ({ page }) => {
  const api = countApi(page);
  await openSeeded(page);
  const row = page.locator('[data-testid^="admin-row-"][data-status="in_progress"]').first();
  const id = (await row.getAttribute('data-testid'))!.replace('admin-row-', '');
  await expectTapTarget(page.getByTestId(`admin-status-${id}`));
  await page.getByTestId(`admin-status-${id}`).selectOption('completed');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId('admin-save')).toBeDisabled();
  await page.getByTestId('admin-complete-photo').setInputFiles(PHOTO);
  await expect(page.getByTestId('admin-save')).toBeEnabled();
  await expectTapTarget(page.getByTestId('admin-save'));
  await noBannedWords(page);
  await page.waitForTimeout(400); // 시트 등장 애니메이션이 끝난 뒤
  await page.screenshot({ path: join(SHOT_DIR, 'mock-admin-complete.png') });
  expect(api.n).toBe(0);
});
