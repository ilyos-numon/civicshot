import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Facility, Fault, Issue, IssueStatus } from '../../shared/types.ts';
import { H3_RES, haversineM } from '../geo/dedupe.ts';
import { gridDisk, latLngToCell } from 'h3-js';

interface IssueRow {
  id: string; receipt_no: string; status_token: string; facility: string; fault: string; lat: number; lng: number; h3: string;
  sig_code: string; sig_name: string; department: string; address_label: string; status: string; report_count: number;
  agency_ref: string | null; completion_photo_id: string | null; created_at: string; updated_at: string;
}

/** Issue 필드 → issues 컬럼 이름 (§4.4). */
const COLUMNS: Record<keyof Issue, keyof IssueRow> = {
  id: 'id', receiptNo: 'receipt_no', statusToken: 'status_token', facility: 'facility', fault: 'fault', lat: 'lat', lng: 'lng', h3: 'h3',
  sigCode: 'sig_code', sigName: 'sig_name', department: 'department', addressLabel: 'address_label', status: 'status',
  reportCount: 'report_count', agencyRef: 'agency_ref', completionPhotoId: 'completion_photo_id', createdAt: 'created_at', updatedAt: 'updated_at',
};
const KEYS = Object.keys(COLUMNS) as Array<keyof Issue>;

function fromRow(r: IssueRow): Issue {
  return {
    id: r.id, receiptNo: r.receipt_no, statusToken: r.status_token, facility: r.facility as Facility, fault: r.fault as Fault,
    lat: r.lat, lng: r.lng, h3: r.h3, sigCode: r.sig_code, sigName: r.sig_name, department: r.department, addressLabel: r.address_label,
    status: r.status as IssueStatus, reportCount: r.report_count, agencyRef: r.agency_ref, completionPhotoId: r.completion_photo_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/** 이슈를 저장한다. h3 가 비어 있으면 좌표의 res 11 셀로 채운다. 저장된 이슈를 돌려준다. */
export function insertIssue(db: DatabaseSync, issue: Issue): Issue {
  const row: Issue = { ...issue, h3: issue.h3 || latLngToCell(issue.lat, issue.lng, H3_RES) };
  const cols = KEYS.map((k) => COLUMNS[k]);
  db.prepare(`INSERT INTO issues (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...KEYS.map((k) => row[k] as SQLInputValue));
  return row;
}

/** id 로 이슈 하나. 없으면 null. */
export function getIssue(db: DatabaseSync, id: string): Issue | null {
  const r = db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as IssueRow | undefined;
  return r ? fromRow(r) : null;
}

/** 일부 필드를 고친다(id 제외). updatedAt 을 주지 않으면 지금 시각. 고친 이슈를, 없으면 null 을 돌려준다. */
export function updateIssue(db: DatabaseSync, id: string, patch: Partial<Omit<Issue, 'id'>>): Issue | null {
  const next: Partial<Issue> = { ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
  if (next.lat !== undefined || next.lng !== undefined) {
    const cur = getIssue(db, id);
    if (!cur) return null;
    if (patch.h3 === undefined) next.h3 = latLngToCell(next.lat ?? cur.lat, next.lng ?? cur.lng, H3_RES);
  }
  const keys = KEYS.filter((k) => k !== 'id' && next[k] !== undefined);
  db.prepare(`UPDATE issues SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => next[k] as SQLInputValue), id);
  return getIssue(db, id);
}

/**
 * 같은 시설·미완료(status != 'completed') 이슈 중 radiusM 안에서 가장 가까운 것. 없으면 null.
 * 후보는 res 11 셀의 gridDisk(cell, k) (반경 20 m 기준 k=1) 로 좁힌 뒤 haversine 으로 거른다.
 */
export function findNearbyOpenIssue(db: DatabaseSync, facility: Facility, lat: number, lng: number, radiusM: number): Issue | null {
  const k = Math.max(1, Math.ceil(radiusM / 45));
  const cells = gridDisk(latLngToCell(lat, lng, H3_RES), k);
  const rows = db
    .prepare(`SELECT * FROM issues WHERE facility = ? AND status != 'completed' AND h3 IN (${cells.map(() => '?').join(', ')})`)
    .all(facility, ...cells) as unknown as IssueRow[];
  let best: Issue | null = null;
  let bestD = Infinity;
  for (const r of rows) {
    const d = haversineM(lat, lng, r.lat, r.lng);
    if (d <= radiusM && d < bestD) { best = fromRow(r); bestD = d; }
  }
  return best;
}
