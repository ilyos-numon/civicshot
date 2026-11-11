import type { Config } from '../config.ts';
import type { ComplaintForm } from '../../shared/types.ts';
import { templateForm, type FormInput } from './templates.ts';
import { llmForm } from './llm.ts';

export { templateForm, isValidPair, type FormInput, type FormFacility } from './templates.ts';
export { checkLlmForm, parseLlmReply, BANNED } from './llm.ts';

/** 템플릿 양식 (순수 함수). */
export function buildForm(input: FormInput): ComplaintForm {
  return templateForm(input);
}

/** 설정된 백엔드로 양식 생성. qwen 실패는 템플릿으로 대체. */
export async function generateForm(input: FormInput, cfg: Config): Promise<ComplaintForm> {
  if (cfg.llmBackend !== 'qwen' || !cfg.llmApiKey) return buildForm(input);
  return llmForm(input, { baseUrl: cfg.llmBaseUrl, apiKey: cfg.llmApiKey, model: cfg.llmModel, timeoutMs: cfg.llmTimeoutMs });
}
