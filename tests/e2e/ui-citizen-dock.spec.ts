import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const PHOTO = join('tests/e2e/fixtures/photos/streetlight.jpg');
mkdirSync(SHOT_DIR, { recursive: true });

async function checkDock(page: Page, screen: string) {
  const dock = page.getByTestId(screen).locator('.cs-dock').last();
  await expect(dock).toBeVisible();
  const alpha = await dock.evaluate((el) => {
    const c = getComputedStyle(el).backgroundColor;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return 0;
    const parts = m[1].split(/[ ,/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  });
  expect(alpha, `${screen} dock background alpha`).toBe(1);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  const r = await dock.evaluate((el) => {
    const prev = el.previousElementSibling as HTMLElement | null;
    let last: Element | null = prev;
    while (last && last.lastElementChild) last = last.lastElementChild;
    return { dockTop: el.getBoundingClientRect().top, lastBottom: last ? last.getBoundingClientRect().bottom : 0 };
  });
  expect(r.lastBottom, `${screen} last content hidden by dock`).toBeLessThanOrEqual(r.dockTop + 1);
  await page.evaluate(() => window.scrollTo(0, 0));
}

test('하단 고정 영역은 불투명하고 마지막 내용을 가리지 않는다', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('pick-photo').setInputFiles(PHOTO);
  await expect(page.getByTestId('screen-confirm')).toBeVisible({ timeout: 15_000 });
  await checkDock(page, 'screen-confirm');

  await page.getByTestId('btn-next').click();
  await expect(page.getByTestId('screen-preview')).toBeVisible();
  await checkDock(page, 'screen-preview');

  await page.getByTestId('btn-submit').click();
  await expect(page.getByTestId('screen-receipt')).toBeVisible();
  await checkDock(page, 'screen-receipt');

  await page.getByRole('link', { name: '진행 상황 보기' }).click();
  await expect(page.getByTestId('screen-status')).toBeVisible();
  await checkDock(page, 'screen-status');

  const h = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  await page.evaluate((y) => window.scrollTo(0, y), Math.floor(h / 2));
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(SHOT_DIR, 'mock-dock-status.png') });
});
