import type { DatabaseSync } from 'node:sqlite';
import type { AgencyRequest, IssueStatus, WebhookInput } from '../../shared/types.ts';
import { getRequest, isIssueStatus, setRequestStatus } from './store.ts';

export type PatchResult =
  | { ok: true; request: AgencyRequest }
  | { ok: false; status: 404 | 422; error: string; message?: string };

/**
 * 모의 기관 담당자의 상태 변경. 성공하면 앱 웹훅(`${selfBaseUrl}/api/webhooks/agency`)으로 알린다.
 * 웹훅 실패는 로그만 남기고 변경은 성공으로 둔다.
 */
export async function patchAgencyRequest(
  db: DatabaseSync,
  selfBaseUrl: string,
  id: string,
  body: { status?: unknown; completionPhotoId?: unknown },
): Promise<PatchResult> {
  const cur = getRequest(db, id);
  if (!cur) return { ok: false, status: 404, error: 'not_found' };
  if (!isIssueStatus(body.status)) return { ok: false, status: 422, error: 'invalid_input', message: 'status' };
  const status: IssueStatus = body.status;
  const photo = typeof body.completionPhotoId === 'string' && body.completionPhotoId !== '' ? body.completionPhotoId : null;
  if (body.completionPhotoId !== undefined && photo === null) return { ok: false, status: 422, error: 'invalid_input', message: 'completionPhotoId' };
  if (status === 'completed' && !photo) return { ok: false, status: 422, error: 'completion_photo_required' };
  const updated = setRequestStatus(db, id, status, photo);
  if (!updated) return { ok: false, status: 404, error: 'not_found' };
  await notifyWebhook(selfBaseUrl, { agencyRef: id, status, ...(photo ? { completionPhotoId: photo } : {}) });
  return { ok: true, request: updated };
}

async function notifyWebhook(selfBaseUrl: string, payload: WebhookInput): Promise<void> {
  try {
    const res = await fetch(`${selfBaseUrl}/api/webhooks/agency`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`mock-agency webhook responded ${res.status}`);
  } catch (err) {
    console.warn(`mock-agency webhook failed: ${(err as Error).message}`);
  }
}
