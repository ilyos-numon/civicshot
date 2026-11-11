import { describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/server/db/db.ts';
import { insertSubscription } from '../../src/server/db/push.ts';
import { completionPayload, pushMode, subjectParticle, sendCompletionPush, type NotifyDeps } from '../../src/server/notify/push.ts';
import type { Issue } from '../../src/shared/types.ts';

const now = new Date().toISOString();
const issue: Issue = {
  id: 'i1', receiptNo: '2026-1110-0001', statusToken: 'tok1', facility: 'bench', fault: 'broken', lat: 37.56, lng: 126.99, h3: '',
  sigCode: '11140', sigName: '중구', department: '중구 공원과', addressLabel: '중구 어딘가', status: 'completed', reportCount: 1,
  agencyRef: null, completionPhotoId: 'p1', createdAt: now, updatedAt: now,
};
const SUB = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'k', auth: 'a' } };
const base = { publicBaseUrl: 'http://localhost:8871', pushSinkUrl: '', vapidPublicKey: '', vapidPrivateKey: '', vapidSubject: 'mailto:demo@example.com' };

function db(subs = 1): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  migrate(d);
  for (let i = 0; i < subs; i++) insertSubscription(d, issue.id, SUB);
  return d;
}

describe('completion push', () => {
  it.each([['가로등', '이'], ['벤치', '가'], ['보도블록', '이']])('%s 뒤 조사는 %s', (word, p) => {
    expect(subjectParticle(word)).toBe(p);
  });

  it('payload 를 만든다', () => {
    expect(completionPayload(issue, base.publicBaseUrl)).toEqual({ title: '고쳐졌어요', body: '신고하신 벤치가 처리 완료됐어요', url: 'http://localhost:8871/s/tok1' });
  });

  it('모드 분기', () => {
    expect(pushMode({ ...base, pushSinkUrl: 'http://localhost:1/push' })).toBe('sink');
    expect(pushMode({ ...base, vapidPublicKey: 'p', vapidPrivateKey: 'q' })).toBe('webpush');
    expect(pushMode(base)).toBe('skip');
  });

  it('sink 모드는 구독마다 JSON POST', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 201 }));
    const sent = await sendCompletionPush(issue, { db: db(2), config: { ...base, pushSinkUrl: 'http://localhost:1/push' }, fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });
    expect(sent).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:1/push');
    expect(JSON.parse(init.body as string)).toEqual({ subscription: SUB, payload: completionPayload(issue, base.publicBaseUrl) });
  });

  it('키도 sink 도 없으면 조용히 건너뛴다', async () => {
    const logs: string[] = [];
    const send = vi.fn();
    const fetchImpl = vi.fn();
    const sent = await sendCompletionPush(issue, { db: db(), config: base, fetchImpl: fetchImpl as unknown as typeof fetch, sendNotification: send, log: (m) => logs.push(m) });
    expect(sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
  });

  it('키가 있으면 web-push 로 보낸다', async () => {
    const send = vi.fn(async (_s: unknown, _p: string, _o: unknown) => ({}));
    const sent = await sendCompletionPush(issue, { db: db(), config: { ...base, vapidPublicKey: 'pub', vapidPrivateKey: 'priv' }, sendNotification: send, log: () => {} });
    expect(sent).toBe(1);
    expect(send.mock.calls[0]![0]).toEqual(SUB);
  });

  it('실패해도 던지지 않고 키·endpoint 를 로그에 쓰지 않는다', async () => {
    const logs: string[] = [];
    const deps: NotifyDeps = {
      db: db(), config: { ...base, vapidPublicKey: 'pub-secret', vapidPrivateKey: 'priv-secret' },
      sendNotification: async () => { throw new Error(`boom ${SUB.endpoint} priv-secret`); }, log: (m) => logs.push(m),
    };
    await expect(sendCompletionPush(issue, deps)).resolves.toBe(0);
    const sinkFail = await sendCompletionPush(issue, { ...deps, config: { ...base, pushSinkUrl: 'http://localhost:1/push' }, fetchImpl: (async () => { throw new Error('down'); }) as unknown as typeof fetch });
    expect(sinkFail).toBe(0);
    const all = logs.join('\n');
    expect(all).not.toContain('push.example.test');
    expect(all).not.toContain('secret');
  });
});
