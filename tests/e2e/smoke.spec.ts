import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';

test('health는 mock 어댑터로 ok 를 준다', async ({ request }) => {
  const res = await request.get('/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true, adapter: 'mock' });
});

test('루트 페이지에 제목과 매니페스트가 있다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '찍고끝' })).toBeVisible();
  await expect(page.getByText('찍으면 끝, 신고는 저희가 할게요')).toBeVisible();
  mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: join(SHOT_DIR, 'smoke.png'), fullPage: true });
});

test('매니페스트 링크가 있다', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});

test('없는 API 경로는 서버의 404 JSON 을 준다', async ({ request }) => {
  const res = await request.get('/api/nope');
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
});
