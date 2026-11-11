import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import type { Config } from './config.ts';
import type { LimitScope, RateLimitedBody } from '../shared/types.ts';

export interface LimitOptions { perMinute: number; perDay: number; dailyTotal: number } // 0 = 그 범위 끔
export type LimitResult = { ok: true } | { ok: false; scope: LimitScope; retryAfterSec: number };
export interface Limiter { consume(key: string): Promise<LimitResult>; reset(): void }

const TOTAL_KEY = '*';

interface Stage { scope: LimitScope; points: number; duration: number; fixedKey?: string; rl?: RateLimiterMemory }

export function createLimiter(opt: LimitOptions): Limiter {
  const stages: Stage[] = [
    { scope: 'minute', points: opt.perMinute, duration: 60 },
    { scope: 'day', points: opt.perDay, duration: 86400 },
    { scope: 'total', points: opt.dailyTotal, duration: 86400, fixedKey: TOTAL_KEY },
  ];
  const build = (): void => {
    for (const s of stages) s.rl = s.points > 0 ? new RateLimiterMemory({ points: s.points, duration: s.duration }) : undefined;
  };
  build();
  return {
    async consume(key: string): Promise<LimitResult> {
      const done: { rl: RateLimiterMemory; k: string }[] = [];
      for (const s of stages) {
        if (!s.rl) continue;
        const k = s.fixedKey ?? key;
        try {
          await s.rl.consume(k, 1);
          done.push({ rl: s.rl, k });
        } catch (err) {
          // 거부된 요청이 포인트를 소모하지 않게: 이 단계와 앞 단계 모두 되돌린다.
          if (!(err instanceof RateLimiterRes)) throw err;
          await s.rl.reward(k, 1);
          for (const d of done) await d.rl.reward(d.k, 1);
          return { ok: false, scope: s.scope, retryAfterSec: Math.max(1, Math.ceil(err.msBeforeNext / 1000)) };
        }
      }
      return { ok: true };
    },
    reset(): void { build(); },
  };
}

const memo = new WeakMap<Config, Limiter>();
export function limiterFor(config: Config): Limiter {
  let l = memo.get(config);
  if (!l) {
    l = createLimiter({ perMinute: config.rateLimitPerMinute, perDay: config.rateLimitPerDay, dailyTotal: config.rateLimitDailyTotal });
    memo.set(config, l);
  }
  return l;
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

export function clientIp(c: Context, trustedProxyHops: number): string {
  if (trustedProxyHops >= 1) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const parts = xff.split(',').map((s) => s.trim()).filter((s) => s !== '');
      const v = parts[parts.length - trustedProxyHops];
      if (parts.length >= trustedProxyHops && v) return v;
    }
  }
  return socketAddress(c) ?? 'unknown';
}

export function rateLimited(c: Context, r: Extract<LimitResult, { ok: false }>): Response {
  const body: RateLimitedBody = { error: 'rate_limited', scope: r.scope, retryAfterSec: r.retryAfterSec };
  c.header('Retry-After', String(r.retryAfterSec));
  c.header('Cache-Control', 'no-store');
  return c.json(body, 429);
}
