import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AgencyRequest, IssueStatus } from '../../shared/types.ts';
import { ISSUE_STATUSES } from '../../shared/types.ts';
import { getAgencyRequest, insertAgencyRequest, listAgencyRequests, updateAgencyRequest } from '../db/agency.ts';

/** 모의 기관 서비스 목록 (facility 별 service_code). */
export const MOCK_SERVICES = [
  { service_code: 'streetlight', service_name: '가로등 고장', group: '도로시설', type: 'realtime', metadata: false, keywords: 'streetlight', description: '가로등 점등 불량·깜빡임·기둥 파손' },
  { service_code: 'bench', service_name: '벤치 파손', group: '공원시설', type: 'realtime', metadata: false, keywords: 'bench', description: '벤치 파손·분실·낙서' },
  { service_code: 'sidewalk', service_name: '보도블록 파손', group: '도로시설', type: 'realtime', metadata: false, keywords: 'sidewalk', description: '보도블록 파손·단차·꺼짐' },
] as const;

export function isServiceCode(code: string): boolean {
  return MOCK_SERVICES.some((s) => s.service_code === code);
}

export function isIssueStatus(v: unknown): v is IssueStatus {
  return typeof v === 'string' && (ISSUE_STATUSES as readonly string[]).includes(v);
}

export function createRequest(db: DatabaseSync, input: { serviceCode: string; description: string; lat: number; lng: number; mediaUrl: string | null }): AgencyRequest {
  const now = new Date().toISOString();
  return insertAgencyRequest(db, {
    id: `mock-${randomUUID()}`, serviceCode: input.serviceCode, description: input.description, lat: input.lat, lng: input.lng,
    mediaUrl: input.mediaUrl, status: 'received', completionPhotoId: null, requestedAt: now, updatedAt: now,
  });
}

export { getAgencyRequest as getRequest, listAgencyRequests as listRequests };

export function setRequestStatus(db: DatabaseSync, id: string, status: IssueStatus, completionPhotoId: string | null): AgencyRequest | null {
  return updateAgencyRequest(db, id, status, completionPhotoId, new Date().toISOString());
}

/** Open311 GeoReport v2 표현. */
export function toOpen311(r: AgencyRequest) {
  return {
    service_request_id: r.id,
    status: r.status === 'completed' ? 'closed' : 'open',
    service_code: r.serviceCode,
    description: r.description,
    lat: r.lat,
    long: r.lng,
    requested_datetime: r.requestedAt,
    updated_datetime: r.updatedAt,
    media_url: r.mediaUrl,
    extended_attributes: { status: r.status },
  };
}
