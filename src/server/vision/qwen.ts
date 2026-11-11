import { FAULTS, type Classification } from '../../shared/types.ts';
import { unsupported, validateClassification, type VisionInput } from './types.ts';

export interface QwenVisionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export const DEFAULT_VISION_MODEL = 'qwen3-vl-flash';

export const VISION_PROMPT = [
  'You classify a citizen photo of public infrastructure.',
  'Answer with ONLY a JSON object: {"facility": F, "fault": T, "confidence": 0..1, "candidates": [{"facility": F, "fault": T, "confidence": 0..1}]}.',
  'F must be one of: "streetlight", "bench", "sidewalk", "emergency", "unsupported".',
  `Allowed faults per facility: streetlight ${JSON.stringify(FAULTS.streetlight)}, bench ${JSON.stringify(FAULTS.bench)}, sidewalk ${JSON.stringify(FAULTS.sidewalk)}.`,
  'Use "emergency" with fault null for fire, injured people, gas leak, collapse or other immediate danger.',
  'Use "unsupported" with fault null for anything else. No other values, no prose.',
].join('\n');

function detectMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

/** 모델 응답 텍스트 → Classification. 코드펜스 허용, 실패 시 null. */
export function parseVisionReply(text: unknown): Classification | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return validateClassification(JSON.parse(m[0]), 'qwen');
  } catch {
    return null;
  }
}

export async function classifyQwen(input: VisionInput, opt: QwenVisionOptions, fetchImpl: typeof fetch = fetch): Promise<Classification> {
  const fail = (reason: string): Classification => {
    console.warn(`vision qwen degraded: ${reason}`);
    return unsupported('qwen', 'vision_unavailable');
  };
  const dataUrl = `data:${detectMime(input.bytes)};base64,${Buffer.from(input.bytes).toString('base64')}`;
  let res: Response;
  try {
    res = await fetchImpl(`${opt.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opt.apiKey}` },
      body: JSON.stringify({
        model: opt.model || DEFAULT_VISION_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: VISION_PROMPT },
          { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: 'Classify this photo.' }] },
        ],
      }),
      signal: AbortSignal.timeout(opt.timeoutMs),
    });
  } catch (err) {
    return fail(err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return fail(`status ${res.status} ${text.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return fail('bad body');
  }
  const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
  return parseVisionReply(content) ?? fail('bad reply');
}
