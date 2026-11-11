import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createLimiter, limiterFor, clientIp, rateLimited } from '../../src/server/ratelimit.ts';
import { loadConfig } from '../../src/server/config.ts';

const A = '2001:db8::a';
const B = '2001:db8::b';

describe('createLimiter', () => {
  it('rejects with scope minute after per-minute limit', async () => {
    const l = createLimiter({ perMinute: 2, perDay: 10, dailyTotal: 100 });
    expect(await l.consume(A)).toEqual({ ok: true });
    expect(await l.consume(A)).toEqual({ ok: true });
    const r = await l.consume(A);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.scope).toBe('minute');
      expect(Number.isInteger(r.retryAfterSec)).toBe(true);
      expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
    }
  });

  it('rejects with scope day', async () => {
    const l = createLimiter({ perMinute: 10, perDay: 2, dailyTotal: 100 });
    await l.consume(A); await l.consume(A);
    const r = await l.consume(A);
    expect(r).toMatchObject({ ok: false, scope: 'day' });
    if (!r.ok) expect(r.retryAfterSec).toBeGreaterThan(60);
  });

  it('rejects with scope total across keys', async () => {
    const l = createLimiter({ perMinute: 10, perDay: 10, dailyTotal: 2 });
    await l.consume(A); await l.consume(B);
    expect(await l.consume('2001:db8::c')).toMatchObject({ ok: false, scope: 'total' });
  });

  it('0 disables a scope', async () => {
    const l = createLimiter({ perMinute: 0, perDay: 0, dailyTotal: 0 });
    for (let i = 0; i < 50; i++) expect((await l.consume(A)).ok).toBe(true);
  });

  it('refunds earlier points when a later scope rejects', async () => {
    const l = createLimiter({ perMinute: 2, perDay: 10, dailyTotal: 1 });
    expect((await l.consume(A)).ok).toBe(true); // total exhausted
    for (let i = 0; i < 5; i++) expect(await l.consume(B)).toMatchObject({ ok: false, scope: 'total' });
    l.reset();
    // after reset, compare: B was refunded, so a fresh limiter with total open shows nothing; verify directly instead
    const l2 = createLimiter({ perMinute: 2, perDay: 10, dailyTotal: 3 });
    await l2.consume(A); await l2.consume(A); await l2.consume(A); // A: minute rejects 3rd, refund → total used 2
    expect((await l2.consume(B)).ok).toBe(true); // total 3rd point
    expect(await l2.consume(B)).toMatchObject({ ok: false, scope: 'total' });
    // B minute bucket must still have 1 point (only 1 consumed, rejected one refunded) — prove with a total-free limiter path:
    const l3 = createLimiter({ perMinute: 1, perDay: 10, dailyTotal: 1 });
    await l3.consume(A);
    expect(await l3.consume(B)).toMatchObject({ scope: 'total' });
    expect(await l3.consume(B)).toMatchObject({ scope: 'total' }); // not 'minute': B's minute point was refunded
  });

  it('different keys are independent', async () => {
    const l = createLimiter({ perMinute: 1, perDay: 10, dailyTotal: 100 });
    expect((await l.consume(A)).ok).toBe(true);
    expect((await l.consume(B)).ok).toBe(true);
    expect((await l.consume(A)).ok).toBe(false);
  });

  it('reset() allows again', async () => {
    const l = createLimiter({ perMinute: 1, perDay: 10, dailyTotal: 100 });
    await l.consume(A);
    expect((await l.consume(A)).ok).toBe(false);
    l.reset();
    expect((await l.consume(A)).ok).toBe(true);
  });

  it('limiterFor memoizes per config object', () => {
    const c1 = loadConfig({});
    const c2 = loadConfig({});
    expect(limiterFor(c1)).toBe(limiterFor(c1));
    expect(limiterFor(c1)).not.toBe(limiterFor(c2));
  });
});

describe('config', () => {
  it('defaults and invalid values', () => {
    const c = loadConfig({});
    expect([c.rateLimitPerMinute, c.rateLimitPerDay, c.rateLimitDailyTotal, c.trustedProxyHops]).toEqual([5, 20, 300, 0]);
    const d = loadConfig({ RATE_LIMIT_PER_MINUTE: '-1', RATE_LIMIT_PER_DAY: 'abc', RATE_LIMIT_DAILY_TOTAL: '0', TRUSTED_PROXY_HOPS: '2' });
    expect([d.rateLimitPerMinute, d.rateLimitPerDay, d.rateLimitDailyTotal, d.trustedProxyHops]).toEqual([5, 20, 0, 2]);
  });
});

function ipApp(hops: number) {
  const app = new Hono();
  app.get('/', (c) => c.text(clientIp(c, hops)));
  return app;
}
const sock = { incoming: { socket: { remoteAddress: 'sock::1', remotePort: 1 } } };
async function ip(hops: number, xff?: string, env?: object) {
  const headers: Record<string, string> = xff ? { 'x-forwarded-for': xff } : {};
  const res = await ipApp(hops).fetch(new Request('http://localhost/', { headers }), env);
  return res.text();
}

describe('clientIp', () => {
  it('hops 0 ignores XFF', async () => {
    expect(await ip(0, A, sock)).toBe('sock::1');
    expect(await ip(0, A)).toBe('unknown');
  });
  it('hops 1 uses rightmost', async () => {
    expect(await ip(1, `${A}, ${B}`, sock)).toBe(B);
  });
  it('hops 2 uses second from right', async () => {
    expect(await ip(2, ` ${A} ,${B}`, sock)).toBe(A);
  });
  it('too few entries falls back to socket, then unknown', async () => {
    expect(await ip(3, `${A}, ${B}`, sock)).toBe('sock::1');
    expect(await ip(1, undefined, sock)).toBe('sock::1');
    expect(await ip(3, `${A}`)).toBe('unknown');
  });
});

describe('rateLimited', () => {
  it('returns 429 with headers and body', async () => {
    const app = new Hono();
    app.get('/', (c) => rateLimited(c, { ok: false, scope: 'day', retryAfterSec: 42 }));
    const res = await app.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'rate_limited', scope: 'day', retryAfterSec: 42 });
  });
});
