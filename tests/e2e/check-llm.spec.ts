import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { startFakeLlm, type FakeLlm } from './helpers/fake-llm.ts';

const FAKE_PORT = 8990;

test.describe.configure({ mode: 'serial' });

let llm: FakeLlm;
test.beforeAll(async () => { llm = await startFakeLlm(FAKE_PORT); });
test.afterAll(async () => { await llm?.close(); });

function run(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(process.execPath, ['scripts/check-llm.ts'], {
      env: { ...process.env, LLM_BASE_URL: llm.url, LLM_API_KEY: 'test-key', LLM_MODEL: 'fake-text', VISION_MODEL: 'fake-vision', CHECK_TIMEOUT_MS: '5000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, out }));
  });
}

test('ok 모드: exit 0, 사진 3줄, 비밀 없음', async () => {
  llm.setMode('ok');
  const { code, out } = await run();
  expect(code, out).toBe(0);
  expect(out.match(/^\[사진\]/gm)).toHaveLength(3);
  expect(out).toContain('bench');
  for (const s of ['test-key', 'base64', 'data:image', 'reasoning']) expect(out).not.toContain(s);
});

test('no_image 모드: exit 1, 사진 미지원 결론', async () => {
  llm.setMode('no_image');
  const { code, out } = await run();
  expect(code, out).toBe(1);
  expect(out).toMatch(/\[결론\].*사진을 받지 못하는 것 같아요/);
});
