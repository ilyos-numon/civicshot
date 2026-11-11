import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import { updateIssue } from '../db/issues.ts';
import { isIssueStatus } from '../mock-agency/store.ts';
import { sendCompletionPush } from '../notify/push.ts';

/** 기관 → 앱 상태 변경 웹훅. agencyRef 로 이슈를 찾아 status·완료 사진을 갱신한다. */
export function webhooksRoutes(app: Hono, ctx: AppContext): void {
  const { db } = ctx;
  app.post('/api/webhooks/agency', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { agencyRef?: unknown; status?: unknown; completionPhotoId?: unknown } | null;
    if (!b || typeof b !== 'object' || typeof b.agencyRef !== 'string' || b.agencyRef === '') return c.json({ error: 'invalid_input', message: 'agencyRef' }, 422);
    if (!isIssueStatus(b.status)) return c.json({ error: 'invalid_input', message: 'status' }, 422);
    if (b.completionPhotoId !== undefined && typeof b.completionPhotoId !== 'string') return c.json({ error: 'invalid_input', message: 'completionPhotoId' }, 422);
    const row = db.prepare('SELECT id FROM issues WHERE agency_ref = ?').get(b.agencyRef) as { id: string } | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    const wasCompleted = (db.prepare('SELECT status FROM issues WHERE id = ?').get(row.id) as { status: string }).status === 'completed';
    const updated = updateIssue(db, row.id, { status: b.status, ...(b.completionPhotoId ? { completionPhotoId: b.completionPhotoId } : {}) });
    if (updated && updated.status === 'completed' && !wasCompleted) await sendCompletionPush(updated, { db, config: ctx.config });
    return c.body(null, 204);
  });
}
