import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';

/** 로컬 SMTP 수신기 (SINK_PORT). 받은 메일을 파싱해 모아 둔다. 외부로 아무것도 보내지 않는다. */
export interface SmtpSink {
  url: string;
  messages: ParsedMail[];
  envelopes: Array<{ from: string; to: string[] }>;
  close(): Promise<void>;
}

export async function startSmtpSink(port: number): Promise<SmtpSink> {
  const messages: ParsedMail[] = [];
  const envelopes: Array<{ from: string; to: string[] }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    logger: false,
    onData(stream, session, callback) {
      simpleParser(stream)
        .then((mail) => {
          messages.push(mail);
          const from = session.envelope.mailFrom;
          envelopes.push({ from: from ? from.address : '', to: session.envelope.rcptTo.map((r) => r.address) });
          callback();
        })
        .catch((err: Error) => callback(err));
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', () => resolve());
  });
  return {
    url: `smtp://localhost:${port}`,
    messages,
    envelopes,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
