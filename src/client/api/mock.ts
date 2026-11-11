import { FACILITY_KO, FAULT_KO } from '../../shared/types.ts';
import type { AgencyRequest, Api, Issue, Photo } from './types.ts';

// 화면 프로토타입용 목업. 상태는 메모리에만 있다.
const photos = new Map<string, Photo>();
const issues = new Map<string, Issue>();
const agency = new Map<string, AgencyRequest>();
let seq = 0;

const now = () => new Date().toISOString();
const delay = <T>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 150));
function fail(error: string): never {
  throw Object.assign(new Error(error), { error });
}
function issueByToken(token: string): Issue {
  for (const i of issues.values()) if (i.statusToken === token) return i;
  return fail('not_found');
}

export function resetMock(): void {
  photos.clear();
  issues.clear();
  agency.clear();
  seq = 0;
}

export const mock: Api = {
  health: () => delay({ ok: true, adapter: 'mock' }),
  status: () => delay({ adapter: 'mock', live: false, backends: { vision: 'fixture', llm: 'template', geocoder: 'offline' } }),
  uploadPhoto: async (input) => {
    const id = `ph-${++seq}`;
    const photo: Photo = {
      id,
      lat: input.lat ?? 37.5665,
      lng: input.lng ?? 126.978,
      takenAt: input.takenAt ?? null,
      width: 1280,
      height: 960,
      bytes: input.file.size,
      createdAt: now(),
      purged: false,
    };
    photos.set(id, photo);
    return delay(photo);
  },
  photoUrl: () => '/icons/icon-512.png',
  classify: () =>
    delay({
      facility: 'streetlight',
      fault: 'light_out',
      confidence: 0.91,
      candidates: [
        { facility: 'streetlight', fault: 'light_out', confidence: 0.91 },
        { facility: 'streetlight', fault: 'flicker', confidence: 0.06 },
      ],
      source: 'fixture',
    }),
  locate: (input) =>
    delay({
      lat: input.lat,
      lng: input.lng,
      sigCode: '11140',
      sigName: '서울특별시 중구',
      department: '중구청 도로관리과',
      addressLabel: '서울특별시 중구 세종대로 부근',
      source: 'offline',
    }),
  form: (input) => {
    if (input.facility === 'emergency') return fail('emergency');
    if (input.facility === 'unsupported') return fail('unsupported');
    const what = `${FACILITY_KO[input.facility]}${input.fault ? ` ${FAULT_KO[input.fault]}` : ''}`;
    return delay({
      title: `[${what}] ${input.addressLabel}`,
      body: `${input.addressLabel}의 ${what} 신고입니다. 사진을 첨부합니다. 확인 후 조치 부탁드립니다. (담당: ${input.department})`,
      source: 'template',
    });
  },
  submitReport: (input) => {
    const n = issues.size + 1;
    const id = `is-${n}`;
    const receiptNo = `CS-${String(n).padStart(4, '0')}`;
    const statusToken = `tok-${n}`;
    const t = now();
    const issue: Issue = {
      id,
      receiptNo,
      statusToken,
      facility: input.facility,
      fault: input.fault,
      lat: input.location.lat,
      lng: input.location.lng,
      h3: 'mock',
      sigCode: input.location.sigCode,
      sigName: input.location.sigName,
      department: input.location.department,
      addressLabel: input.location.addressLabel,
      status: 'received',
      reportCount: 1,
      agencyRef: `MA-${n}`,
      completionPhotoId: null,
      createdAt: t,
      updatedAt: t,
    };
    issues.set(id, issue);
    agency.set(issue.agencyRef!, {
      id: issue.agencyRef!,
      serviceCode: input.facility,
      description: input.form.body,
      lat: issue.lat,
      lng: issue.lng,
      mediaUrl: null,
      status: 'received',
      completionPhotoId: null,
      requestedAt: t,
      updatedAt: t,
    });
    return delay({
      reportId: `rp-${n}`,
      issueId: id,
      receiptNo,
      statusToken,
      statusUrl: `/s/${statusToken}`,
      agencyRef: issue.agencyRef,
      status: issue.status,
      merged: false,
      reportCount: 1,
    });
  },
  getIssue: (id) => {
    const i = issues.get(id);
    return i ? delay({ ...i }) : fail('not_found');
  },
  getIssueByToken: async (token) => {
    const i = issueByToken(token);
    return delay(i.completionPhotoId ? { ...i, completionPhotoUrl: '/icons/icon-512.png' } : { ...i });
  },
  qrUrl: () => '/icons/icon-192.png',
  listIssues: (query) => {
    let list = [...issues.values()];
    if (query?.status) list = list.filter((i) => i.status === query.status);
    return delay(list.slice(0, query?.limit ?? 50));
  },
  subscribePush: () => delay({ id: `push-${++seq}` }),
  agencyRequests: () => delay([...agency.values()]),
  patchAgencyRequest: async (id, input) => {
    const req = agency.get(id) ?? fail('not_found');
    if (input.status === 'completed' && !input.completionPhotoId) fail('completion_photo_required');
    const t = now();
    const next: AgencyRequest = { ...req, status: input.status, completionPhotoId: input.completionPhotoId ?? req.completionPhotoId, updatedAt: t };
    agency.set(id, next);
    for (const i of issues.values()) {
      if (i.agencyRef === id) issues.set(i.id, { ...i, status: input.status, completionPhotoId: next.completionPhotoId, updatedAt: t });
    }
    return delay(next);
  },
};
