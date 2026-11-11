import { describe, expect, it } from 'vitest';
import { openDb, migrate } from '../../src/server/db/db.ts';
import { findNearbyOpenIssue, getIssue, insertIssue, updateIssue } from '../../src/server/db/issues.ts';
import { haversineM, cellOf } from '../../src/server/geo/dedupe.ts';
import { departmentFor, lookupJurisdiction } from '../../src/server/geo/jurisdiction.ts';
import { reverseLabel } from '../../src/server/geo/reverse.ts';
import type { Facility, Issue } from '../../src/shared/types.ts';

const BASE = { lat: 37.5636, lng: 126.9976 };
// 위도 1도 ≈ 111,195 m
const north = (m: number) => BASE.lat + m / 111_195;

let seq = 0;
function issue(over: Partial<Issue> = {}): Issue {
  seq += 1;
  const now = new Date().toISOString();
  return {
    id: `i${seq}`, receiptNo: `R${seq}`, statusToken: `t${seq}`, facility: 'streetlight', fault: 'light_out', lat: BASE.lat, lng: BASE.lng, h3: '',
    sigCode: '11020', sigName: '중구', department: '중구 도로관리과', addressLabel: '중구 부근', status: 'received', reportCount: 1,
    agencyRef: null, completionPhotoId: null, createdAt: now, updatedAt: now, ...over,
  };
}
function freshDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('haversine', () => {
  it('알려진 거리와 0.5% 안에서 맞는다', () => {
    // 서울시청 ↔ 부산시청 약 325 km
    expect(haversineM(37.5663, 126.9779, 35.1798, 129.0750) / 1000).toBeCloseTo(325, -1);
    expect(Math.abs(haversineM(BASE.lat, BASE.lng, north(8), BASE.lng) - 8)).toBeLessThan(0.05);
    expect(haversineM(BASE.lat, BASE.lng, BASE.lat, BASE.lng)).toBe(0);
  });
});

describe('중복 병합 후보', () => {
  it('8 m 떨어진 같은 시설은 같은 이슈로 묶인다', () => {
    const db = freshDb();
    const a = insertIssue(db, issue());
    expect(a.h3).toBe(cellOf(BASE.lat, BASE.lng));
    expect(findNearbyOpenIssue(db, 'streetlight', north(8), BASE.lng, 20)?.id).toBe(a.id);
  });
  it('25 m 떨어지면 분리된다', () => {
    const db = freshDb();
    insertIssue(db, issue());
    expect(findNearbyOpenIssue(db, 'streetlight', north(25), BASE.lng, 20)).toBeNull();
  });
  it('다른 시설은 분리된다', () => {
    const db = freshDb();
    insertIssue(db, issue());
    expect(findNearbyOpenIssue(db, 'bench' as Facility, north(8), BASE.lng, 20)).toBeNull();
  });
  it('완료된 이슈는 병합 대상이 아니다', () => {
    const db = freshDb();
    const a = insertIssue(db, issue());
    updateIssue(db, a.id, { status: 'completed' });
    expect(getIssue(db, a.id)?.status).toBe('completed');
    expect(findNearbyOpenIssue(db, 'streetlight', north(8), BASE.lng, 20)).toBeNull();
  });
  it('여럿이면 가장 가까운 이슈를 고른다', () => {
    const db = freshDb();
    insertIssue(db, issue({ lat: north(15) }));
    const near = insertIssue(db, issue({ lat: north(3) }));
    expect(findNearbyOpenIssue(db, 'streetlight', BASE.lat, BASE.lng, 20)?.id).toBe(near.id);
  });
});

describe('관할 판정', () => {
  it('서울 주요 좌표를 올바른 구로 판정한다', () => {
    expect(lookupJurisdiction(37.5636, 126.9976)?.sigName).toBe('중구');
    expect(lookupJurisdiction(37.5172, 127.0473)?.sigName).toBe('강남구');
    expect(lookupJurisdiction(37.5563, 126.9236)?.sigName).toBe('마포구');
    expect(lookupJurisdiction(0, 0)).toBeNull();
  });
  it('부서명은 구 이름을 포함한 일반 부서명이다', () => {
    expect(departmentFor('11020', 'streetlight')).toBe('중구 도로관리과');
    expect(departmentFor('11020', 'bench')).toBe('중구 공원녹지과');
  });
  it('오프라인 주소 문구는 "<구> 부근"', async () => {
    expect(await reverseLabel(1, 2, { geocoder: 'offline', sigName: '중구' })).toEqual({ addressLabel: '중구 부근', source: 'offline' });
  });
});
