import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateClassification, faultFits, unsupported } from '../../src/server/vision/types.ts';
import { parseVisionReply, classifyQwen, VISION_PROMPT } from '../../src/server/vision/qwen.ts';
import { classifyFixture } from '../../src/server/vision/fixture.ts';

const opt = { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm', timeoutMs: 200 };
const input = { bytes: new Uint8Array([0xff, 0xd8, 1, 2]), sha256: 'x', lat: null, lng: null };
const reply = (content: string, status = 200) =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;

describe('검증', () => {
  it('시설과 고장 짝을 검사한다', () => {
    expect(faultFits('streetlight', 'flicker')).toBe(true);
    expect(faultFits('streetlight', 'hole')).toBe(false);
    expect(faultFits('emergency', null)).toBe(true);
    expect(faultFits('unsupported', 'broken')).toBe(false);
  });
  it('enum 밖 값·범위 밖 신뢰도는 거부', () => {
    expect(validateClassification({ facility: 'tree', fault: null, confidence: 0.5 }, 'qwen')).toBeNull();
    expect(validateClassification({ facility: 'bench', fault: 'broken', confidence: 2 }, 'qwen')).toBeNull();
    expect(validateClassification('nope', 'qwen')).toBeNull();
  });
  it('잘못된 후보만 걸러낸다', () => {
    const c = validateClassification({ facility: 'bench', fault: 'broken', confidence: 0.8, candidates: [{ facility: 'bench', fault: 'hole', confidence: 0.1 }, { facility: 'bench', fault: 'graffiti', confidence: 0.1 }] }, 'qwen');
    expect(c?.candidates).toEqual([{ facility: 'bench', fault: 'graffiti', confidence: 0.1 }]);
    expect(c?.source).toBe('qwen');
  });
  it('unsupported 기본값', () => {
    expect(unsupported('qwen', 'vision_unavailable')).toEqual({ facility: 'unsupported', fault: null, confidence: 0, candidates: [], source: 'qwen', error: 'vision_unavailable' });
  });
});

describe('qwen 응답 파싱', () => {
  it('코드펜스 안 JSON 도 읽는다', () => {
    expect(parseVisionReply('```json\n{"facility":"sidewalk","fault":"hole","confidence":0.7,"candidates":[]}\n```')?.fault).toBe('hole');
  });
  it('깨진 JSON 은 null', () => {
    expect(parseVisionReply('{"facility": "bench",')).toBeNull();
    expect(parseVisionReply(undefined)).toBeNull();
  });
  it('프롬프트는 허용 시설을 나열한다', () => {
    for (const f of ['streetlight', 'bench', 'sidewalk', 'emergency', 'unsupported']) expect(VISION_PROMPT).toContain(f);
  });
});

describe('qwen 강등', () => {
  it('정상', async () => {
    const c = await classifyQwen(input, opt, reply('{"facility":"emergency","fault":null,"confidence":0.9,"candidates":[]}'));
    expect(c.facility).toBe('emergency');
    expect(c.error).toBeUndefined();
  });
  it('5xx', async () => {
    expect((await classifyQwen(input, opt, reply('', 503))).error).toBe('vision_unavailable');
  });
  it('깨진 응답', async () => {
    expect((await classifyQwen(input, opt, reply('not json'))).facility).toBe('unsupported');
  });
  it('네트워크 오류·타임아웃', async () => {
    const boom = (async () => { throw new Error('x'); }) as unknown as typeof fetch;
    expect((await classifyQwen(input, opt, boom)).error).toBe('vision_unavailable');
    const hang = ((_u: unknown, init: RequestInit) => new Promise((_r, rej) => init.signal?.addEventListener('abort', () => rej(init.signal?.reason)))) as unknown as typeof fetch;
    expect((await classifyQwen(input, { ...opt, timeoutMs: 20 }, hang)).error).toBe('vision_unavailable');
  });
});

describe('fixture', () => {
  const dir = 'tests/e2e/fixtures/vision';
  it('해시로 찾는다', () => {
    const bytes = readFileSync('tests/e2e/fixtures/photos/bench.jpg');
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(classifyFixture({ bytes, sha256: sha, lat: null, lng: null }, dir).facility).toBe('bench');
  });
  it('해시가 없으면 좌표로 찾는다', () => {
    expect(classifyFixture({ ...input, sha256: '0'.repeat(64), lat: 37.56631, lng: 126.97789 }, dir).facility).toBe('streetlight');
  });
  it('둘 다 없으면 unsupported', () => {
    expect(classifyFixture({ ...input, lat: 1, lng: 1 }, dir)).toEqual(unsupported('fixture'));
  });
});
