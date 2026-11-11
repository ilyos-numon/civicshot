import type { DatabaseSync } from 'node:sqlite';
import type { ComplaintForm, Issue } from '../../shared/types.ts';
import type { Config } from '../config.ts';
import { EmailAdapter, Open311Adapter, selectAdapter, type SubmissionAdapter } from './adapter.ts';
import { Open311Client } from './open311.ts';
import { EmailSender } from './email.ts';
import { insertSubmissionAttempt } from '../db/agency.ts';

/**
 * selectAdapter(가드 포함) 가 고른 자리 객체를 같은 옵션의 실제 구현으로 바꾼다.
 * 이미 실제 구현이면 그대로 돌려준다.
 */
export function realizeAdapter(adapter: SubmissionAdapter): SubmissionAdapter {
  if (adapter instanceof Open311Adapter) return new Open311Client(adapter.options, adapter.name);
  if (adapter instanceof EmailAdapter) return new EmailSender(adapter.options);
  return adapter;
}

/** 설정 → 가드를 거친 실제 어댑터. */
export function createAdapter(config: Config): { adapter: SubmissionAdapter; live: boolean; refused?: string } {
  const sel = selectAdapter(config);
  return { ...sel, adapter: realizeAdapter(sel.adapter) };
}

export const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [500, 1000, 2000];

/** 재시도 간격. SUBMISSION_RETRY_BASE_MS(테스트용, 기본 500)를 기준으로 ×1, ×2, ×4. */
export function backoffDelays(env: Record<string, string | undefined> = process.env): number[] {
  const raw = env.SUBMISSION_RETRY_BASE_MS;
  const base = raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0 ? Number(raw) : null;
  return base === null ? DEFAULT_BACKOFF_MS : [base, base * 2, base * 4];
}

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 최대 MAX_ATTEMPTS 번 제출한다. 각 시도를 submission_attempts 에 남기고, 실패 뒤에는 delays[i] 만큼 쉰다.
 * 모두 실패하면 null.
 */
export async function submitWithRetry(
  db: DatabaseSync,
  adapter: SubmissionAdapter,
  input: { issue: Issue; form: ComplaintForm; photoUrl: string },
  opts: { delays?: number[]; sleep?: Sleep } = {},
): Promise<{ agencyRef: string; receiptUrl?: string } | null> {
  const delays = opts.delays ?? backoffDelays();
  const sleep = opts.sleep ?? realSleep;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      const out = await adapter.submit(input);
      insertSubmissionAttempt(db, input.issue.id, adapter.name, true, null);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      insertSubmissionAttempt(db, input.issue.id, adapter.name, false, msg.slice(0, 200));
      console.warn(`submission attempt ${i + 1}/${MAX_ATTEMPTS} failed (${adapter.name})`);
      if (i < MAX_ATTEMPTS - 1) await sleep(delays[i] ?? delays[delays.length - 1] ?? 0);
    }
  }
  return null;
}

/** 서울 시간 기준 일자 키 `YYYY-MMDD`. */
export function receiptDay(now: Date): string {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}${d}`;
}

/** 그날 다음 접수번호. 같은 트랜잭션 안에서 insert 해야 한다 (insertWithReceiptNo). */
export function nextReceiptNo(db: DatabaseSync, now: Date): string {
  const day = receiptDay(now);
  const row = db.prepare("SELECT MAX(CAST(substr(receipt_no, 11) AS INTEGER)) AS n FROM issues WHERE receipt_no LIKE ? || '-%'").get(day) as { n: number | null } | undefined;
  return `${day}-${String((row?.n ?? 0) + 1).padStart(4, '0')}`;
}

/** BEGIN IMMEDIATE 트랜잭션 안에서 접수번호를 정하고 insert 를 실행한다. */
export function insertWithReceiptNo<T>(db: DatabaseSync, now: Date, insert: (receiptNo: string) => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = insert(nextReceiptNo(db, now));
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
