// 실행: node --env-file=.env scripts/check-llm.ts [사진경로]
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEFAULT_VISION_MODEL, VISION_PROMPT, parseVisionReply } from '../src/server/vision/qwen.ts';

export interface CheckEnv { baseUrl: string; apiKey: string; llmModel: string; visionModel: string; timeoutMs: number; samplesDir: string }
export interface CallReport { kind: 'text' | 'image'; model: string; file?: string; status: number | null; ms: number; parsed: boolean; facility?: string; fault?: string | null; confidence?: number; errorSummary?: string }
export interface CheckReport { calls: CallReport[]; verdict: string[]; ok: boolean }

const SAMPLES = ['streetlight.jpg', 'bench.jpg', 'sidewalk.jpg'];
const MAX = 300;
let secret = '';

function clean(s: string): string {
  let out = s;
  if (secret) out = out.split(secret).join('***');
  out = out.replace(/data:[^"\s,]*;base64,[A-Za-z0-9+/=]*/g, '[data]').replace(/"reasoning_content"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"[생략]"');
  return out.length > MAX ? out.slice(0, MAX) : out;
}

function mime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

function numEnv(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

interface Raw { status: number | null; ms: number; content: unknown; error?: string }

async function call(env: CheckEnv, body: unknown, fetchImpl: typeof fetch): Promise<Raw> {
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${env.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(env.timeoutMs),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { status: res.status, ms, content: null, error: text || `HTTP ${res.status}` };
    try {
      const j = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown } }> };
      return { status: res.status, ms, content: j?.choices?.[0]?.message?.content };
    } catch {
      return { status: res.status, ms, content: null, error: '응답 본문이 JSON 이 아니에요' };
    }
  } catch (err) {
    const ms = Date.now() - t0;
    const e = err as Error;
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `시간 초과(${env.timeoutMs}ms)` : `네트워크 오류: ${e?.message ?? String(err)}`;
    return { status: null, ms, content: null, error: why };
  }
}

async function textCall(env: CheckEnv, model: string, f: typeof fetch): Promise<CallReport> {
  const r = await call(env, {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: 'Reply with ONLY this JSON object: {"ok":true}' }],
  }, f);
  let parsed = false;
  if (typeof r.content === 'string') {
    const m = r.content.match(/\{[\s\S]*\}/);
    try { parsed = !!m && typeof JSON.parse(m[0]) === 'object'; } catch { parsed = false; }
  }
  const rep: CallReport = { kind: 'text', model, status: r.status, ms: r.ms, parsed };
  if (r.error) rep.errorSummary = clean(r.error);
  else if (!parsed) rep.errorSummary = '응답이 JSON 이 아니에요';
  return rep;
}

async function imageCall(env: CheckEnv, path: string, f: typeof fetch): Promise<CallReport> {
  const bytes = new Uint8Array(readFileSync(path));
  const url = `data:${mime(bytes)};base64,${Buffer.from(bytes).toString('base64')}`;
  const r = await call(env, {
    model: env.visionModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: VISION_PROMPT },
      { role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: 'Classify this photo.' }] },
    ],
  }, f);
  const c = r.content == null ? null : parseVisionReply(r.content);
  const rep: CallReport = { kind: 'image', model: env.visionModel, file: basename(path), status: r.status, ms: r.ms, parsed: !!c };
  if (c) { rep.facility = c.facility; rep.fault = c.fault; rep.confidence = c.confidence; }
  if (r.error) rep.errorSummary = clean(r.error);
  else if (!c) rep.errorSummary = '분류 응답 형식이 맞지 않아요';
  return rep;
}

function recommend(ms: number): number {
  return Math.ceil((ms * 2) / 5000) * 5000;
}

