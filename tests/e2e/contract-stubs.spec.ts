import { test, expect } from '@playwright/test';

const stubs: Array<[method: 'get' | 'post', path: string]> = [
];

for (const [method, path] of stubs) {
  test(`스텁 ${method.toUpperCase()} ${path} 는 501`, async ({ request }) => {
    const res = await request[method](path);
    expect(res.status()).toBe(501);
    expect(await res.json()).toEqual({ error: 'not_implemented' });
  });
}

test('/api/status 는 mock 어댑터와 기본 백엔드를 준다', async ({ request }) => {
  const res = await request.get('/api/status');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toBe('no-store');
  expect(await res.json()).toEqual({ adapter: 'mock', live: false, backends: { vision: 'fixture', llm: 'template', geocoder: 'offline' } });
});

test('/health 는 유지된다', async ({ request }) => {
  const res = await request.get('/health');
  expect(await res.json()).toEqual({ ok: true, adapter: 'mock' });
});

test('ALLOW_TEST_ROUTES 미설정이면 /api/_test/reset 은 404', async ({ request }) => {
  const res = await request.post('/api/_test/reset');
  expect(res.status()).toBe(404);
});
