import type { DatabaseSync } from 'node:sqlite';
import type { ComplaintForm, Report } from '../../shared/types.ts';

interface ReportRow {
  id: string; issue_id: string; photo_id: string; reporter_token: string; form_title: string; form_body: string;
  form_source: string; merged: number; created_at: string;
}

function fromRow(r: ReportRow): Report {
  return {
    id: r.id, issueId: r.issue_id, photoId: r.photo_id, reporterToken: r.reporter_token,
    form: { title: r.form_title, body: r.form_body, source: r.form_source as ComplaintForm['source'] },
    merged: r.merged === 1, createdAt: r.created_at,
  };
}

export function insertReport(db: DatabaseSync, report: Report): Report {
  db.prepare(
    'INSERT INTO reports (id, issue_id, photo_id, reporter_token, form_title, form_body, form_source, merged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(report.id, report.issueId, report.photoId, report.reporterToken, report.form.title, report.form.body, report.form.source, report.merged ? 1 : 0, report.createdAt);
  return report;
}

export function listReportsByIssue(db: DatabaseSync, issueId: string): Report[] {
  return (db.prepare('SELECT * FROM reports WHERE issue_id = ? ORDER BY created_at').all(issueId) as unknown as ReportRow[]).map(fromRow);
}
