import { gridDisk, latLngToCell } from 'h3-js';

/** 이슈 h3 컬럼에 저장하는 해상도 (셀 가장자리 약 25 m). */
export const H3_RES = 11;

const EARTH_RADIUS_M = 6_371_008.8;

/** 두 좌표 사이 대원 거리(m). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 좌표의 res 11 h3 셀. */
export function cellOf(lat: number, lng: number): string {
  return latLngToCell(lat, lng, H3_RES);
}

/** 병합 후보 셀: 자기 셀과 인접 1링. */
export function candidateCells(lat: number, lng: number): string[] {
  return gridDisk(cellOf(lat, lng), 1);
}
