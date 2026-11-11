import type { Hono } from 'hono';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../router.ts';
import { runSweep } from '../retention.ts';
import { PHOTOS_SUBDIR } from '../photos/store.ts';

const TABLES = ['reports', 'issues', 'photos', 'push_subscriptions', 'submission_attempts', 'agency_requests'];

// ALLOW_TEST_ROUTES=1 일 때만 등록한다.
export function testRoutes(app: Hono, ctx: AppContext): void {
  if (!ctx.config.allowTestRoutes) return;
  const { db, config } = ctx;

  app.post('/api/_test/sweep', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { now?: string | number };
    const now = body.now === undefined ? new Date() : new Date(body.now);
    if (Number.isNaN(now.getTime())) return c.json({ error: 'bad_request' }, 400);
    const result = runSweep(db, now, {
      dataDir: config.dataDir,
      photoTtlDays: config.photoTtlDays,
      reportTtlDays: config.reportTtlDays,
    });
    return c.json(result);
  });

  app.post('/api/_test/reset', (c) => {
    for (const t of TABLES) {
      try {
        db.exec(`DELETE FROM ${t}`);
      } catch {
        // 없는 테이블은 건너뛴다
      }
    }
    const dir = join(config.dataDir, PHOTOS_SUBDIR);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return c.json({ ok: true });
  });
}
