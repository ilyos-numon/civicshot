export type Facility = 'streetlight' | 'bench' | 'sidewalk' | 'unsupported' | 'emergency';
export const FAULTS = {
  streetlight: ['light_out', 'flicker', 'pole_damage'],
  bench: ['broken', 'missing', 'graffiti'],
  sidewalk: ['broken_block', 'uneven', 'hole'],
} as const;
export type Fault = (typeof FAULTS)[keyof typeof FAULTS][number];
export const FACILITY_KO: Record<Facility, string> = { streetlight: '가로등', bench: '벤치', sidewalk: '보도블록', unsupported: '지원하지 않는 시설', emergency: '응급 상황' };
export const FAULT_KO: Record<Fault, string> = { light_out: '점등 불량', flicker: '깜빡임', pole_damage: '기둥 파손', broken: '파손', missing: '분실', graffiti: '낙서·오염', broken_block: '블록 파손', uneven: '단차', hole: '구멍·꺼짐' };
export type IssueStatus = 'received' | 'assigned' | 'in_progress' | 'completed';
export const STATUS_KO: Record<IssueStatus, string> = { received: '접수', assigned: '배정', in_progress: '처리중', completed: '완료' };

export const FACILITIES: readonly Facility[] = ['streetlight', 'bench', 'sidewalk', 'unsupported', 'emergency'];
export const ISSUE_STATUSES: readonly IssueStatus[] = ['received', 'assigned', 'in_progress', 'completed'];

export interface Photo { id: string; lat: number | null; lng: number | null; takenAt: string | null; width: number; height: number; bytes: number; createdAt: string; purged: boolean }
export interface Classification { facility: Facility; fault: Fault | null; confidence: number; candidates: Array<{ facility: Facility; fault: Fault | null; confidence: number }>; source: 'fixture' | 'qwen'; error?: 'vision_unavailable' }
export interface Location { lat: number; lng: number; sigCode: string; sigName: string; department: string; addressLabel: string; source: 'offline' | 'nominatim' }
export interface ComplaintForm { title: string; body: string; source: 'template' | 'llm' }
export interface Issue { id: string; receiptNo: string; statusToken: string; facility: Facility; fault: Fault; lat: number; lng: number; h3: string; sigCode: string; sigName: string; department: string; addressLabel: string; status: IssueStatus; reportCount: number; agencyRef: string | null; completionPhotoId: string | null; createdAt: string; updatedAt: string }
export interface Report { id: string; issueId: string; photoId: string; reporterToken: string; form: ComplaintForm; merged: boolean; createdAt: string }

// ---- API (§4.2) ----
export type AdapterName = 'mock' | 'open311' | 'email';
export interface ApiError { error: string; message?: string }
export type LimitScope = 'minute' | 'day' | 'total';
export interface RateLimitedBody extends ApiError { error: 'rate_limited'; scope: LimitScope; retryAfterSec: number }
export interface HealthResponse { ok: true; adapter: AdapterName }
export interface StatusResponse {
  adapter: AdapterName;
  live: boolean;
  refused?: string;
  backends: { vision: string; llm: string; geocoder: string };
}
export interface PhotoUploadInput { file: Blob; lat?: number | null; lng?: number | null; takenAt?: string | null }
export interface ClassifyInput { photoId: string }
export interface LocateInput { lat: number; lng: number; facility: Facility }
export interface FormInput { photoId: string; facility: Facility; fault: Fault | null; addressLabel: string; department: string }
export interface ReportInput { photoId: string; facility: Facility; fault: Fault; location: Location; form: ComplaintForm; reporterToken: string }
export interface ReportResult { reportId: string; issueId: string; receiptNo: string; statusToken: string; statusUrl: string; agencyRef: string | null; status: IssueStatus; merged: boolean; reportCount: number }
export type IssueByToken = Issue & { completionPhotoUrl?: string };
export interface PushSubscribeInput { issueId: string; subscription: unknown }
export interface WebhookInput { agencyRef: string; status: IssueStatus; completionPhotoId?: string }
export interface AgencyRequest { id: string; serviceCode: string; description: string; lat: number; lng: number; mediaUrl: string | null; status: IssueStatus; completionPhotoId: string | null; requestedAt: string; updatedAt: string }
export interface AgencyPatchInput { status: IssueStatus; completionPhotoId?: string }

export interface Api {
  health(): Promise<HealthResponse>;
  status(): Promise<StatusResponse>;
  uploadPhoto(input: PhotoUploadInput): Promise<Photo>;
  photoUrl(id: string): string;
  classify(input: ClassifyInput): Promise<Classification>;
  locate(input: LocateInput): Promise<Location>;
  form(input: FormInput): Promise<ComplaintForm>;
  submitReport(input: ReportInput): Promise<ReportResult>;
  getIssue(id: string): Promise<Issue>;
  getIssueByToken(token: string): Promise<IssueByToken>;
  qrUrl(token: string): string;
  listIssues(query?: { status?: IssueStatus; limit?: number }): Promise<Issue[]>;
  subscribePush(input: PushSubscribeInput): Promise<{ id: string }>;
  agencyRequests(): Promise<AgencyRequest[]>;
  patchAgencyRequest(id: string, input: AgencyPatchInput): Promise<AgencyRequest>;
}
