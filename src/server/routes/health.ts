import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';

export function healthRoutes(app: Hono, ctx: AppContext): void {
  app.get('/health', (c) => c.json({ ok: true, adapter: ctx.adapter.name }));
}
