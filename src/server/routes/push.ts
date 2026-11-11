import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import { getIssue } from '../db/issues.ts';
import { insertSubscription } from '../db/push.ts';

/** 완료 알림 구독. subscription 은 브라우저 PushSubscriptionJSON (endpoint 필수). */
export function pushRoutes(app: Hono, ctx: AppContext): void {
  app.post('/api/push/subscribe', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { issueId?: unknown; subscription?: unknown } | null;
    if (!b || typeof b !== 'object' || typeof b.issueId !== 'string' || b.issueId === '') return c.json({ error: 'invalid_input', message: 'issueId' }, 400);
    const sub = b.subscription as { endpoint?: unknown } | null | undefined;
    if (!sub || typeof sub !== 'object' || typeof sub.endpoint !== 'string' || !/^https?:\/\//.test(sub.endpoint)) {
      return c.json({ error: 'invalid_input', message: 'subscription' }, 400);
    }
    if (!getIssue(ctx.db, b.issueId)) return c.json({ error: 'not_found' }, 404);
    return c.json({ id: insertSubscription(ctx.db, b.issueId, b.subscription) }, 201);
  });
}
