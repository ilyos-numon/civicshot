import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import { getIssue } from '../db/issues.ts';
import { patchAgencyRequest } from '../mock-agency/server.ts';

// 관리자 보조(DEMO 전용): 이슈 id 로 모의 기관 상태 변경을 대신 호출한다. §4.2 밖 추가 라우트는 이것 하나.
export function adminRoutes(app: Hono, ctx: AppContext): void {
  const { db, config } = ctx;
  app.patch('/api/admin/issues/:id', async (c) => {
    const issue = getIssue(db, c.req.param('id'));
    if (!issue) return c.json({ error: 'not_found' }, 404);
    if (!issue.agencyRef) return c.json({ error: 'not_submitted' }, 409);
    const body = (await c.req.json().catch(() => null)) as { status?: unknown; completionPhotoId?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid_input' }, 422);
    const result = await patchAgencyRequest(db, config.selfBaseUrl, issue.agencyRef, body);
    if (!result.ok) return c.json({ error: result.error, ...(result.message ? { message: result.message } : {}) }, result.status);
    return c.json(getIssue(db, issue.id));
  });
}
