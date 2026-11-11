import type { Geocoder } from '../config.ts';

export interface ReverseOptions { geocoder?: Geocoder; nominatimUrl?: string; sigName: string; timeoutMs?: number }
export interface ReverseResult { addressLabel: string; source: 'offline' | 'nominatim' }

const cache = new Map<string, string>();

/** 좌표의 사람이 읽는 주소 문구. 기본 오프라인(`<구> 부근`), nominatim 실패 시 오프라인으로 폴백. */
export async function reverseLabel(lat: number, lng: number, opts: ReverseOptions): Promise<ReverseResult> {
  const offline: ReverseResult = { addressLabel: `${opts.sigName} 부근`, source: 'offline' };
  if (opts.geocoder !== 'nominatim' || !opts.nominatimUrl) return offline;
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const hit = cache.get(key);
  if (hit) return { addressLabel: hit, source: 'nominatim' };
  try {
    const url = `${opts.nominatimUrl.replace(/\/$/, '')}/reverse?format=jsonv2&accept-language=ko&zoom=17&lat=${lat}&lon=${lng}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'civicshot-demo' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 5000) });
    if (!res.ok) return offline;
    const body = (await res.json()) as { address?: Record<string, string> };
    const a = body.address ?? {};
    const parts = [a.borough ?? a.city_district ?? opts.sigName, a.quarter ?? a.suburb ?? a.neighbourhood, a.road].filter(Boolean);
    if (parts.length < 2) return offline;
    const label = `${parts.join(' ')} 부근`;
    cache.set(key, label);
    return { addressLabel: label, source: 'nominatim' };
  } catch {
    return offline;
  }
}
