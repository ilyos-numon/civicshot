import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface SigFeature {
  type: 'Feature';
  properties: { code: string; name: string };
  geometry: { type: 'Polygon'; coordinates: number[][][] } | { type: 'MultiPolygon'; coordinates: number[][][][] };
  /** [minLng, minLat, maxLng, maxLat] — 빠른 1차 거르기용 */
  bbox: [number, number, number, number];
}

const BOUNDARY_DIR = fileURLToPath(new URL('../../../data/boundaries/', import.meta.url));

let cache: SigFeature[] | null = null;

function bboxOf(geometry: SigFeature['geometry']): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys)
    for (const ring of poly)
      for (const [x, y] of ring) {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
  return b;
}

/** 경계 파일 경로: 전국본(sig.geojson)이 있으면 우선, 없으면 서울 추출본. */
export function boundaryPath(dir: string = BOUNDARY_DIR): string {
  const national = `${dir}sig.geojson`;
  return existsSync(national) ? national : `${dir}sig-seoul.geojson`;
}

/** 시군구 경계를 한 번만 읽어 메모리에 둔다 (지연 로딩). */
export function loadBoundaries(): SigFeature[] {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(boundaryPath(), 'utf8')) as { features: Array<Omit<SigFeature, 'bbox'>> };
  cache = raw.features.map((f) => ({
    ...f,
    properties: { code: String(f.properties.code), name: String(f.properties.name) },
    bbox: bboxOf(f.geometry),
  }));
  return cache;
}
