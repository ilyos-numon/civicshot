import type { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { listExpiredPhotos, markPurged } from './db/photos.ts';

const DAY_MS = 86_400_000;

export interface SweepOptions {
  dataDir: string;
  photoTtlDays: number;
  reportTtlDays: number;
}

export interface SweepResult {
  photosPurged: number;
  issuesDeleted: number;
  reportsDeleted: number;
}

/** 보존 기간이 지난 사진 파일을 지우고 purged=1 로 표시한다. 오래된 접수 기록도 정리한다. */
export function runSweep(db: DatabaseSync, now: Date, opts: SweepOptions): SweepResult {
  const photoCutoff = new Date(now.getTime() - opts.photoTtlDays * DAY_MS).toISOString();
  let photosPurged = 0;
  for (const row of listExpiredPhotos(db, photoCutoff)) {
    rmSync(join(opts.dataDir, row.path), { force: true });
    markPurged(db, row.id);
    photosPurged++;
  }
  const reportCutoff = new Date(now.getTime() - opts.reportTtlDays * DAY_MS).toISOString();
  let reportsDeleted = 0;
  let issuesDeleted = 0;
  try {
    reportsDeleted = Number(db.prepare('DELETE FROM reports WHERE created_at < ?').run(reportCutoff).changes);
  } catch {
    // 테이블이 없으면 건너뛴다
  }
  try {
    issuesDeleted = Number(db.prepare('DELETE FROM issues WHERE updated_at < ?').run(reportCutoff).changes);
  } catch {
    // 테이블이 없으면 건너뛴다
  }
  return { photosPurged, issuesDeleted, reportsDeleted };
}

export function startSweepTimer(db: DatabaseSync, minutes: number, opts: SweepOptions): NodeJS.Timeout | null {
  if (!(minutes > 0)) return null;
  const t = setInterval(() => {
    try {
      runSweep(db, new Date(), opts);
    } catch (err) {
      console.error('retention sweep failed', err instanceof Error ? err.message : 'unknown');
    }
  }, minutes * 60_000);
  t.unref();
  return t;
}
