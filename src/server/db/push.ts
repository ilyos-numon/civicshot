import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export interface StoredSubscription { id: string; issueId: string; subscription: unknown }

/** 구독을 저장하고 id 를 돌려준다. */
export function insertSubscription(db: DatabaseSync, issueId: string, subscription: unknown): string {
  const id = randomUUID();
  db.prepare('INSERT INTO push_subscriptions (id, issue_id, subscription_json, created_at) VALUES (?, ?, ?, ?)')
    .run(id, issueId, JSON.stringify(subscription), new Date().toISOString());
  return id;
}

/** 이슈의 구독 목록. 깨진 JSON 은 건너뛴다. */
export function listSubscriptions(db: DatabaseSync, issueId: string): StoredSubscription[] {
  const rows = db.prepare('SELECT id, issue_id, subscription_json FROM push_subscriptions WHERE issue_id = ? ORDER BY created_at')
    .all(issueId) as unknown as Array<{ id: string; issue_id: string; subscription_json: string }>;
  const out: StoredSubscription[] = [];
  for (const r of rows) {
    try { out.push({ id: r.id, issueId: r.issue_id, subscription: JSON.parse(r.subscription_json) as unknown }); } catch { /* 건너뜀 */ }
  }
  return out;
}
