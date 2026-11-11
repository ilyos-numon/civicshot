import { describe, expect, it } from 'vitest';
import { runCheck, formatReport, type CheckEnv } from '../../scripts/check-llm.ts';

const KEY = 'sk-unit-secret-abcdef123456';
const env: CheckEnv = { baseUrl: 'http://localhost:1/v1', apiKey: KEY, llmModel: 'tm', visionModel: 'vm', timeoutMs: 1000, samplesDir: 'public/samples' };
const good = JSON.stringify({ facility: 'bench', fault: 'graffiti', confidence: 0.81, candidates: [] });
const okRes = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: 'think' } }] }), { status: 200 });

type Handler = (body: string) => Response | Promise<Response>;
const fake = (h: Handler) => (async (_u: unknown, init?: RequestInit) => h(String(init?.body ?? ''))) as unknown as typeof fetch;

describe('check-llm', () => {
  it('모두 성공하면 ok true, 사진 3줄', async () => {
    const r = await runCheck(env, fake(() => okRes(good)));
    expect(r.ok).toBe(true);
    const out = formatReport(r);
    expect(out.match(/^\[사진\]/gm)).toHaveLength(3);
    expect(out).toContain('판정 bench/graffiti 신뢰도 0.81');
  });

  it('사진 400 이미지 미지원 → 결론 안내, ok false', async () => {
    const r = await runCheck(env, fake((b) => b.includes('image_url')
      ? new Response('{"error":{"message":"this model does not support image input","type":"invalid_request_error"}}', { status: 400 })
      : okRes('{"ok":true}')));
    expect(r.ok).toBe(false);
    expect(r.verdict.join()).toContain('사진을 받지 못하는 것 같아요');
  });

  it('네트워크 오류는 status null', async () => {
    const r = await runCheck(env, (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.calls.every((c) => c.status === null)).toBe(true);
    expect(formatReport(r)).toContain('HTTP -');
  });

  it('키·data URL·reasoning 은 출력에 없다', async () => {
    const r = await runCheck(env, fake((b) => new Response(`bad key ${KEY} echo ${b}`, { status: 401 })));
    const out = formatReport(r);
    expect(out).not.toContain(KEY);
    expect(out).toContain('***');
    expect(out).not.toMatch(/base64|data:image|reasoning/);
    for (const l of out.split('\n')) expect(l.length).toBeLessThan(500);
  });

  it('느린 응답 → 타임아웃 권고', async () => {
    const realNow = Date.now;
    let t = 0;
    Date.now = () => t;
    try {
      const r = await runCheck(env, fake((b) => { t += b.includes('image_url') ? 14000 : 9000; return okRes(good); }));
      expect(r.verdict.join()).toMatch(/응답이 느려요. 타임아웃을 \d+ms 로 올리세요/);
    } finally {
      Date.now = realNow;
    }
  });

  it('샘플이 unsupported → 실제 사진 안내', async () => {
    const r = await runCheck(env, fake(() => okRes(JSON.stringify({ facility: 'unsupported', fault: null, confidence: 0.4, candidates: [] }))));
    expect(r.verdict.join()).toContain('실제 사진 한 장으로');
  });

  it('키가 비면 바로 실패', async () => {
    const r = await runCheck({ ...env, apiKey: '' }, fake(() => okRes(good)));
    expect(r.ok).toBe(false);
    expect(formatReport(r)).toBe('[결론] LLM_API_KEY 가 비어 있어요');
  });
});
