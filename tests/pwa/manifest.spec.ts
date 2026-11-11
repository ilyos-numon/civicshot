import { test, expect } from '@playwright/test';

test('빌드 결과는 설치 가능한 매니페스트와 서비스워커를 갖는다', async ({ page, request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.name).toBe('찍고끝');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(
    expect.arrayContaining(['192x192', '512x512']),
  );

  await page.goto('/');
  await expect(page.getByRole('heading', { name: '찍고끝' })).toBeVisible();
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toContain('/');
});
