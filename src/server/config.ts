export type VisionBackend = 'fixture' | 'qwen';
export type LlmBackend = 'template' | 'qwen';
export type Geocoder = 'offline' | 'nominatim';
export type SubmissionAdapterName = 'mock' | 'open311' | 'email';

export interface Config {
  port: number;
  selfBaseUrl: string;
  publicBaseUrl: string;
  dataDir: string;
  demoMode: boolean;
  allowTestRoutes: boolean;
  visionBackend: VisionBackend;
  visionModel: string;
  visionTimeoutMs: number;
  llmBackend: LlmBackend;
  llmModel: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmTimeoutMs: number;
  geocoder: Geocoder;
  nominatimUrl: string;
  mergeRadiusM: number;
  submissionAdapter: SubmissionAdapterName;
  submissionLiveConfirm: string;
  open311Endpoint: string;
  open311ApiKey: string;
  open311JurisdictionId: string;
  smtpUrl: string;
  submissionEmailTo: string;
  submissionEmailFrom: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  pushSinkUrl: string;
  photoTtlDays: number;
  reportTtlDays: number;
  sweepMinutes: number;
  rateLimitPerMinute: number;
  rateLimitPerDay: number;
  rateLimitDailyTotal: number;
  trustedProxyHops: number;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, def: string): string {
  const v = env[key];
  return v === undefined || v === '' ? def : v;
}
function num(env: Env, key: string, def: number): number {
  const v = Number(env[key]);
  return env[key] === undefined || env[key] === '' || !Number.isFinite(v) ? def : v;
}
function nonNeg(env: Env, key: string, def: number): number {
  const v = num(env, key, def);
  return v < 0 ? def : v;
}
function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], def: T): T {
  const v = env[key];
  return v !== undefined && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

export function loadConfig(env: Env = process.env): Config {
  const port = num(env, 'PORT', 8870);
  return {
    port,
    selfBaseUrl: str(env, 'SELF_BASE_URL', `http://localhost:${port}`),
    publicBaseUrl: str(env, 'PUBLIC_BASE_URL', 'http://localhost:8871'),
    dataDir: str(env, 'DATA_DIR', './data/runtime'),
    demoMode: env.DEMO_MODE === '1',
    allowTestRoutes: env.ALLOW_TEST_ROUTES === '1',
    visionBackend: oneOf(env, 'VISION_BACKEND', ['fixture', 'qwen'], 'fixture'),
    visionModel: str(env, 'VISION_MODEL', ''),
    visionTimeoutMs: num(env, 'VISION_TIMEOUT_MS', 15000),
    llmBackend: oneOf(env, 'LLM_BACKEND', ['template', 'qwen'], 'template'),
    llmModel: str(env, 'LLM_MODEL', 'qwen3.7-flash'),
    llmBaseUrl: str(env, 'LLM_BASE_URL', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),
    llmApiKey: str(env, 'LLM_API_KEY', ''),
    llmTimeoutMs: num(env, 'LLM_TIMEOUT_MS', 10000),
    geocoder: oneOf(env, 'GEOCODER', ['offline', 'nominatim'], 'offline'),
    nominatimUrl: str(env, 'NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
    mergeRadiusM: num(env, 'MERGE_RADIUS_M', 20),
    submissionAdapter: oneOf(env, 'SUBMISSION_ADAPTER', ['mock', 'open311', 'email'], 'mock'),
    submissionLiveConfirm: str(env, 'SUBMISSION_LIVE_CONFIRM', ''),
    open311Endpoint: str(env, 'OPEN311_ENDPOINT', ''),
    open311ApiKey: str(env, 'OPEN311_API_KEY', ''),
    open311JurisdictionId: str(env, 'OPEN311_JURISDICTION_ID', ''),
    smtpUrl: str(env, 'SMTP_URL', ''),
    submissionEmailTo: str(env, 'SUBMISSION_EMAIL_TO', ''),
    submissionEmailFrom: str(env, 'SUBMISSION_EMAIL_FROM', ''),
    vapidPublicKey: str(env, 'VAPID_PUBLIC_KEY', ''),
    vapidPrivateKey: str(env, 'VAPID_PRIVATE_KEY', ''),
    vapidSubject: str(env, 'VAPID_SUBJECT', 'mailto:demo@example.com'),
    pushSinkUrl: str(env, 'PUSH_SINK_URL', ''),
    photoTtlDays: num(env, 'PHOTO_TTL_DAYS', 7),
    reportTtlDays: num(env, 'REPORT_TTL_DAYS', 30),
    sweepMinutes: num(env, 'SWEEP_MINUTES', 10),
    rateLimitPerMinute: nonNeg(env, 'RATE_LIMIT_PER_MINUTE', 5),
    rateLimitPerDay: nonNeg(env, 'RATE_LIMIT_PER_DAY', 20),
    rateLimitDailyTotal: nonNeg(env, 'RATE_LIMIT_DAILY_TOTAL', 300),
    trustedProxyHops: nonNeg(env, 'TRUSTED_PROXY_HOPS', 0),
  };
}

export const config: Config = loadConfig();
