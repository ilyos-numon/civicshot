import { expect, type Locator } from '@playwright/test';

/** 터치 영역이 min px 이상인지 확인한다 (기본 44px). */
export async function expectTapTarget(locator: Locator, min = 44): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'element should be visible').not.toBeNull();
  expect(box!.height, 'tap height').toBeGreaterThanOrEqual(min);
  expect(box!.width, 'tap width').toBeGreaterThanOrEqual(min);
}
