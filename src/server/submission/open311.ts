import type { ComplaintForm, Issue, IssueStatus } from '../../shared/types.ts';
import { ISSUE_STATUSES } from '../../shared/types.ts';
import type { Open311Options, SubmissionAdapter } from './adapter.ts';

const TIMEOUT_MS = 10_000;

/** Open311 POST requests.json 본문(form-urlencoded). */
export function buildOpen311Form(options: Open311Options, input: { issue: Issue; form: ComplaintForm; photoUrl: string }): URLSearchParams {
  return new URLSearchParams({
    api_key: options.apiKey,
    jurisdiction_id: options.jurisdictionId,
    service_code: input.issue.facility,
    lat: String(input.issue.lat),
    long: String(input.issue.lng),
    description: `${input.form.title}\n\n${input.form.body}`,
    media_url: input.photoUrl,
  });
}

/** Open311 GeoReport v2 클라이언트. mock 은 같은 구현이 앱 안 모의 기관을 가리킨다. */
export class Open311Client implements SubmissionAdapter {
  readonly name: 'mock' | 'open311';
  readonly options: Open311Options;
  constructor(options: Open311Options, name: 'mock' | 'open311' = 'open311') {
    this.options = options;
    this.name = name;
  }

  private url(path: string, query?: Record<string, string>): string {
    const q = new URLSearchParams({ jurisdiction_id: this.options.jurisdictionId, ...query });
    return `${this.options.endpoint.replace(/\/$/, '')}/${path}?${q}`;
  }

  async services(): Promise<Array<{ code: string; name: string }>> {
    const res = await fetch(this.url('services.json'), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`open311 services ${res.status}`);
    const list = (await res.json()) as Array<{ service_code: string; service_name: string }>;
    return list.map((s) => ({ code: s.service_code, name: s.service_name }));
  }

  async submit(input: { issue: Issue; form: ComplaintForm; photoUrl: string }): Promise<{ agencyRef: string; receiptUrl?: string }> {
    const res = await fetch(`${this.options.endpoint.replace(/\/$/, '')}/requests.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: buildOpen311Form(this.options, input).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`open311 submit ${res.status}`);
    const body = (await res.json()) as Array<{ service_request_id?: string; token?: string }>;
    const ref = body[0]?.service_request_id ?? body[0]?.token;
    if (!ref) throw new Error('open311 submit: no service_request_id');
    return { agencyRef: String(ref) };
  }

  async getStatus(agencyRef: string): Promise<{ status: IssueStatus; updatedAt: string } | null> {
    const res = await fetch(this.url(`requests/${encodeURIComponent(agencyRef)}.json`), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`open311 status ${res.status}`);
    const body = (await res.json()) as Array<{ status?: string; updated_datetime?: string; extended_attributes?: { status?: string } }>;
    const r = body[0];
    if (!r) return null;
    const ext = r.extended_attributes?.status;
    const status: IssueStatus = ext && (ISSUE_STATUSES as readonly string[]).includes(ext) ? (ext as IssueStatus) : r.status === 'closed' ? 'completed' : 'received';
    return { status, updatedAt: r.updated_datetime ?? new Date().toISOString() };
  }
}
