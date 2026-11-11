import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FACILITY_KO, FAULT_KO, FAULTS } from '../../src/shared/types.ts';
import { startFakeLlmText, type FakeLlmText } from './helpers/fake-llm-text.ts';

const API = `http://localhost:${process.env.API_PORT ?? process.env.PORT ?? 8870}`;
const QWEN_PORT = 8974;
const QWEN_BASE = `http://localhost:${QWEN_PORT}`;
const FAKE_PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 8874) + 200;
const KEY = 'test-key';
const ADDR = '서울 중구 부근 세종대로 110';
const input = (facility: string, fault: string | null) => ({ photoId: 'p-form', facility, fault, addressLabel: ADDR, department: '중구청 도로과' });
const pairs = (Object.keys(FAULTS) as Array<keyof typeof FAULTS>).flatMap((f) => FAULTS[f].map((t) => [f, t] as const));

test.describe.configure({ mode: 'serial' });

test.describe('템플릿 백엔드', () => {
  for (const [facility, fault] of pairs) {
    test(`${facility}/${fault} → 200`, async ({ request }) => {
      const res = await request.post(`${API}/api/form`, { data: input(facility, fault) });
      expect(res.status()).toBe(200);
      const f = await res.json();
      expect(f.source).toBe('template');
      expect(f.title.length).toBeGreaterThan(0);
      for (const s of [ADDR, FACILITY_KO[facility], FAULT_KO[fault]]) expect(f.body).toContain(s);
    });
  }

  test('가로등 점등 불량 본문', async ({ request }) => {
    const f = await (await request.post(`${API}/api/form`, { data: input('streetlight', 'light_out') })).json();
    expect(f.body).toContain('점등');
    expect(f.body).toContain('중구 부근');
  });

  test('응급·범위 밖 → 422', async ({ request }) => {
    for (const e of ['emergency', 'unsupported']) {
      const res = await request.post(`${API}/api/form`, { data: input(e, null) });
      expect(res.status()).toBe(422);
      expect(await res.json()).toEqual({ error: e });
    }
  });

  test('시설·고장 불일치, 필드 누락 → 400', async ({ request }) => {
    let res = await request.post(`${API}/api/form`, { data: input('bench', 'hole') });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_input' });
    res = await request.post(`${API}/api/form`, { data: { ...input('bench', 'broken'), addressLabel: '' } });
    expect(res.status()).toBe(400);
  });
});

