import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Classification } from '../../shared/types.ts';
import { unsupported, validateClassification, type VisionInput } from './types.ts';

export function fixtureDir(): string {
  return process.env.VISION_FIXTURE_DIR ?? 'tests/e2e/fixtures/vision';
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** sha256 파일 → 좌표 색인(index.json) → unsupported 순으로 찾는다. */
export function classifyFixture(input: VisionInput, dir: string = fixtureDir()): Classification {
  if (/^[0-9a-f]{64}$/.test(input.sha256)) {
    const byHash = join(dir, `${input.sha256}.json`);
    if (existsSync(byHash)) {
      const c = validateClassification(readJson(byHash), 'fixture');
      if (c) return c;
    }
  }
  if (input.lat !== null && input.lng !== null) {
    const idx = readJson(join(dir, 'index.json')) as { byCoord?: Array<{ lat: number; lng: number; file: string }> } | null;
    const lat = round4(input.lat);
    const lng = round4(input.lng);
    const hit = idx?.byCoord?.find((e) => round4(e.lat) === lat && round4(e.lng) === lng);
    if (hit && /^[\w.-]+\.json$/.test(hit.file)) {
      const c = validateClassification(readJson(join(dir, hit.file)), 'fixture');
      if (c) return c;
    }
  }
  return unsupported('fixture');
}

export const SAMPLE_EPS = 5e-7;

/** 샘플 사진 판정(qwen 모드용): sha256 파일 일치 또는 index.json 좌표와 SAMPLE_EPS 이내. 반올림 매칭은 쓰지 않는다. */
export function classifySample(input: VisionInput, dir: string = fixtureDir()): Classification | null {
  if (/^[0-9a-f]{64}$/.test(input.sha256)) {
    const byHash = join(dir, `${input.sha256}.json`);
    if (existsSync(byHash)) {
      const c = validateClassification(readJson(byHash), 'fixture');
      if (c) return c;
    }
  }
  if (input.lat !== null && input.lng !== null) {
    const { lat, lng } = input;
    const idx = readJson(join(dir, 'index.json')) as { byCoord?: Array<{ lat: number; lng: number; file: string }> } | null;
    const hit = idx?.byCoord?.find((e) => Math.abs(e.lat - lat) < SAMPLE_EPS && Math.abs(e.lng - lng) < SAMPLE_EPS);
    if (hit && /^[\w.-]+\.json$/.test(hit.file)) {
      const c = validateClassification(readJson(join(dir, hit.file)), 'fixture');
      if (c) return c;
    }
  }
  return null;
}
