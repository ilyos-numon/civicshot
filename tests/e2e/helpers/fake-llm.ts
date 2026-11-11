import { createServer, type Server } from 'node:http';

/**
 * OpenAI 호환 chat/completions 흉내. 요청 본문 텍스트에 든 표지로 응답을 고른다.
 * 기본 응답은 setMode 로 바꾼다: ok | emergency | broken | error | no_image.
 * no_image: 요청에 image_url 이 있으면 400(사진 미지원), 텍스트만이면 ok 와 같다.
 */
export type FakeMode = 'ok' | 'emergency' | 'broken' | 'error' | 'no_image';

export interface FakeLlm {
  url: string;
  setMode(m: FakeMode): void;
  requests: number;
  close(): Promise<void>;
}

const CONTENT: Record<Exclude<FakeMode, 'error' | 'no_image'>, string> = {
  ok: JSON.stringify({ facility: 'bench', fault: 'graffiti', confidence: 0.81, candidates: [{ facility: 'bench', fault: 'graffiti', confidence: 0.81 }] }),
  emergency: JSON.stringify({ facility: 'emergency', fault: null, confidence: 0.95, candidates: [] }),
  broken: '{"facility": "bench", "fault":',
};

export async function startFakeLlm(port: number): Promise<FakeLlm> {
  let mode: FakeMode = 'ok';
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      state.requests++;
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions') || mode === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' }).end('{"error":"fake"}');
        return;
      }
      if (mode === 'no_image' && body.includes('image_url')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'this model does not support image input', type: 'invalid_request_error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: CONTENT[mode === 'no_image' ? 'ok' : mode] } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(port, 'localhost', r));
  return {
    url: `http://localhost:${port}/v1`,
    setMode: (m) => (mode = m),
    get requests() { return state.requests; },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
