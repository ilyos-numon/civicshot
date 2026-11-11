import { test, expect, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeLlm, type FakeLlm } from './helpers/fake-llm.ts';

const PORT = 8976;
const FAKE_PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 8876) + 200;
const BASE = `http://localhost:${PORT}`;
const PHOTOS = 'tests/e2e/fixtures/photos';
const FAKE_KEY = 'sk-fake-e2e-secret-0123456789';

test.describe.configure({ mode: 'serial' });

interface Srv { proc: ChildProcess; dir: string; log: () => string }

async function startServer(extra: Record<string, string>): Promise<Srv> {
  const dir = mkdtempSync(join(tmpdir(), 'civicshot-classify-'));
  let out = '';
  const proc = spawn(process.execPath, ['src/server/main.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, ALLOW_TEST_ROUTES: '1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (out += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return { proc, dir, log: () => out };
    } catch { /* 아직 기동 중 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`server did not start:\n${out}`);
}

async function stopServer(s: Srv | undefined): Promise<void> {
  if (!s) return;
  if (s.proc.exitCode === null) {
    const done = new Promise((r) => s.proc.once('exit', r));
    s.proc.kill();
    await done;
  }
  rmSync(s.dir, { recursive: true, force: true });
}

/** S4 업로드 라우트 대신 DB 행과 파일을 직접 넣는다. */
function seed(s: Srv, id: string, bytes: Buffer, lat: number | null, lng: number | null, purged = 0): void {
  mkdirSync(join(s.dir, 'photos'), { recursive: true });
  const rel = join('photos', `${id}.jpg`);
  writeFileSync(join(s.dir, rel), bytes);
  const db = new DatabaseSync(join(s.dir, 'civicshot.db'));
  db.prepare('INSERT INTO photos (id, path, lat, lng, sha256, bytes, created_at, purged) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, rel, lat, lng, 'stale', bytes.length, new Date().toISOString(), purged);
  db.close();
}

const post = (r: APIRequestContext, photoId: string) => r.post(`${BASE}/api/classify`, { data: { photoId } });
const photo = (n: string) => readFileSync(join(PHOTOS, `${n}.jpg`));
const COORD: Record<string, [number, number]> = { streetlight: [37.5663, 126.9779], bench: [37.5512, 126.9882], sidewalk: [37.5796, 126.977] };

test.describe('fixture 백엔드', () => {
  let s: Srv;
  test.beforeAll(async () => { s = await startServer({ VISION_BACKEND: 'fixture' }); });
  test.afterAll(async () => { await stopServer(s); });

  for (const name of ['streetlight', 'bench', 'sidewalk'] as const) {
    test(`${name} 사진은 정확한 시설로 분류된다`, async ({ request }) => {
      seed(s, `p-${name}`, photo(name), ...COORD[name]);
      const res = await post(request, `p-${name}`);
      expect(res.status()).toBe(200);
      const body = await res.json();
      expect(body.facility).toBe(name);
      expect(body.source).toBe('fixture');
      expect(body.confidence).toBeGreaterThan(0.5);
    });
  }

  test('재압축으로 해시가 달라져도 좌표로 찾는다', async ({ request }) => {
    const bytes = Buffer.concat([photo('sidewalk'), Buffer.from([0, 1, 2, 3])]);
    seed(s, 'p-recomp', bytes, 37.57960001, 126.97699998);
    const body = await (await post(request, 'p-recomp')).json();
    expect(body.facility).toBe('sidewalk');
    expect(body.fault).toBe('broken_block');
  });

  test('GPS 없는 모르는 사진은 unsupported', async ({ request }) => {
    seed(s, 'p-nogps', photo('nogps'), null, null);
    const res = await post(request, 'p-nogps');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ facility: 'unsupported', fault: null, confidence: 0, candidates: [], source: 'fixture' });
  });

  test('없는 photoId 는 404, 파기된 사진은 410', async ({ request }) => {
    const res = await post(request, 'nope');
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    seed(s, 'p-purged', photo('bench'), null, null, 1);
    expect((await post(request, 'p-purged')).status()).toBe(410);
  });
});

test.describe('qwen 백엔드 (가짜 서버)', () => {
  let s: Srv;
  let fake: FakeLlm;
  test.beforeAll(async () => {
    fake = await startFakeLlm(FAKE_PORT);
    s = await startServer({ VISION_BACKEND: 'qwen', LLM_BASE_URL: fake.url, LLM_API_KEY: FAKE_KEY, VISION_MODEL: 'fake-vl', VISION_TIMEOUT_MS: '3000' });
    // 샘플 우선 처리 이후: 샘플 해시·좌표가 아니어야 외부 호출 경로를 탄다.
    seed(s, 'q1', Buffer.concat([photo('bench'), Buffer.from([9, 9])]), 37.5601, 126.9801);
  });
  test.afterAll(async () => {
    const log = s?.log() ?? '';
    await stopServer(s);
    await fake?.close();
    expect(log).not.toContain(FAKE_KEY);
    expect(log).not.toContain('base64');
    expect(log).not.toContain('37.5512');
  });

  test('정상 JSON → 분류 성공', async ({ request }) => {
    fake.setMode('ok');
    const body = await (await post(request, 'q1')).json();
    expect(body).toMatchObject({ facility: 'bench', fault: 'graffiti', source: 'qwen' });
    expect(body.error).toBeUndefined();
  });

  test('500 → vision_unavailable 로 강등, 200 유지', async ({ request }) => {
    fake.setMode('error');
    const res = await post(request, 'q1');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ facility: 'unsupported', fault: null, confidence: 0, candidates: [], source: 'qwen', error: 'vision_unavailable' });
  });

  test('깨진 JSON → vision_unavailable', async ({ request }) => {
    fake.setMode('broken');
    expect((await (await post(request, 'q1')).json()).error).toBe('vision_unavailable');
  });

  test('응급 JSON → emergency 그대로', async ({ request }) => {
    fake.setMode('emergency');
    const body = await (await post(request, 'q1')).json();
    expect(body.facility).toBe('emergency');
    expect(body.fault).toBeNull();
  });

  test('서버 로그에 키가 없다', async () => {
    expect(fake.requests).toBeGreaterThanOrEqual(4);
    expect(s.log()).not.toContain(FAKE_KEY);
  });
});

test.describe('요청 제한·샘플 우선', () => {
  const OTHER: [number, number] = [37.5601, 126.9801]; // 서울 중구, 샘플 아님
  const qwenEnv = (extra: Record<string, string>): Record<string, string> => ({
    VISION_BACKEND: 'qwen', LLM_BASE_URL: `http://localhost:${FAKE_PORT}/v1`, LLM_API_KEY: FAKE_KEY, VISION_MODEL: 'fake-vl', VISION_TIMEOUT_MS: '3000',
    RATE_LIMIT_PER_MINUTE: '0', RATE_LIMIT_PER_DAY: '0', RATE_LIMIT_DAILY_TOTAL: '0', TRUSTED_PROXY_HOPS: '0', ...extra,
  });
  let s: Srv | undefined;
  let fake: FakeLlm | undefined;

  async function boot(env: Record<string, string>): Promise<{ s: Srv; fake: FakeLlm }> {
    fake = await startFakeLlm(FAKE_PORT);
    s = await startServer(env);
    return { s, fake };
  }
  test.afterEach(async () => {
    await stopServer(s);
    await fake?.close();
    s = undefined;
    fake = undefined;
  });

  async function upload(r: APIRequestContext, name: string, at: [number, number]): Promise<string> {
    const res = await r.post(`${BASE}/api/photos`, {
      multipart: { file: { name: `${name}.jpg`, mimeType: 'image/jpeg', buffer: photo(name) }, lat: String(at[0]), lng: String(at[1]) },
    });
    expect(res.status()).toBe(201);
    return (await res.json()).id as string;
  }
  const cls = (r: APIRequestContext, photoId: string, xff?: string) =>
    r.post(`${BASE}/api/classify`, { data: { photoId }, headers: xff ? { 'X-Forwarded-For': xff } : {} });

  test('분 한도: 2회 후 3번째는 429, 가짜 서버는 2회만', async ({ request }) => {
    const { fake } = await boot(qwenEnv({ RATE_LIMIT_PER_MINUTE: '2' }));
    const id = await upload(request, 'bench', OTHER);
    for (let i = 0; i < 2; i++) expect((await cls(request, id)).status()).toBe(200);
    const res = await cls(request, id);
    expect(res.status()).toBe(429);
    const ra = Number(res.headers()['retry-after']);
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThanOrEqual(60);
    const body = await res.json();
    expect(body).toEqual({ error: 'rate_limited', scope: 'minute', retryAfterSec: expect.any(Number) });
    expect(fake.requests).toBe(2);
  });

  test('일 한도: 1회 후 day 로 거부', async ({ request }) => {
    const { fake } = await boot(qwenEnv({ RATE_LIMIT_PER_DAY: '1' }));
    const id = await upload(request, 'bench', OTHER);
    expect((await cls(request, id)).status()).toBe(200);
    const res = await cls(request, id);
    expect(res.status()).toBe(429);
    expect((await res.json()).scope).toBe('day');
    expect(fake.requests).toBe(1);
  });

  test('전체 한도: 다른 IP 도 total 로 거부', async ({ request }) => {
    const { fake } = await boot(qwenEnv({ RATE_LIMIT_DAILY_TOTAL: '1', TRUSTED_PROXY_HOPS: '1' }));
    const id = await upload(request, 'bench', OTHER);
    expect((await cls(request, id, '2001:db8::a')).status()).toBe(200);
    const res = await cls(request, id, '2001:db8::b');
    expect(res.status()).toBe(429);
    expect((await res.json()).scope).toBe('total');
    expect(fake.requests).toBe(1);
  });

  test('fixture 모드는 제한 설정이 있어도 무제한', async ({ request }) => {
    await boot({ VISION_BACKEND: 'fixture', RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_PER_DAY: '1', RATE_LIMIT_DAILY_TOTAL: '1' });
    const id = await upload(request, 'bench', COORD.bench);
    for (let i = 0; i < 4; i++) {
      const res = await cls(request, id);
      expect(res.status()).toBe(200);
      expect((await res.json()).source).toBe('fixture');
    }
  });

  test('샘플 5회는 외부 호출 없이 fixture, 이어서 비샘플은 qwen 후 한도', async ({ request }) => {
    const { fake } = await boot(qwenEnv({ RATE_LIMIT_PER_MINUTE: '1' }));
    const sid = await upload(request, 'bench', COORD.bench);
    for (let i = 0; i < 5; i++) {
      const res = await cls(request, sid);
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ facility: 'bench', source: 'fixture' });
    }
    expect(fake.requests).toBe(0);
    const oid = await upload(request, 'bench', OTHER);
    const ok = await cls(request, oid);
    expect(ok.status()).toBe(200);
    expect((await ok.json()).source).toBe('qwen');
    expect(fake.requests).toBe(1);
    expect((await cls(request, oid)).status()).toBe(429);
    expect((await cls(request, sid)).status()).toBe(200); // 샘플은 한도 뒤에도 된다
    expect(fake.requests).toBe(1);
  });

  test('샘플 좌표에서 +0.0001 벗어나면 qwen 으로 간다', async ({ request }) => {
    const { fake } = await boot(qwenEnv({}));
    const id = await upload(request, 'bench', [COORD.bench[0] + 0.0001, COORD.bench[1]]);
    const res = await cls(request, id);
    expect((await res.json()).source).toBe('qwen');
    expect(fake.requests).toBe(1);
  });

  test('hops 0 에서는 X-Forwarded-For 를 바꿔도 우회 못 한다', async ({ request }) => {
    const { fake } = await boot(qwenEnv({ RATE_LIMIT_PER_MINUTE: '1' }));
    const id = await upload(request, 'bench', OTHER);
    expect((await cls(request, id, '2001:db8::a')).status()).toBe(200);
    expect((await cls(request, id, '2001:db8::b')).status()).toBe(429);
    expect((await cls(request, id, '2001:db8::c')).status()).toBe(429);
    expect(fake.requests).toBe(1);
  });

  test('hops 1 은 XFF 오른쪽 값으로 센다 (왼쪽 위조 무시)', async ({ request }) => {
    const { fake } = await boot(qwenEnv({ RATE_LIMIT_PER_MINUTE: '1', TRUSTED_PROXY_HOPS: '1' }));
    const id = await upload(request, 'bench', OTHER);
    expect((await cls(request, id, '2001:db8::1, 2001:db8::a')).status()).toBe(200);
    expect((await cls(request, id, '2001:db8::2, 2001:db8::a')).status()).toBe(429);
    expect((await cls(request, id, '2001:db8::3, 2001:db8::a')).status()).toBe(429);
    expect((await cls(request, id, '2001:db8::a, 2001:db8::b')).status()).toBe(200);
    expect(fake.requests).toBe(2);
  });

  test('로그 한 줄: 결과만 남고 좌표·키·IP 는 없다', async ({ request }) => {
    const { s } = await boot(qwenEnv({ TRUSTED_PROXY_HOPS: '1' }));
    const id = await upload(request, 'bench', OTHER);
    expect((await cls(request, id, '2001:db8::a')).status()).toBe(200);
    const sid = await upload(request, 'bench', COORD.bench);
    expect((await cls(request, sid, '2001:db8::a')).status()).toBe(200);
    const log = s.log();
    expect(log).toMatch(/classify facility=bench fault=graffiti confidence=0\.81 source=qwen error=- sample=false ms=\d+/);
    expect(log).toMatch(/classify facility=bench fault=\S+ confidence=\d\.\d\d source=fixture error=- sample=true ms=\d+/);
    expect(log).not.toContain(FAKE_KEY);
    expect(log).not.toContain('2001:db8');
    expect(log).not.toContain(id);
    for (const v of [...OTHER, ...COORD.bench]) expect(log).not.toContain(String(v));
  });

  test('가짜 서버 500 → 로그에 상태·본문 요약, 응답은 200 vision_unavailable', async ({ request }) => {
    const { s, fake } = await boot(qwenEnv({}));
    fake.setMode('error');
    const id = await upload(request, 'bench', OTHER);
    const res = await cls(request, id);
    expect(res.status()).toBe(200);
    expect((await res.json()).error).toBe('vision_unavailable');
    const log = s.log();
    expect(log).toContain('vision qwen degraded: status 500 {"error":"fake"}');
    expect(log).toMatch(/classify facility=unsupported fault=null confidence=0\.00 source=qwen error=vision_unavailable sample=false/);
    expect(log).not.toContain('base64');
    expect(log).not.toContain(FAKE_KEY);
  });
});
