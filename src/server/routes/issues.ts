import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import type { Issue } from '../../shared/types.ts';
import { getIssue } from '../db/issues.ts';
import { isIssueStatus } from '../mock-agency/store.ts';

export function issuesRoutes(app: Hono, ctx: AppContext): void {
  const { db } = ctx;

  // 관리자 목록 (인증 없음, DEMO 전용).
  app.get('/api/issues', (c) => {
    const status = c.req.query('status');
    if (status !== undefined && status !== '' && !isIssueStatus(status)) return c.json({ error: 'invalid_input', message: 'status' }, 422);
    const rawLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const ids = (status
      ? db.prepare('SELECT id FROM issues WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT id FROM issues ORDER BY created_at DESC LIMIT ?').all(limit)) as unknown as Array<{ id: string }>;
    return c.json(ids.map((r) => getIssue(db, r.id)).filter((i): i is Issue => i !== null));
  });
  // QR(qr.svg)과 by-token JSON 은 status.ts 에 있다.
  app.get('/api/issues/:id', (c) => {
    const issue = getIssue(db, c.req.param('id'));
    return issue ? c.json(issue) : c.json({ error: 'not_found' }, 404);
  });
}
