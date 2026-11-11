import type { Config } from '../config.ts';
import type { Classification } from '../../shared/types.ts';
import { classifyFixture, classifySample } from './fixture.ts';
import { classifyQwen } from './qwen.ts';
import type { VisionInput } from './types.ts';

export type { VisionInput } from './types.ts';

export function needsExternalCall(input: VisionInput, config: Config): boolean {
  return config.visionBackend === 'qwen' && classifySample(input) === null;
}

export async function classify(input: VisionInput, config: Config): Promise<Classification> {
  if (config.visionBackend === 'qwen') {
    const sample = classifySample(input);
    if (sample) return sample;
    return classifyQwen(input, {
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      model: config.visionModel,
      timeoutMs: config.visionTimeoutMs,
    });
  }
  return classifyFixture(input);
}
