import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { simpleParser } from 'mailparser';
import { migrate } from '../../src/server/db/db.ts';
import { insertIssue } from '../../src/server/db/issues.ts';
import { listSubmissionAttempts } from '../../src/server/db/agency.ts';
import { loadConfig } from '../../src/server/config.ts';
import { LIVE_CONFIRM_PHRASE, selectAdapter, type SubmissionAdapter } from '../../src/server/submission/adapter.ts';
import { backoffDelays, createAdapter, insertWithReceiptNo, nextReceiptNo, receiptDay, submitWithRetry } from '../../src/server/submission/index.ts';
import { buildOpen311Form, Open311Client } from '../../src/server/submission/open311.ts';
import { buildMime, EmailSender } from '../../src/server/submission/email.ts';
import type { Issue } from '../../src/shared/types.ts';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

function issue(id: string, receiptNo: string): Issue {
  const now = new Date().toISOString();
  return {
    id, receiptNo, statusToken: `tok-${id}`, facility: 'streetlight', fault: 'light_out', lat: 37.5636, lng: 126.9976, h3: '',
    sigCode: '11140', sigName: '중구', department: '중구 도로과', addressLabel: '중구 어딘가', status: 'received', reportCount: 1,
    agencyRef: null, completionPhotoId: null, createdAt: now, updatedAt: now,
  };
}

const form = { title: '가로등 점등 불량', body: '가로등이 꺼져 있어요.', source: 'template' as const };

describe('receiptNo', () => {
  it('KST 일자 키', () => {
    expect(receiptDay(new Date('2026-11-10T16:00:00Z'))).toBe('2026-1111');
    expect(receiptDay(new Date('2026-11-10T03:00:00Z'))).toBe('2026-1110');
  });
  it('일자별 시퀀스가 1부터 증가하고 날이 바뀌면 다시 1', () => {
    const db = memDb();
    const d1 = new Date('2026-11-10T03:00:00Z');
    const nos: string[] = [];
    for (let i = 0; i < 3; i++) nos.push(insertWithReceiptNo(db, d1, (no) => insertIssue(db, issue(`a${i}`, no)).receiptNo));
    expect(nos).toEqual(['2026-1110-0001', '2026-1110-0002', '2026-1110-0003']);
    expect(nextReceiptNo(db, new Date('2026-11-11T03:00:00Z'))).toBe('2026-1111-0001');
    expect(nos[0]).toMatch(/^\d{4}-\d{4}-\d{4}$/);
  });
  it('insert 실패 시 롤백되어 번호가 비지 않는다', () => {
    const db = memDb();
    const d = new Date('2026-11-10T03:00:00Z');
    expect(() => insertWithReceiptNo(db, d, () => { throw new Error('boom'); })).toThrow('boom');
    expect(nextReceiptNo(db, d)).toBe('2026-1110-0001');
  });
});

describe('submitWithRetry', () => {
  const failing = (failTimes: number): SubmissionAdapter & { calls: number } => {
    const a = {
      name: 'mock' as const, calls: 0,
      services: async () => [],
      submit: async () => { a.calls++; if (a.calls <= failTimes) throw new Error('down'); return { agencyRef: 'ref-1' }; },
      getStatus: async () => null,
    };
    return a;
  };
  it('3회 모두 실패하면 null, 시도 3행, 백오프 0.5/1 s', async () => {
    const db = memDb();
    insertIssue(db, issue('x', '2026-1110-0001'));
    const slept: number[] = [];
    const out = await submitWithRetry(db, failing(99), { issue: issue('x', '2026-1110-0001'), form, photoUrl: 'http://localhost/p' }, { delays: backoffDelays({}), sleep: async (ms) => { slept.push(ms); } });
    expect(out).toBeNull();
    expect(slept).toEqual([500, 1000]);
    const rows = listSubmissionAttempts(db, 'x');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.ok)).toBe(true);
  });
  it('두 번째에 성공하면 agencyRef 를 돌려준다', async () => {
    const db = memDb();
    const a = failing(1);
    const out = await submitWithRetry(db, a, { issue: issue('y', 'n'), form, photoUrl: 'p' }, { sleep: async () => {} });
    expect(out).toEqual({ agencyRef: 'ref-1' });
    expect(listSubmissionAttempts(db, 'y').map((r) => r.ok)).toEqual([false, true]);
  });
  it('SUBMISSION_RETRY_BASE_MS 로 간격을 줄인다', () => {
    expect(backoffDelays({ SUBMISSION_RETRY_BASE_MS: '0' })).toEqual([0, 0, 0]);
    expect(backoffDelays({ SUBMISSION_RETRY_BASE_MS: '10' })).toEqual([10, 20, 40]);
    expect(backoffDelays({ SUBMISSION_RETRY_BASE_MS: 'x' })).toEqual([500, 1000, 2000]);
  });
});