/** 진단 실행. photos 를 주면 샘플 대신 그 파일들로 사진 시험. */
export async function runCheck(env: CheckEnv, fetchImpl: typeof fetch = fetch, photos?: string[]): Promise<CheckReport> {
  secret = env.apiKey;
  const verdict: string[] = [];
  if (!env.apiKey) return { calls: [], verdict: ['LLM_API_KEY 가 비어 있어요'], ok: false };
  const calls: CallReport[] = [];
  calls.push(await textCall(env, env.llmModel, fetchImpl));
  calls.push(await textCall(env, env.visionModel, fetchImpl));
  const files = photos ?? SAMPLES.map((n) => join(env.samplesDir, n));
  for (const p of files) calls.push(await imageCall(env, p, fetchImpl));

  const t1 = calls[0];
  const imgs = calls.filter((c) => c.kind === 'image');
  const ok = t1.parsed && imgs.length > 0 && imgs.every((c) => c.parsed);

  if (!t1.parsed) verdict.push(`텍스트 모델 ${env.llmModel} 호출이 실패했어요. 키·LLM_BASE_URL·LLM_MODEL 을 확인하세요`);
  if (imgs.some((c) => c.status !== null && c.status >= 400 && c.status < 500 && /image|vision|multimodal|invalid/i.test(c.errorSummary ?? ''))) {
    verdict.push('이 모델 이름은 사진을 받지 못하는 것 같아요. VISION_MODEL 을 바꿔 보세요');
  } else if (imgs.some((c) => !c.parsed)) {
    verdict.push(`사진 분류가 실패한 장이 있어요 (모델 ${env.visionModel})`);
  }
  const visionT = numEnv('VISION_TIMEOUT_MS', 15000);
  const llmT = numEnv('LLM_TIMEOUT_MS', 10000);
  const imgMax = Math.max(0, ...imgs.filter((c) => c.status !== null).map((c) => c.ms));
  if (imgMax > visionT * 0.7) verdict.push(`응답이 느려요. 타임아웃을 ${recommend(imgMax)}ms 로 올리세요 (VISION_TIMEOUT_MS, 지금 ${visionT}ms)`);
  if (t1.status !== null && t1.ms > llmT * 0.7) verdict.push(`응답이 느려요. 타임아웃을 ${recommend(t1.ms)}ms 로 올리세요 (LLM_TIMEOUT_MS, 지금 ${llmT}ms)`);
  if (!photos && imgs.some((c) => c.parsed && c.facility === 'unsupported')) {
    verdict.push('샘플 사진은 합성 이미지라 실제 사진이 아니어서 범위 밖으로 판정될 수 있어요. 서비스는 샘플을 모델 없이 처리하도록 바뀌므로 실제 사진 한 장으로 따로 시험해 보세요 (node --env-file=.env scripts/check-llm.ts <사진경로>)');
  }
  if (ok && verdict.length === 0) verdict.push('키·모델·사진 분류 모두 정상이에요');
  return { calls, verdict: verdict.map(clean), ok };
}

export function formatReport(r: CheckReport): string {
  const lines: string[] = [];
  for (const c of r.calls) {
    const s = c.status === null ? '-' : String(c.status);
    if (c.kind === 'text') {
      lines.push(`[텍스트] 모델 ${c.model} · HTTP ${s} · ${c.ms}ms · 응답 파싱 ${c.parsed ? '성공' : '실패'} · ${c.errorSummary ?? '-'}`);
    } else {
      const j = c.parsed ? `판정 ${c.facility}/${c.fault ?? 'null'} 신뢰도 ${(c.confidence ?? 0).toFixed(2)}` : `파싱 실패 · ${c.errorSummary ?? '-'}`;
      lines.push(`[사진] ${c.file} · 모델 ${c.model} · HTTP ${s} · ${c.ms}ms · ${j}`);
    }
  }
  for (const v of r.verdict) lines.push(`[결론] ${v}`);
  return lines.map((l) => (secret ? l.split(secret).join('***') : l)).join('\n');
}

async function main(): Promise<void> {
  const env: CheckEnv = {
    baseUrl: process.env.LLM_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.LLM_API_KEY ?? '',
    llmModel: process.env.LLM_MODEL || 'qwen3.7-flash',
    visionModel: process.env.VISION_MODEL || DEFAULT_VISION_MODEL,
    timeoutMs: numEnv('CHECK_TIMEOUT_MS', 60000),
    samplesDir: process.env.CHECK_SAMPLES_DIR || 'public/samples',
  };
  const arg = process.argv[2];
  if (arg && !existsSync(arg)) {
    console.log(`[결론] 사진 파일을 찾을 수 없어요: ${clean(arg)}`);
    process.exit(1);
  }
  const r = await runCheck(env, fetch, arg ? [arg] : undefined);
  console.log(formatReport(r));
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1]?.endsWith('check-llm.ts')) void main();
