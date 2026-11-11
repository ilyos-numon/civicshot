import { test, expect } from '@playwright/test';

const cases = [
  { name: '중구', lat: 37.5636, lng: 126.9976 },
  { name: '강남구', lat: 37.5172, lng: 127.0473 },
  { name: '마포구', lat: 37.5563, lng: 126.9236 },
];

for (const c of cases) {
  test(`${c.name} 좌표는 ${c.name} 관할로 판정된다`, async ({ request }) => {
    const res = await request.post('/api/locate', { data: { lat: c.lat, lng: c.lng, facility: 'streetlight' } });
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    const body = await res.json();
    expect(body.sigName).toBe(c.name);
    expect(body.sigCode).toMatch(/^11\d{3}$/);
    expect(body.department).toBeTruthy();
    expect(body.addressLabel).toBe(`${c.name} 부근`);
    expect(body.source).toBe('offline');
    expect(body.lat).toBe(c.lat);
    expect(body.lng).toBe(c.lng);
  });
}

test('지원 지역 밖 (0,0) 은 422 out_of_coverage', async ({ request }) => {
  const res = await request.post('/api/locate', { data: { lat: 0, lng: 0, facility: 'bench' } });
  expect(res.status()).toBe(422);
  expect((await res.json()).error).toBe('out_of_coverage');
});

test('응급 상황은 422 unsupported', async ({ request }) => {
  const res = await request.post('/api/locate', { data: { lat: 37.5636, lng: 126.9976, facility: 'emergency' } });
  expect(res.status()).toBe(422);
  expect((await res.json()).error).toBe('unsupported');
});

test('위도가 문자열이면 거절된다', async ({ request }) => {
  const res = await request.post('/api/locate', { data: { lat: '37.5', lng: 126.9976, facility: 'bench' } });
  expect([400, 422]).toContain(res.status());
  expect(typeof (await res.json()).error).toBe('string');
});
