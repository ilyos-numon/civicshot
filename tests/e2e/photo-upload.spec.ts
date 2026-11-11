import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import exifr from 'exifr';
import type { Photo } from '../../src/shared/types.ts';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'photos');
const streetlight = readFileSync(join(FIXTURE_DIR, 'streetlight.jpg'));
const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
const API_PORT = Number(process.env.API_PORT ?? 8870);
const TEST_PORT = API_PORT + 100;

async function startServer(env: Record<string, string>): Promise<{ proc: ChildProcess; dir: string; base: string; port: number }> {
  const dir = mkdtempSync(join(tmpdir(), 'cs-photo-e2e-'));
  const port = Number(env.PORT);
  const proc = spawn(process.execPath, ['src/server/main.ts'], {
    env: { ...process.env, DATA_DIR: dir, ...env },
    stdio: 'ignore',
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return { proc, dir, base, port };
    } catch {
      // 아직 준비 안 됨
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error('server did not start');
}

async function stopServer(s: { proc: ChildProcess; dir: string }): Promise<void> {
  await new Promise<void>((resolve) => {
    if (s.proc.exitCode !== null) return resolve();
    s.proc.once('exit', () => resolve());
    s.proc.kill('SIGTERM');
  });
  rmSync(s.dir, { recursive: true, force: true });
}

test.describe('사진 업로드 서버', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let api: APIRequestContext;

  test.beforeAll(async () => {
    srv = await startServer({ PORT: String(TEST_PORT), ALLOW_TEST_ROUTES: '1' });
    api = await pwRequest.newContext({ baseURL: srv.base });
  });
  test.afterAll(async () => {
    await api?.dispose();
    if (srv) await stopServer(srv);
  });

  test('JPEG 업로드 → 201, 조회 시 메타데이터 없음', async () => {
    expect(typeof (await exifr.gps(streetlight))?.latitude).toBe('number');
    const res = await api.post('/api/photos', {
      multipart: {
        file: { name: 'streetlight.jpg', mimeType: 'image/jpeg', buffer: streetlight },
        lat: '37.5665',
        lng: '126.978',
        takenAt: '2026-11-10T01:02:03.000Z',
      },
    });
    expect(res.status()).toBe(201);
    const photo = (await res.json()) as Photo;
    expect(photo.lat).toBe(37.5665);
    expect(photo.lng).toBe(126.978);
    expect(photo.takenAt).toBe('2026-11-10T01:02:03.000Z');
    expect(photo.width).toBe(1280);
    expect(photo.height).toBe(960);
    expect(photo.purged).toBe(false);

    const got = await api.get(`/api/photos/${photo.id}`);
    expect(got.status()).toBe(200);
    expect(got.headers()['content-type']).toBe('image/jpeg');
    expect(got.headers()['cache-control']).toBe('no-store');
    const body = await got.body();
    expect(body.length).toBe(photo.bytes);
    expect(await exifr.parse(body)).toBeUndefined();
  });

  test('범위 밖 좌표는 비워 둔다', async () => {
    const res = await api.post('/api/photos', {
      multipart: { file: { name: 'a.jpg', mimeType: 'image/jpeg', buffer: streetlight }, lat: '123', lng: '10' },
    });
    expect(res.status()).toBe(201);
    const p = (await res.json()) as Photo;
    expect(p.lat).toBeNull();
    expect(p.lng).toBeNull();
  });

  test('JPEG 가 아니면 400', async () => {
    const res = await api.post('/api/photos', {
      multipart: { file: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') } },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_file' });
    const fake = await api.post('/api/photos', {
      multipart: { file: { name: 'b.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not really a jpeg') } },
    });
    expect(fake.status()).toBe(400);
  });

  test('5 MB 를 넘으면 400', async () => {
    const big = Buffer.concat([streetlight, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await api.post('/api/photos', {
      multipart: { file: { name: 'big.jpg', mimeType: 'image/jpeg', buffer: big } },
    });
    expect(res.status()).toBe(400);
    expect(await res.json()).toEqual({ error: 'unsupported_file' });
  });

  test('없는 사진은 404, 보존 기간이 지나면 410', async () => {
    expect((await api.get('/api/photos/nope')).status()).toBe(404);
    const up = await api.post('/api/photos', {
      multipart: { file: { name: 's.jpg', mimeType: 'image/jpeg', buffer: streetlight } },
    });
    const p = (await up.json()) as Photo;
    expect((await api.get(`/api/photos/${p.id}`)).status()).toBe(200);
    const now = new Date(Date.now() + 8 * 86_400_000).toISOString();
    const sw = await api.post('/api/_test/sweep', { data: { now } });
    expect(sw.status()).toBe(200);
    expect(((await sw.json()) as { photosPurged: number }).photosPurged).toBeGreaterThanOrEqual(1);
    expect((await api.get(`/api/photos/${p.id}`)).status()).toBe(410);

    const reset = await api.post('/api/_test/reset');
    expect(reset.status()).toBe(200);
    expect((await api.get(`/api/photos/${p.id}`)).status()).toBe(404);
  });
});

test('테스트 전용 경로는 기본으로 닫혀 있다', async () => {
  const srv = await startServer({ PORT: String(TEST_PORT + 1), ALLOW_TEST_ROUTES: '0' });
  try {
    const res = await fetch(`${srv.base}/api/_test/sweep`, { method: 'POST' });
    expect(res.status).toBe(404);
  } finally {
    await stopServer(srv);
  }
});

test('브라우저에서 위치를 읽고 메타데이터 없이 다시 압축한다', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async (bytes) => {
    const spec = '/src/client/lib/photo.ts';
    const mod = (await import(spec)) as typeof import('../../src/client/lib/photo.ts');
    const file = new File([new Uint8Array(bytes)], 'streetlight.jpg', { type: 'image/jpeg' });
    const meta = await mod.extractPhotoMeta(file);
    const out = await mod.reencode(file);
    const bmp = await createImageBitmap(out);
    const outBytes = [...new Uint8Array(await out.arrayBuffer())];
    const noGps = await mod.extractPhotoMeta(out);
    return { meta, type: out.type, size: out.size, w: bmp.width, h: bmp.height, outBytes, noGps };
  }, [...streetlight]);
    expect(result.meta.lat!).toBeGreaterThan(37);
  expect(result.meta.lng!).toBeGreaterThan(126);
  expect(result.type).toBe('image/jpeg');
  expect(Math.max(result.w, result.h)).toBeLessThanOrEqual(1600);
  expect(await exifr.parse(Buffer.from(result.outBytes))).toBeUndefined();
  expect(result.noGps).toEqual({ lat: null, lng: null, takenAt: null });
  await page.screenshot({ path: join(SHOT_DIR, 's4-photo-reencode.png') });
});
