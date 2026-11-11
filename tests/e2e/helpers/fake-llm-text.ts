import { createServer, type Server } from 'node:http';

/** 민원 문장용 OpenAI 호환 chat/completions 흉내. setMode 로 응답을 바꾼다. */
export type FakeTextMode = 'ok' | 'banned' | 'broken' | 'error';

export interface FakeLlmText {
  url: string;
  setMode(m: FakeTextMode): void;
  setAddress(a: string): void;
  readonly requests: number;
  close(): Promise<void>;
}

export async function startFakeLlmText(port: number): Promise<FakeLlmText> {
  let mode: FakeTextMode = 'ok';
  let address = '';
  const state = { requests: 0 };
  const content = (): string => {
    if (mode === 'broken') return '{"title": "가로등 신고", "body":';
    const body = mode === 'banned'
      ? `${address} 가로등을 분류기로 확인했습니다. 사진을 첨부했습니다.`
      : `${address}의 가로등이 켜지지 않습니다. 밤길이 어두워 확인을 부탁드립니다. 사진을 첨부했습니다.`;
    return JSON.stringify({ title: '가로등 점등 불량 신고드립니다', body });
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      state.requests++;
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions') || mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"fake"}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: content() } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(port, 'localhost', r));
  return {
    url: `http://localhost:${port}/v1`,
    setMode: (m) => (mode = m),
    setAddress: (a) => (address = a),
    get requests() { return state.requests; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
