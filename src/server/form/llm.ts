import type { ComplaintForm } from '../../shared/types.ts';
import { templateForm, type FormInput } from './templates.ts';

export interface LlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export const BANNED = /모델|분류기|지오코딩|API|LLM/;
export const TITLE_MAX = 60;
export const BODY_MAX = 600;

/** LLM 결과 검사. 통과하면 null, 아니면 사유. */
export function checkLlmForm(f: { title: unknown; body: unknown }, addressLabel: string): string | null {
  if (typeof f.title !== 'string' || typeof f.body !== 'string') return 'type';
  const title = f.title.trim();
  const body = f.body.trim();
  if (!title || !body) return 'empty';
  if (title.length > TITLE_MAX || body.length > BODY_MAX) return 'length';
  if (BANNED.test(title) || BANNED.test(body)) return 'banned';
  if (!body.includes(addressLabel)) return 'address';
  return null;
}

export function parseLlmReply(text: unknown): { title: unknown; body: unknown } | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as unknown;
    return v && typeof v === 'object' ? (v as { title: unknown; body: unknown }) : null;
  } catch {
    return null;
  }
}

const SYSTEM = [
  '당신은 시민이 구청에 보내는 생활 불편 민원 문장을 다듬는다.',
  '주어진 초안을 바탕으로 공손한 한국어 민원 제목과 본문을 쓴다.',
  `제목은 ${TITLE_MAX}자 이하, 본문은 ${BODY_MAX}자 이하. 본문에는 초안의 주소를 그대로 포함한다.`,
  '신고자 이름·연락처는 쓰지 않는다. 기술 용어나 시스템 설명은 쓰지 않는다.',
  '반드시 JSON 객체 {"title": 문자열, "body": 문자열} 만 답한다.',
].join('\n');

export async function llmForm(input: FormInput, opt: LlmOptions, fetchImpl: typeof fetch = fetch): Promise<ComplaintForm> {
  const draft = templateForm(input);
  const fallback = (reason: string): ComplaintForm => {
    console.warn(`form llm degraded: ${reason}`);
    return draft;
  };
  let res: Response;
  try {
    res = await fetchImpl(`${opt.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opt.apiKey}` },
      body: JSON.stringify({
        model: opt.model,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `초안 제목: ${draft.title}\n초안 본문:\n${draft.body}` },
        ],
      }),
      signal: AbortSignal.timeout(opt.timeoutMs),
    });
  } catch (err) {
    return fallback(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!res.ok) return fallback(`status ${res.status}`);
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return fallback('bad body');
  }
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  const parsed = parseLlmReply(content);
  if (!parsed) return fallback('bad reply');
  const why = checkLlmForm(parsed, input.addressLabel);
  if (why) return fallback(`check ${why}`);
  return { title: (parsed.title as string).trim(), body: (parsed.body as string).trim(), source: 'llm' };
}
