import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { IssueByToken, Location, ReportResult } from '../../../src/shared/types.ts';

// full-flow.spec.ts 전용 헬퍼: 격리 서버 기동/종료, API 직접 호출, 화면 도우미.

export const PHOTOS = 'tests/e2e/fixtures/photos';
export const STREETLIGHT = join(PHOTOS, 'streetlight.jpg');
export const BENCH = join(PHOTOS, 'bench.jpg');
export const SHOT_DIR = process.env.ILLY_SHOT_DIR ?? 'test-results/screenshots';
// 상태 화면은 5초마다 다시 읽는다 — 한 주기 + 응답 시간 안에 바뀌어야 한다.
export const POLL_WINDOW = 7_000;
// 1x1 투명 PNG (지도 타일 대신)
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export const BANNED = /모델|분류기|지오코딩|API|LLM/;

export interface Proc { proc: ChildProcess; log: () => string }

export async function spawnAndWait(args: string[], env: NodeJS.ProcessEnv, ready: string): Promise<Proc> {
  const busy = await fetch(ready).then(() => true, () => false);
  if (busy) throw new Error(`port already in use: ${ready}`);
  let out = '';
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d) => (out += d));
  proc.stderr?.on('data', (d) => (out += d));
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(ready)).ok) return { proc, log: () => out };
    } catch {
      /* 기동 중 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`process did not start:\n${out}`);
}

/** SIGTERM 후 3초 안에 안 끝나면 SIGKILL. */
export async function stop(p: Proc | undefined): Promise<void> {
  if (!p || p.proc.exitCode !== null) return;
  const done = new Promise((r) => p.proc.once('exit', r));
  p.proc.kill('SIGTERM');
  const t = setTimeout(() => p.proc.kill('SIGKILL'), 3_000);
  await done;
  clearTimeout(t);
}

export const startApi = (env: NodeJS.ProcessEnv, port: number) =>
  spawnAndWait(['src/server/main.ts'], { ...env, PORT: String(port) }, `http://localhost:${port}/health`);

export const startVite = (webPort: number, apiPort: number, env: NodeJS.ProcessEnv) =>
  spawnAndWait(
    ['node_modules/vite/bin/vite.js', '--host', 'localhost', '--port', String(webPort), '--strictPort'],
    { ...env, API_PORT: String(apiPort), VITE_API_MODE: 'real' },
    `http://localhost:${webPort}/`,
  );

export function cleanEnv(): NodeJS.ProcessEnv {
  const base = { ...process.env };
  for (const k of ['VITE_VAPID_PUBLIC_KEY', 'SUBMISSION_ADAPTER', 'SUBMISSION_LIVE_CONFIRM', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'CLIENT_DIST_DIR', 'VISION_BACKEND', 'LLM_BASE_URL', 'LLM_API_KEY']) delete base[k];
  return base;
}

export async function byToken(api: string, token: string): Promise<IssueByToken> {
  const res = await fetch(`${api}/api/issues/by-token/${token}`);
  expect(res.ok).toBe(true);
  return (await res.json()) as IssueByToken;
}

export async function uploadPhoto(api: string, path: string, lat?: number, lng?: number): Promise<string> {
  const fd = new FormData();
  fd.append('file', new Blob([readFileSync(path)], { type: 'image/jpeg' }), 'p.jpg');
  if (lat !== undefined) fd.append('lat', String(lat));
  if (lng !== undefined) fd.append('lng', String(lng));
  const res = await fetch(`${api}/api/photos`, { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 사진 업로드 → 위치 → 신고. 좌표는 사진 폼 필드와 locate 에 같이 쓴다. */
export async function reportAt(api: string, lat: number, lng: number): Promise<ReportResult> {
  const photoId = await uploadPhoto(api, STREETLIGHT, lat, lng);
  const loc = await fetch(`${api}/api/locate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, facility: 'streetlight' }),
  });
  expect(loc.status).toBe(200);
  const res = await fetch(`${api}/api/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      photoId,
      facility: 'streetlight',
      fault: 'light_out',
      location: (await loc.json()) as Location,
      form: { title: '가로등 점등 불량 신고', body: '가로등이 꺼져 있어요. 확인 부탁드려요.', source: 'template' },
      reporterToken: `rt-${Math.random().toString(36).slice(2)}`,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as ReportResult;
}

export async function expectNoBannedWords(page: Page): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(BANNED);
}

export async function expectImageLoaded(page: Page, testid: string): Promise<void> {
  const img = page.getByTestId(testid);
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
}

export const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOT_DIR, name), fullPage: true });