test.describe('qwen 백엔드', () => {
  let proc: ChildProcess;
  let dir: string;
  let out = '';
  let fake: FakeLlmText;

  test.beforeAll(async () => {
    fake = await startFakeLlmText(FAKE_PORT);
    fake.setAddress(ADDR);
    dir = mkdtempSync(join(tmpdir(), 'civicshot-form-'));
    proc = spawn(process.execPath, ['src/server/main.ts'], {
      env: { ...process.env, PORT: String(QWEN_PORT), DATA_DIR: dir, LLM_BACKEND: 'qwen', LLM_BASE_URL: fake.url, LLM_API_KEY: KEY, LLM_TIMEOUT_MS: '3000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d) => (out += d));
    proc.stderr?.on('data', (d) => (out += d));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${QWEN_BASE}/health`)).ok) return;
      } catch { /* 기동 중 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server did not start:\n${out}`);
  });

  test.afterAll(async () => {
    if (proc && proc.exitCode === null) {
      const done = new Promise((r) => proc.once('exit', r));
      proc.kill();
      await done;
    }
    await fake?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const cases: Array<[Parameters<FakeLlmText['setMode']>[0], 'llm' | 'template']> = [
    ['error', 'template'],
    ['ok', 'llm'],
    ['banned', 'template'],
    ['broken', 'template'],
  ];
  for (const [mode, expected] of cases) {
    test(`응답 ${mode} → ${expected}`, async ({ request }) => {
      fake.setMode(mode);
      const before = fake.requests;
      const res = await request.post(`${QWEN_BASE}/api/form`, { data: input('streetlight', 'light_out') });
      expect(res.status()).toBe(200);
      const f = await res.json();
      expect(f.source).toBe(expected);
      expect(f.body).toContain(ADDR);
      expect(f.body).not.toMatch(/모델|분류기|지오코딩|API|LLM/);
      expect(fake.requests).toBe(before + 1);
    });
  }

  test('서버 로그에 키가 없다', () => {
    expect(out).not.toContain(KEY);
  });
});

test.describe('양식 요청 한도', () => {
  let proc: ChildProcess | undefined;
  let dir = '';
  let out = '';
  let fake: FakeLlmText;

  const start = async (env: Record<string, string>): Promise<void> => {
    out = '';
    dir = mkdtempSync(join(tmpdir(), 'civicshot-form-rl-'));
    proc = spawn(process.execPath, ['src/server/main.ts'], {
      env: { ...process.env, PORT: String(QWEN_PORT), DATA_DIR: dir, LLM_BASE_URL: fake.url, LLM_TIMEOUT_MS: '3000', RATE_LIMIT_PER_MINUTE: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d) => (out += d));
    proc.stderr?.on('data', (d) => (out += d));
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${QWEN_BASE}/health`)).ok) return;
      } catch { /* 기동 중 */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`server did not start:\n${out}`);
  };
  const stop = async (): Promise<void> => {
    if (proc && proc.exitCode === null) {
      const done = new Promise((r) => proc!.once('exit', r));
      proc.kill();
      await done;
    }
    proc = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  };

  test.beforeAll(async () => {
    fake = await startFakeLlmText(FAKE_PORT);
    fake.setAddress(ADDR);
    fake.setMode('ok');
  });
  test.afterEach(stop);
  test.afterAll(async () => {
    await stop();
    await fake?.close();
  });

  test('qwen: 한도 소진 시 템플릿 양식, 로그에 키·IP 없음', async ({ request }) => {
    await start({ LLM_BACKEND: 'qwen', LLM_API_KEY: KEY });
    const before = fake.requests;
    const first = await request.post(`${QWEN_BASE}/api/form`, { data: input('streetlight', 'light_out') });
    expect(first.status()).toBe(200);
    expect((await first.json()).source).toBe('llm');
    const second = await request.post(`${QWEN_BASE}/api/form`, { data: input('streetlight', 'light_out') });
    expect(second.status()).toBe(200);
    const f = await second.json();
    expect(f.source).toBe('template');
    const tpl = await (await request.post(`${API}/api/form`, { data: input('streetlight', 'light_out') })).json();
    expect(tpl.source).toBe('template');
    expect(f.body).toBe(tpl.body);
    expect(f.title).toBe(tpl.title);
    expect(fake.requests).toBe(before + 1);
    expect(out).toContain('form llm skipped: rate_limited scope=minute');
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/::1|::ffff:|\d+\.\d+\.\d+\.\d+/);
  });

  test('template 백엔드: 한도와 무관하게 3회 모두 템플릿', async ({ request }) => {
    await start({ LLM_BACKEND: 'template' });
    const before = fake.requests;
    for (let i = 0; i < 3; i++) {
      const res = await request.post(`${QWEN_BASE}/api/form`, { data: input('streetlight', 'light_out') });
      expect(res.status()).toBe(200);
      expect((await res.json()).source).toBe('template');
    }
    expect(fake.requests).toBe(before);
    expect(out).not.toContain('form llm skipped');
  });

  test('qwen: 422 요청은 한도를 소비하지 않는다', async ({ request }) => {
    await start({ LLM_BACKEND: 'qwen', LLM_API_KEY: KEY });
    for (const e of ['emergency', 'unsupported']) {
      const res = await request.post(`${QWEN_BASE}/api/form`, { data: input(e, null) });
      expect(res.status()).toBe(422);
    }
    const res = await request.post(`${QWEN_BASE}/api/form`, { data: input('streetlight', 'light_out') });
    expect(res.status()).toBe(200);
    expect((await res.json()).source).toBe('llm');
    expect(out).not.toContain('form llm skipped');
  });
});
