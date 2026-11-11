import { readFileSync } from 'node:fs';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Facility } from '../../shared/types.ts';
import { loadBoundaries } from './boundaries.ts';

export interface Jurisdiction { sigCode: string; sigName: string }

type DeptFacility = 'streetlight' | 'bench' | 'sidewalk';
interface DepartmentTable {
  default: Record<DeptFacility, string>;
  bySig: Record<string, { name: string } & Partial<Record<DeptFacility, string>>>;
}

const DEPT_URL = new URL('../../../data/departments.json', import.meta.url);
let depts: DepartmentTable | null = null;

/** 좌표가 속한 시군구. 경계 밖이면 null. */
export function lookupJurisdiction(lat: number, lng: number): Jurisdiction | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  for (const f of loadBoundaries()) {
    const [minX, minY, maxX, maxY] = f.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (booleanPointInPolygon([lng, lat], f.geometry)) return { sigCode: f.properties.code, sigName: f.properties.name };
  }
  return null;
}

/** 시군구·시설에 맞는 일반화된 담당 부서명. */
export function departmentFor(sigCode: string, facility: Facility): string {
  depts ??= JSON.parse(readFileSync(DEPT_URL, 'utf8')) as DepartmentTable;
  const key: DeptFacility = facility === 'bench' ? 'bench' : facility === 'sidewalk' ? 'sidewalk' : 'streetlight';
  const sig = depts.bySig[sigCode];
  if (sig?.[key]) return sig[key];
  return sig ? `${sig.name} ${depts.default[key]}` : depts.default[key];
}
