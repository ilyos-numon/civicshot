import { test, expect } from '@playwright/test';

test('서비스워커가 앱 셸을 캐시하면 오프라인에서 다시 열어도 화면이 뜬다', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '찍고끝' })).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // 서비스워커가 페이지를 제어할 때까지 기다린다(첫 방문은 한 번 다시 연다).
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '찍고끝' })).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toBeVisible();
  await context.setOffline(false);
});
