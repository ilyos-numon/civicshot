import type { DatabaseSync } from 'node:sqlite';
import type { AgencyRequest, IssueStatus } from '../../shared/types.ts';

interface AgencyRow {
  id: string; service_code: string; description: string; lat: number; lng: number; media_url: string | null;
  status: string; completion_photo_id: string | null; requested_at: string; updated_at: string;
}

function fromRow(r: AgencyRow): AgencyRequest {
  return {
    id: r.id, serviceCode: r.service_code, description: r.description, lat: r.lat, lng: r.lng, mediaUrl: r.media_url,
    status: r.status as IssueStatus, completionPhotoId: r.completion_photo_id, requestedAt: r.requested_at, updatedAt: r.updated_at,
  };
}

/** 모의 기관 요청(agency_requests). */
export function insertAgencyRequest(db: DatabaseSync, r: AgencyRequest): AgencyRequest {
  db.prepare(
    'INSERT INTO agency_requests (id, service_code, description, lat, lng, media_url, status, completion_photo_id, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(r.id, r.serviceCode, r.description, r.lat, r.lng, r.mediaUrl, r.status, r.completionPhotoId, r.requestedAt, r.updatedAt);
  return r;
}

export function getAgencyRequest(db: DatabaseSync, id: string): AgencyRequest | null {
  const r = db.prepare('SELECT * FROM agency_requests WHERE id = ?').get(id) as AgencyRow | undefined;
  return r ? fromRow(r) : null;
}

export function listAgencyRequests(db: DatabaseSync): AgencyRequest[] {
  return (db.prepare('SELECT * FROM agency_requests ORDER BY requested_at DESC, id').all() as unknown as AgencyRow[]).map(fromRow);
}

export function updateAgencyRequest(db: DatabaseSync, id: string, status: IssueStatus, completionPhotoId: string | null, updatedAt: string): AgencyRequest | null {
  db.prepare('UPDATE agency_requests SET status = ?, completion_photo_id = COALESCE(?, completion_photo_id), updated_at = ? WHERE id = ?').run(status, completionPhotoId, updatedAt, id);
  return getAgencyRequest(db, id);
}

/** 제출 시도 기록(submission_attempts). */
export function insertSubmissionAttempt(db: DatabaseSync, issueId: string, adapter: string, ok: boolean, error: string | null): void {
  db.prepare('INSERT INTO submission_attempts (issue_id, adapter, ok, error, created_at) VALUES (?, ?, ?, ?, ?)').run(issueId, adapter, ok ? 1 : 0, error, new Date().toISOString());
}

export function listSubmissionAttempts(db: DatabaseSync, issueId: string): Array<{ adapter: string; ok: boolean; error: string | null }> {
  const rows = db.prepare('SELECT adapter, ok, error FROM submission_attempts WHERE issue_id = ? ORDER BY id').all(issueId) as unknown as Array<{ adapter: string; ok: number; error: string | null }>;
  return rows.map((r) => ({ adapter: r.adapter, ok: r.ok === 1, error: r.error }));
}