describe('Open311 요청', () => {
  it('form-urlencoded 필드', () => {
    const p = buildOpen311Form({ endpoint: 'http://localhost/v2', apiKey: 'k', jurisdictionId: 'j' }, { issue: issue('z', 'r'), form, photoUrl: 'http://localhost/api/photos/p1' });
    expect([...p.keys()].sort()).toEqual(['api_key', 'description', 'jurisdiction_id', 'lat', 'long', 'media_url', 'service_code']);
    expect(p.get('service_code')).toBe('streetlight');
    expect(p.get('lat')).toBe('37.5636');
    expect(p.get('long')).toBe('126.9976');
    expect(p.toString()).toContain('media_url=http%3A%2F%2Flocalhost%2Fapi%2Fphotos%2Fp1');
    expect(p.get('description')).toContain(form.body);
  });
});

describe('이메일 MIME', () => {
  it('제목·본문·첨부 1개가 파싱된다', async () => {
    const content = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3]);
    const raw = buildMime({ from: 'a@example.test', to: 'b@example.test', subject: '[2026-1110-0001] 가로등', text: '본문 내용\n.\n둘째 줄', attachment: { filename: 'p.jpg', contentType: 'image/jpeg', content }, messageId: 'm1@example.test' });
    expect(raw).not.toMatch(/[^\r]\n/);
    const mail = await simpleParser(raw);
    expect(mail.subject).toBe('[2026-1110-0001] 가로등');
    expect(mail.text?.trim()).toBe('본문 내용\n.\n둘째 줄');
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]!.contentType).toBe('image/jpeg');
    expect(new Uint8Array(mail.attachments[0]!.content)).toEqual(content);
  });
});

describe('가드 (C5)', () => {
  it('기본 → mock', () => {
    const s = selectAdapter(loadConfig({}));
    expect(s.adapter.name).toBe('mock');
    expect(s.live).toBe(false);
    expect(s.refused).toBeUndefined();
  });
  it('open311 + 확인 문구 없음 → mock, refused', () => {
    const s = selectAdapter(loadConfig({ SUBMISSION_ADAPTER: 'open311' }));
    expect(s.adapter.name).toBe('mock');
    expect(s.refused).toBe('open311');
  });
  it('DEMO_MODE=1 + 확인 문구 → mock, refused', () => {
    const s = selectAdapter(loadConfig({ DEMO_MODE: '1', SUBMISSION_ADAPTER: 'email', SUBMISSION_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE }));
    expect(s.adapter.name).toBe('mock');
    expect(s.refused).toBe('email');
  });
  it('createAdapter 는 가드를 거친 실제 구현을 준다', () => {
    expect(createAdapter(loadConfig({})).adapter).toBeInstanceOf(Open311Client);
    const live = createAdapter(loadConfig({ SUBMISSION_ADAPTER: 'email', SUBMISSION_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE, SMTP_URL: 'smtp://localhost:1' }));
    expect(live.adapter).toBeInstanceOf(EmailSender);
    expect(live.live).toBe(true);
  });
});
