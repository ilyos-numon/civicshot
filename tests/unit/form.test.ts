import { describe, expect, it } from 'vitest';
import { FACILITY_KO, FAULT_KO, FAULTS } from '../../src/shared/types.ts';
import { buildForm, checkLlmForm, isValidPair } from '../../src/server/form/index.ts';
import { llmForm } from '../../src/server/form/llm.ts';

const ADDR = '서울 중구 세종대로 부근';
const DEPT = '중구청 도로과';
const pairs = (Object.keys(FAULTS) as Array<keyof typeof FAULTS>).flatMap((f) => FAULTS[f].map((t) => [f, t] as const));

describe('템플릿', () => {
  it('9개 조합', () => expect(pairs).toHaveLength(9));
  for (const [facility, fault] of pairs) {
    it(`${facility}/${fault}`, () => {
      const f = buildForm({ facility, fault, addressLabel: ADDR, department: DEPT });
      expect(f.source).toBe('template');
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.title.length).toBeLessThanOrEqual(60);
      expect(f.body.length).toBeLessThanOrEqual(600);
      for (const s of [ADDR, DEPT, FACILITY_KO[facility], FAULT_KO[fault], '사진을 첨부했습니다']) expect(f.body).toContain(s);
      expect(f.body).not.toMatch(/모델|분류기|지오코딩|API|LLM/);
      expect(checkLlmForm(f, ADDR)).toBeNull();
    });
  }
  it('가로등 근거 문장', () => {
    expect(buildForm({ facility: 'streetlight', fault: 'light_out', addressLabel: ADDR, department: DEPT }).body).toContain('야간 보행 안전');
  });
  it('조합 검사', () => {
    expect(isValidPair('bench', 'graffiti')).toBe(true);
    expect(isValidPair('bench', 'hole')).toBe(false);
    expect(isValidPair('emergency', null)).toBe(false);
    expect(isValidPair('toString', 'x')).toBe(false);
  });
});

describe('LLM 결과 검사', () => {
  const ok = { title: '가로등 점등 불량 신고', body: `${ADDR} 가로등이 꺼져 있습니다.` };
  it('정상 통과', () => expect(checkLlmForm(ok, ADDR)).toBeNull());
  it('금칙어', () => {
    for (const w of ['모델', '분류기', '지오코딩', 'API', 'LLM']) expect(checkLlmForm({ ...ok, body: `${ok.body} ${w}` }, ADDR)).toBe('banned');
  });
  it('길이 제한', () => {
    expect(checkLlmForm({ ...ok, title: '가'.repeat(61) }, ADDR)).toBe('length');
    expect(checkLlmForm({ ...ok, title: '가'.repeat(60) }, ADDR)).toBeNull();
    expect(checkLlmForm({ ...ok, body: ok.body + '가'.repeat(600) }, ADDR)).toBe('length');
  });
  it('주소 누락·빈 값', () => {
    expect(checkLlmForm({ ...ok, body: '가로등이 꺼져 있습니다.' }, ADDR)).toBe('address');
    expect(checkLlmForm({ title: '', body: ok.body }, ADDR)).toBe('empty');
    expect(checkLlmForm({ title: 1, body: ok.body }, ADDR)).toBe('type');
  });
});

describe('llmForm 대체', () => {
  const input = { facility: 'streetlight' as const, fault: 'light_out' as const, addressLabel: ADDR, department: DEPT };
  const opt = { baseUrl: 'http://localhost:1', apiKey: 'k', model: 'm', timeoutMs: 200 };
  const reply = (content: string, status = 200) =>
    (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })) as unknown as typeof fetch;
  it('정상 → llm', async () => {
    const f = await llmForm(input, opt, reply(JSON.stringify({ title: 't', body: `${ADDR} 확인 부탁드립니다.` })));
    expect(f.source).toBe('llm');
  });
  it('5xx·깨진 JSON·금칙어 → template', async () => {
    expect((await llmForm(input, opt, reply('{}', 500))).source).toBe('template');
    expect((await llmForm(input, opt, reply('{"title":'))).source).toBe('template');
    expect((await llmForm(input, opt, reply(JSON.stringify({ title: 't', body: `${ADDR} LLM` })))).source).toBe('template');
  });
});
