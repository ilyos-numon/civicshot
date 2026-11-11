import type { Api, ApiError } from './types.ts';

/** 서버 오류를 Error 로 바꾼다. `error`(코드)·`status`(HTTP) 를 붙여 화면과 오프라인 대기열이 구분할 수 있게 한다. */
export class HttpError extends Error {
  readonly error: string;
  readonly status: number;
  /** 요청이 많을 때 다시 해도 되는 시각까지 남은 초 */
  readonly retryAfterSec?: number;
  /** 제한 범위: minute | day | total */
  readonly scope?: string;
  constructor(status: number, body: Partial<ApiError> | null) {
    const code = typeof body?.error === 'string' ? body.error : `http_${status}`;
    super(typeof body?.message === 'string' ? body.message : code);
    this.name = 'HttpError';
    this.error = code;
    this.status = status;
    const extra = body as { retryAfterSec?: unknown; scope?: unknown } | null;
    if (typeof extra?.retryAfterSec === 'number') this.retryAfterSec = extra.retryAfterSec;
    if (typeof extra?.scope === 'string') this.scope = extra.scope;
  }
}

/** fetch 래퍼. 네트워크 오류(TypeError)는 그대로 던진다 — status 가 없으면 다시 보낼 수 있는 오류다. */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw new HttpError(res.status, data as Partial<ApiError> | null);
  return data as T;
}

const enc = encodeURIComponent;

export const client: Api = {
  health: () => request('GET', '/health'),
  status: () => request('GET', '/api/status'),
  uploadPhoto: (input) => {
    const fd = new FormData();
    fd.append('file', input.file, 'photo.jpg');
    if (input.lat != null && input.lng != null) {
      fd.append('lat', String(input.lat));
      fd.append('lng', String(input.lng));
    }
    if (input.takenAt) fd.append('takenAt', input.takenAt);
    return request('POST', '/api/photos', fd);
  },
  photoUrl: (id) => `/api/photos/${enc(id)}`,
  classify: (input) => request('POST', '/api/classify', input),
  locate: (input) => request('POST', '/api/locate', input),
  form: (input) => request('POST', '/api/form', input),
  submitReport: (input) => request('POST', '/api/reports', input),
  getIssue: (id) => request('GET', `/api/issues/${enc(id)}`),
  getIssueByToken: (token) => request('GET', `/api/issues/by-token/${enc(token)}`),
  qrUrl: (token) => `/api/issues/by-token/${enc(token)}/qr.svg`,
  listIssues: (query) => {
    const q = new URLSearchParams();
    if (query?.status) q.set('status', query.status);
    if (query?.limit) q.set('limit', String(query.limit));
    const s = q.toString();
    return request('GET', `/api/issues${s ? `?${s}` : ''}`);
  },
  subscribePush: (input) => request('POST', '/api/push/subscribe', input),
  agencyRequests: () => request('GET', '/mock-agency/admin/requests'),
  patchAgencyRequest: (id, input) => request('PATCH', `/mock-agency/admin/requests/${enc(id)}`, input),
};
