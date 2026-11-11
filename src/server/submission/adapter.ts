import type { ComplaintForm, Issue, IssueStatus } from '../../shared/types.ts';
import type { Config } from '../config.ts';

export interface SubmissionAdapter {
  readonly name: 'mock' | 'open311' | 'email';
  services(): Promise<Array<{ code: string; name: string }>>;
  submit(input: { issue: Issue; form: ComplaintForm; photoUrl: string }): Promise<{ agencyRef: string; receiptUrl?: string }>;
  getStatus(agencyRef: string): Promise<{ status: IssueStatus; updatedAt: string } | null>;
}

export const LIVE_CONFIRM_PHRASE = 'I_UNDERSTAND_REAL_REPORTS_WILL_BE_SENT';

export interface Open311Options { endpoint: string; apiKey: string; jurisdictionId: string }

// 계약 자리만 둔 클래스. 실제 구현은 open311.ts 의 Open311Client.
export class Open311Adapter implements SubmissionAdapter {
  readonly name: 'mock' | 'open311';
  readonly options: Open311Options;
  constructor(options: Open311Options, name: 'mock' | 'open311' = 'open311') {
    this.options = options;
    this.name = name;
  }
  async services(): Promise<Array<{ code: string; name: string }>> {
    throw new Error('not_implemented');
  }
  async submit(_input: { issue: Issue; form: ComplaintForm; photoUrl: string }): Promise<{ agencyRef: string; receiptUrl?: string }> {
    throw new Error('not_implemented');
  }
  async getStatus(_agencyRef: string): Promise<{ status: IssueStatus; updatedAt: string } | null> {
    throw new Error('not_implemented');
  }
}

export interface EmailOptions { smtpUrl: string; to: string; from: string }

// 계약 자리만 둔 클래스. 실제 구현은 email.ts 의 EmailSender.
export class EmailAdapter implements SubmissionAdapter {
  readonly name = 'email' as const;
  readonly options: EmailOptions;
  constructor(options: EmailOptions) {
    this.options = options;
  }
  async services(): Promise<Array<{ code: string; name: string }>> {
    throw new Error('not_implemented');
  }
  async submit(_input: { issue: Issue; form: ComplaintForm; photoUrl: string }): Promise<{ agencyRef: string; receiptUrl?: string }> {
    throw new Error('not_implemented');
  }
  async getStatus(_agencyRef: string): Promise<{ status: IssueStatus; updatedAt: string } | null> {
    throw new Error('not_implemented');
  }
}

export function mockAdapter(env: Config): SubmissionAdapter {
  return new Open311Adapter({ endpoint: `${env.selfBaseUrl}/mock-agency/v2`, apiKey: 'mock', jurisdictionId: 'mock' }, 'mock');
}

export function selectAdapter(env: Config): { adapter: SubmissionAdapter; live: boolean; refused?: string } {
  const requested = env.submissionAdapter;
  if (requested === 'mock') return { adapter: mockAdapter(env), live: false };
  if (env.demoMode || env.submissionLiveConfirm !== LIVE_CONFIRM_PHRASE) {
    return { adapter: mockAdapter(env), live: false, refused: requested };
  }
  if (requested === 'open311') {
    return {
      adapter: new Open311Adapter({ endpoint: env.open311Endpoint, apiKey: env.open311ApiKey, jurisdictionId: env.open311JurisdictionId }),
      live: true,
    };
  }
  return { adapter: new EmailAdapter({ smtpUrl: env.smtpUrl, to: env.submissionEmailTo, from: env.submissionEmailFrom }), live: true };
}
