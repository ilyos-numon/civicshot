import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { ComplaintForm, Issue, IssueStatus } from '../../shared/types.ts';
import { FACILITY_KO } from '../../shared/types.ts';
import type { EmailOptions, SubmissionAdapter } from './adapter.ts';

const TIMEOUT_MS = 15_000;

export interface MailMessage { from: string; to: string; subject: string; text: string; attachment: { filename: string; contentType: string; content: Uint8Array } | null; messageId: string }

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, '$&\r\n');
}

/** RFC 5322 + MIME multipart/mixed (본문 1, 첨부 0~1). 줄 끝 CRLF. */
export function buildMime(m: MailMessage): string {
  const boundary = `cs-${randomBytes(12).toString('hex')}`;
  const head = [
    `From: ${m.from}`,
    `To: ${m.to}`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Message-ID: <${m.messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(m.text, 'utf8').toString('base64'))].join('\r\n'),
  ];
  if (m.attachment) {
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${m.attachment.contentType}; name="${m.attachment.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${m.attachment.filename}"`,
        '',
        wrap76(Buffer.from(m.attachment.content).toString('base64')),
      ].join('\r\n'),
    );
  }
  return `${head.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--\r\n`;
}

/** smtp://host:port → {host, port}. 다른 스킴은 거절한다 (TLS 미지원). */
export function parseSmtpUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  if (u.protocol !== 'smtp:') throw new Error('smtp_url: only smtp:// is supported');
  return { host: u.hostname, port: u.port ? Number(u.port) : 25 };
}

/** 최소 SMTP 클라이언트 (EHLO/MAIL/RCPT/DATA/QUIT, 인증·TLS 없음). */
export async function sendMail(smtpUrl: string, envelope: { from: string; to: string }, raw: string): Promise<void> {
  const { host, port } = parseSmtpUrl(smtpUrl);
  const sock: Socket = connect({ host, port });
  sock.setTimeout(TIMEOUT_MS);
  let buf = '';
  const waiters: Array<(line: { code: number; text: string } | Error) => void> = [];
  const pending: Array<{ code: number; text: string } | Error> = [];
  const push = (v: { code: number; text: string } | Error) => {
    const w = waiters.shift();
    if (w) w(v);
    else pending.push(v);
  };
  sock.on('data', (d) => {
    buf += d.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) push({ code: Number(line.slice(0, 3)), text: line.slice(4) });
    }
  });
  sock.on('error', (e) => push(e));
  sock.on('timeout', () => {
    push(new Error('smtp timeout'));
    sock.destroy();
  });
  const reply = () =>
    new Promise<{ code: number; text: string }>((resolve, reject) => {
      const take = (v: { code: number; text: string } | Error) => (v instanceof Error ? reject(v) : resolve(v));
      const p = pending.shift();
      if (p) take(p);
      else waiters.push(take);
    });
  const expect = async (ok: number) => {
    const r = await reply();
    if (r.code !== ok) throw new Error(`smtp ${r.code}`);
  };
  const cmd = async (line: string, ok: number) => {
    sock.write(`${line}\r\n`);
    await expect(ok);
  };
  try {
    await expect(220);
    await cmd('EHLO localhost', 250);
    await cmd(`MAIL FROM:<${envelope.from}>`, 250);
    await cmd(`RCPT TO:<${envelope.to}>`, 250);
    await cmd('DATA', 354);
    const body = raw.replace(/\r\n\./g, '\r\n..');
    sock.write(`${body.endsWith('\r\n') ? body : `${body}\r\n`}.\r\n`);
    await expect(250);
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}

/** 기관 수신 이메일로 신고를 보낸다. 상태 조회는 지원하지 않는다. */
export class EmailSender implements SubmissionAdapter {
  readonly name = 'email' as const;
  readonly options: EmailOptions;
  constructor(options: EmailOptions) {
    this.options = options;
  }

  async services(): Promise<Array<{ code: string; name: string }>> {
    return (['streetlight', 'bench', 'sidewalk'] as const).map((f) => ({ code: f, name: FACILITY_KO[f] }));
  }

  async submit(input: { issue: Issue; form: ComplaintForm; photoUrl: string }): Promise<{ agencyRef: string; receiptUrl?: string }> {
    if (!this.options.smtpUrl || !this.options.to) throw new Error('email adapter not configured');
    const res = await fetch(input.photoUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`photo fetch ${res.status}`);
    const content = new Uint8Array(await res.arrayBuffer());
    const from = this.options.from || 'no-reply@example.test';
    const messageId = `${input.issue.receiptNo}.${randomBytes(6).toString('hex')}@civicshot.example.test`;
    const raw = buildMime({
      from,
      to: this.options.to,
      subject: `[${input.issue.receiptNo}] ${input.form.title}`,
      text: `${input.form.body}\n\n접수번호: ${input.issue.receiptNo}\n위치: ${input.issue.addressLabel}\n담당: ${input.issue.department}\n`,
      attachment: { filename: `${input.issue.receiptNo}.jpg`, contentType: 'image/jpeg', content },
      messageId,
    });
    await sendMail(this.options.smtpUrl, { from, to: this.options.to }, raw);
    return { agencyRef: `email:${messageId}` };
  }

  async getStatus(_agencyRef: string): Promise<{ status: IssueStatus; updatedAt: string } | null> {
    return null;
  }
}
