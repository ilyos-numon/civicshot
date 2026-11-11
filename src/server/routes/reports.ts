import type { Hono } from 'hono';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AppContext } from '../router.ts';
import { FAULTS, type ComplaintForm, type Fault, type Location, type ReportInput, type ReportResult } from '../../shared/types.ts';
import { getPhotoRow } from '../db/photos.ts';
import { findNearbyOpenIssue, getIssue, insertIssue, updateIssue } from '../db/issues.ts';
import { insertReport } from '../db/reports.ts';
import { cellOf } from '../geo/dedupe.ts';
import { insertWithReceiptNo, realizeAdapter, submitWithRetry } from '../submission/index.ts';

type Supported = keyof typeof FAULTS;
type Parsed = { ok: true; input: ReportInput } | { ok: false; error: string; message?: string };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseReportInput(b: unknown): Parsed {
  if (!b || typeof b !== 'object') return { ok: false, error: 'invalid_input' };
  const o = b as Record<string, unknown>;
  if (o.facility === 'emergency') return { ok: false, error: 'emergency' };
  if (o.facility === 'unsupported') return { ok: false, error: 'unsupported' };
  if (!isStr(o.photoId)) return { ok: false, error: 'invalid_input', message: 'photoId' };
  if (typeof o.facility !== 'string' || !(o.facility in FAULTS)) return { ok: false, error: 'invalid_input', message: 'facility' };
  const facility = o.facility as Supported;
  if (typeof o.fault !== 'string' || !(FAULTS[facility] as readonly string[]).includes(o.fault)) return { ok: false, error: 'invalid_input', message: 'fault' };
  const l = o.location as Record<string, unknown> | undefined;
  if (!l || typeof l !== 'object' || !isNum(l.lat) || !isNum(l.lng) || Math.abs(l.lat) > 90 || Math.abs(l.lng) > 180) {
    return { ok: false, error: 'invalid_input', message: 'location' };
  }
  if (!isStr(l.sigCode) || !isStr(l.sigName) || !isStr(l.department) || !isStr(l.addressLabel)) return { ok: false, error: 'invalid_input', message: 'location' };
  const f = o.form as Record<string, unknown> | undefined;
  if (!f || typeof f !== 'object' || !isStr(f.title) || !isStr(f.body)) return { ok: false, error: 'invalid_input', message: 'form' };
  if (!isStr(o.reporterToken)) return { ok: false, error: 'invalid_input', message: 'reporterToken' };
  const location: Location = {
    lat: l.lat, lng: l.lng, sigCode: l.sigCode, sigName: l.sigName, department: l.department, addressLabel: l.addressLabel,
    source: l.source === 'nominatim' ? 'nominatim' : 'offline',
  };
  const form: ComplaintForm = { title: f.title, body: f.body, source: f.source === 'llm' ? 'llm' : 'template' };
  return { ok: true, input: { photoId: o.photoId, facility, fault: o.fault as Fault, location, form, reporterToken: o.reporterToken } };
}

export function reportsRoutes(app: Hono, ctx: AppContext): void {
  const { db, config } = ctx;
  const adapter = realizeAdapter(ctx.adapter);

  app.post('/api/reports', async (c) => {
    const parsed = parseReportInput(await c.req.json().catch(() => null));
    if (!parsed.ok) return c.json({ error: parsed.error, ...(parsed.message ? { message: parsed.message } : {}) }, 422);
    const input = parsed.input;
    const photo = getPhotoRow(db, input.photoId);
    if (!photo || photo.purged === 1) return c.json({ error: 'photo_not_found' }, 422);

    const now = new Date();
    const nowIso = now.toISOString();
    const statusUrl = (t: string) => `${config.publicBaseUrl}/s/${t}`;
    const reportOf = (issueId: string, merged: boolean) => ({
      id: randomUUID(), issueId, photoId: input.photoId, reporterToken: input.reporterToken, form: input.form, merged, createdAt: nowIso,
    });

    const near = findNearbyOpenIssue(db, input.facility, input.location.lat, input.location.lng, config.mergeRadiusM);
    if (near) {
      const report = reportOf(near.id, true);
      db.exec('BEGIN IMMEDIATE');
      try {
        insertReport(db, report);
        db.prepare('UPDATE issues SET report_count = report_count + 1, updated_at = ? WHERE id = ?').run(nowIso, near.id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      const issue = getIssue(db, near.id) ?? near;
      const body: ReportResult = {
        reportId: report.id, issueId: issue.id, receiptNo: issue.receiptNo, statusToken: issue.statusToken, statusUrl: statusUrl(issue.statusToken),
        agencyRef: issue.agencyRef, status: issue.status, merged: true, reportCount: issue.reportCount,
      };
      return c.json(body, 201);
    }

    const issueId = randomUUID();
    const report = reportOf(issueId, false);
    const issue = insertWithReceiptNo(db, now, (receiptNo) => {
      const created = insertIssue(db, {
        id: issueId, receiptNo, statusToken: randomBytes(16).toString('base64url'), facility: input.facility, fault: input.fault,
        lat: input.location.lat, lng: input.location.lng, h3: cellOf(input.location.lat, input.location.lng),
        sigCode: input.location.sigCode, sigName: input.location.sigName, department: input.location.department, addressLabel: input.location.addressLabel,
        status: 'received', reportCount: 1, agencyRef: null, completionPhotoId: null, createdAt: nowIso, updatedAt: nowIso,
      });
      insertReport(db, report);
      return created;
    });

    const sent = await submitWithRetry(db, adapter, { issue, form: input.form, photoUrl: `${config.selfBaseUrl}/api/photos/${input.photoId}` });
    if (!sent) return c.json({ error: 'submission_failed', message: '기관 접수에 실패했어요. 잠시 후 다시 시도해 주세요.' }, 503);
    const saved = updateIssue(db, issue.id, { agencyRef: sent.agencyRef }) ?? issue;
    const body: ReportResult = {
      reportId: report.id, issueId: saved.id, receiptNo: saved.receiptNo, statusToken: saved.statusToken, statusUrl: statusUrl(saved.statusToken),
      agencyRef: saved.agencyRef, status: saved.status, merged: false, reportCount: saved.reportCount,
    };
    return c.json(body, 201);
  });
}
