import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const HARNESS = '/tests/e2e/helpers/map-harness.html';
// 1x1 투명 PNG — 실제 지도 타일 서버로는 요청을 보내지 않는다.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function stubTiles(page: Page) {
  await page.route('**/tile.openstreetmap.org/**', (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
  );
}

const picked = (page: Page) => page.evaluate(() => (window as unknown as { __picked: { lat: number; lng: number } | null }).__picked);

test.describe('지도 위치 보정', () => {
  test.beforeEach(async ({ page }) => stubTiles(page));

  test('초기값이 없으면 서울시청 근처에서 시작하고 출처를 표시한다', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByText('지도를 움직여 정확한 위치를 맞춰 주세요.')).toBeVisible();
    await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');
    await page.getByTestId('btn-pick-location').click();
    const p = await picked(page);
    expect(p!.lat).toBeCloseTo(37.5663, 3);
    expect(p!.lng).toBeCloseTo(126.9779, 3);
  });

  test('지도를 끌어 옮긴 뒤 누르면 중앙 좌표가 바뀐다', async ({ page }) => {
    await page.goto(`${HARNESS}?lat=37.5&lng=127`);
    const btn = page.getByTestId('btn-pick-location');
    const box = await btn.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);

    const map = page.getByTestId('location-map');
    await expect(map.locator('.leaflet-tile-loaded').first()).toBeAttached();
    const m = (await map.boundingBox())!;
    const cx = m.x + m.width / 2;
    const cy = m.y + m.height / 2;
    // 지도를 왼쪽 위로 끌면 중앙은 남동쪽(위도 감소, 경도 증가)으로 간다.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy - 60, { steps: 8 });
    await page.mouse.up();

    await btn.click();
    const p = (await picked(page))!;
    expect(p.lat).toBeLessThan(37.5);
    expect(p.lat).toBeGreaterThan(37.49);
    expect(p.lng).toBeGreaterThan(127);
    expect(p.lng).toBeLessThan(127.01);

    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, 'location-picker.png'), fullPage: true });
  });

  test('위도·경도를 직접 입력해도 고를 수 있다', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByText('위도·경도로 직접 입력').click();
    await page.getByTestId('input-lat').fill('37.55');
    await page.getByTestId('input-lng').fill('126.99');
    await page.getByTestId('btn-pick-location').click();
    expect(await picked(page)).toEqual({ lat: 37.55, lng: 126.99 });
  });
});

test('오프라인 대기열: 실제 IndexedDB 에 쌓였다가 온라인 복귀 시 전송된다', async ({ page, context }) => {
  await stubTiles(page);
  await page.goto(HARNESS);
  type Q = { enqueueReport(p: unknown): Promise<string>; pendingCount(): Promise<number>; sent: unknown[] };
  await context.setOffline(true);
  const count = await page.evaluate(async () => {
    const q = (window as unknown as { __queue: Q }).__queue;
    await q.enqueueReport({
      photoId: 'p1',
      facility: 'streetlight',
      fault: 'off',
      location: { lat: 37.5, lng: 127 },
      form: { title: 't', body: 'b', source: 'template' },
      reporterToken: 'tok',
      photo: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }),
    });
    return q.pendingCount();
  });
  expect(count).toBe(1);

  await context.setOffline(false); // 브라우저가 'online' 이벤트를 보낸다 → 자동 전송
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __queue: Q }).__queue.pendingCount()))
    .toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __queue: Q }).__queue.sent.length)).toBe(1);
});
