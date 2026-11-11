import { FACILITIES, FAULTS, type Classification, type Facility, type Fault } from '../../shared/types.ts';

/** 분류에 필요한 사진 입력. 좌표는 fixture 매칭에만 쓰고 외부로 보내지 않는다. */
export interface VisionInput {
  bytes: Uint8Array;
  sha256: string;
  lat: number | null;
  lng: number | null;
}

export type Candidate = Classification['candidates'][number];

export function unsupported(source: Classification['source'], error?: 'vision_unavailable'): Classification {
  const c: Classification = { facility: 'unsupported', fault: null, confidence: 0, candidates: [], source };
  if (error) c.error = error;
  return c;
}

function isFacility(v: unknown): v is Facility {
  return typeof v === 'string' && (FACILITIES as readonly string[]).includes(v);
}

/** 시설에 맞는 고장인지. 범위 밖·응급 시설은 fault=null 만 허용. */
export function faultFits(facility: Facility, fault: unknown): fault is Fault | null {
  if (facility === 'unsupported' || facility === 'emergency') return fault === null || fault === undefined;
  if (fault === null || fault === undefined) return true;
  return typeof fault === 'string' && (FAULTS[facility] as readonly string[]).includes(fault);
}

function conf(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function candidate(v: unknown): Candidate | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const c = conf(o.confidence);
  if (!isFacility(o.facility) || c === null || !faultFits(o.facility, o.fault)) return null;
  return { facility: o.facility, fault: (o.fault ?? null) as Fault | null, confidence: c };
}

/** 임의 값 → Classification. enum·범위 검증에 실패하면 null. */
export function validateClassification(v: unknown, source: Classification['source']): Classification | null {
  const top = candidate(v);
  if (!top) return null;
  const raw = (v as Record<string, unknown>).candidates;
  const candidates: Candidate[] = [];
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const c = candidate(r);
      if (c) candidates.push(c);
    }
  }
  return { ...top, candidates, source };
}
