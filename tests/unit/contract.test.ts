import { describe, expect, it } from 'vitest';
import { FACILITIES, FACILITY_KO, FAULTS, FAULT_KO, ISSUE_STATUSES, STATUS_KO } from '../../src/shared/types.ts';
import { openDb, migrate } from '../../src/server/db/db.ts';
import { loadConfig } from '../../src/server/config.ts';
import { selectAdapter, LIVE_CONFIRM_PHRASE } from '../../src/server/submission/adapter.ts';

describe('한글 이름표', () => {
  it('모든 enum 키를 빠짐없이 가진다', () => {
    expect(Object.keys(FACILITY_KO).sort()).toEqual([...FACILITIES].sort());
    const faults = Object.values(FAULTS).flat();
    expect(Object.keys(FAULT_KO).sort()).toEqual([...faults].sort());
    expect(Object.keys(STATUS_KO).sort()).toEqual([...ISSUE_STATUSES].sort());
    for (const v of [...Object.values(FACILITY_KO), ...Object.values(FAULT_KO), ...Object.values(STATUS_KO)]) expect(v).toBeTruthy();
  });
});

describe('DB 마이그레이션', () => {
  it('6개 테이블·인덱스·user_version=1', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db); // 두 번 불러도 안전
    const names = (type: string) =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`).all(type) as Array<{ name: string }>).map((r) => r.name).sort();
    expect(names('table')).toEqual(['agency_requests', 'issues', 'photos', 'push_subscriptions', 'reports', 'submission_attempts']);
    const idx = db.prepare(`SELECT tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`).all() as Array<{ tbl_name: string; sql: string }>;
    const has = (tbl: string, col: string) => idx.some((i) => i.tbl_name === tbl && i.sql.includes(`(${col})`));
    expect(has('issues', 'h3')).toBe(true);
    expect(has('issues', 'status')).toBe(true);
    expect(has('reports', 'issue_id')).toBe(true);
    expect(has('photos', 'created_at')).toBe(true);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    const cols = (db.prepare('PRAGMA table_info(issues)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'receipt_no', 'status_token', 'facility', 'fault', 'lat', 'lng', 'h3', 'sig_code', 'sig_name', 'department', 'address_label', 'status', 'report_count', 'agency_ref', 'completion_photo_id', 'created_at', 'updated_at']);
    db.close();
  });
});

describe('selectAdapter 가드', () => {
  it('기본값은 mock', () => {
    const r = selectAdapter(loadConfig({}));
    expect(r.adapter.name).toBe('mock');
    expect(r.live).toBe(false);
    expect(r.refused).toBeUndefined();
  });
  it('open311 요청 + 확인 문구 없음 → mock + refused', () => {
    const r = selectAdapter(loadConfig({ SUBMISSION_ADAPTER: 'open311' }));
    expect(r.adapter.name).toBe('mock');
    expect(r.live).toBe(false);
    expect(r.refused).toBe('open311');
  });
  it('DEMO_MODE=1 이면 확인 문구가 있어도 mock', () => {
    const r = selectAdapter(loadConfig({ DEMO_MODE: '1', SUBMISSION_ADAPTER: 'email', SUBMISSION_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE }));
    expect(r.adapter.name).toBe('mock');
    expect(r.live).toBe(false);
    expect(r.refused).toBe('email');
  });
  it('확인 문구가 맞으면 live', () => {
    const r = selectAdapter(loadConfig({ SUBMISSION_ADAPTER: 'open311', SUBMISSION_LIVE_CONFIRM: LIVE_CONFIRM_PHRASE }));
    expect(r.adapter.name).toBe('open311');
    expect(r.live).toBe(true);
  });
});

describe('config 기본값', () => {
  it('§4.5 기본값', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      port: 8870,
      selfBaseUrl: 'http://localhost:8870',
      publicBaseUrl: 'http://localhost:8871',
      dataDir: './data/runtime',
      demoMode: false,
      allowTestRoutes: false,
      visionBackend: 'fixture',
      visionTimeoutMs: 15000,
      llmBackend: 'template',
      llmModel: 'qwen3.7-flash',
      llmBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      llmApiKey: '',
      llmTimeoutMs: 10000,
      geocoder: 'offline',
      nominatimUrl: 'https://nominatim.openstreetmap.org',
      mergeRadiusM: 20,
      submissionAdapter: 'mock',
      submissionLiveConfirm: '',
      vapidSubject: 'mailto:demo@example.com',
      photoTtlDays: 7,
      reportTtlDays: 30,
      sweepMinutes: 10,
    });
  });
});
