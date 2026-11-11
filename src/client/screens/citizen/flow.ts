// 시민 신고 흐름의 세션 상태. 화면 사이를 오갈 때 sessionStorage 에 둔다.
import type { ComplaintForm, Facility, Fault, Location, ReportResult } from '../../api/index.ts';

const KEY = 'cs-flow';
/** 테스트·시연용: 사진 판정 결과를 덮어쓴다 ('emergency' | 'unsupported'). */
export const SCENARIO_KEY = 'cs-scenario';

export interface FlowState {
  photoId?: string;
  /** 화면 표시용 축소 사진(data URL) */
  preview?: string;
  hasGps?: boolean;
  lat?: number | null;
  lng?: number | null;
  facility?: Facility;
  fault?: Fault | null;
  location?: Location | null;
  /** GPS 가 없어 직접 적은 위치 */
  placeText?: string;
  form?: ComplaintForm;
  result?: ReportResult;
  notify?: boolean;
  /** 위치를 지도에서 다시 골라야 함 (GPS 없음·지원 지역 밖) */
  needsPlace?: boolean;
}

/** "나도 신고": 상태 화면에서 고른 시설·위치를 다음 촬영에 미리 넣는다. resetFlow 와 따로 둔다. */
const ME_TOO_KEY = 'cs-me-too';
export interface MeToo { facility: Facility; fault: Fault; lat: number; lng: number }

export function setMeToo(v: MeToo): void {
  try { sessionStorage.setItem(ME_TOO_KEY, JSON.stringify(v)); } catch { /* 무시 */ }
}

/** 한 번 꺼내면 지운다. */
export function takeMeToo(): MeToo | null {
  try {
    const raw = sessionStorage.getItem(ME_TOO_KEY);
    sessionStorage.removeItem(ME_TOO_KEY);
    return raw ? (JSON.parse(raw) as MeToo) : null;
  } catch {
    return null;
  }
}

export function readFlow(): FlowState {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as FlowState;
  } catch {
    return {};
  }
}

export function writeFlow(patch: Partial<FlowState>): FlowState {
  const next = { ...readFlow(), ...patch };
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장 공간 부족 — 사진 미리보기만 빼고 다시 시도
    const { preview: _p, ...rest } = next;
    try { sessionStorage.setItem(KEY, JSON.stringify(rest)); } catch { /* 무시 */ }
  }
  return next;
}

export function resetFlow(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* 무시 */ }
}

export function scenario(): Facility | null {
  try {
    const v = sessionStorage.getItem(SCENARIO_KEY);
    return v === 'emergency' || v === 'unsupported' ? v : null;
  } catch {
    return null;
  }
}

/** 화면에 보여줄 작은 사진을 만든다 (긴 변 720px). */
export async function makePreview(file: Blob): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 서버 오류 코드 (client.ts 의 HttpError·mock 의 error 필드) */
export const errorCode = (e: unknown): string | undefined => (e as { error?: string } | null)?.error;

/** 오프라인·연결 끊김처럼 다시 보내면 되는 오류인지 (HTTP 상태가 없음). */
export const isNetworkError = (e: unknown): boolean =>
  (typeof navigator !== 'undefined' && !navigator.onLine) || typeof (e as { status?: unknown } | null)?.status !== 'number' && !errorCode(e);

/** 익명 신고자 표시. 기기에 한 번 만든 무작위 값이며 개인정보를 담지 않는다. */
export function reporterToken(): string {
  try {
    let t = localStorage.getItem('cs-reporter');
    if (!t) {
      t = crypto.randomUUID();
      localStorage.setItem('cs-reporter', t);
    }
    return t;
  } catch {
    return crypto.randomUUID();
  }
}

export const isOutOfScope = (f: Facility | undefined) => f === 'emergency' || f === 'unsupported';
