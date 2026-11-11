import { createServer, type Server } from 'node:http';

/**
 * 로컬 푸시 수신기 (SINK_PORT). `POST /push` 를 모으고, `GET /received` 로 목록, `DELETE /received` 로 초기화.
 * 외부로 아무것도 보내지 않는다. 직접 실행하면(`node tests/e2e/helpers/sink.ts`) SINK_PORT 에서 듣는다.
 */
export function startPushSink(port: number): Promise<Server> {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.url === '/push' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        try { received.push(JSON.parse(raw)); send(201, { ok: true }); } catch { send(400, { error: 'bad_json' }); }
      });
      return;
    }
    if (req.url === '/received' && req.method === 'GET') return send(200, received);
    if (req.url === '/received' && req.method === 'DELETE') { received.length = 0; return send(204); }
    if (req.url === '/health') return send(200, { ok: true });
    send(404, { error: 'not_found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', () => resolve(server));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.SINK_PORT ?? 8974);
  void startPushSink(port).then(() => console.log(`push sink listening on ${port}`));
}
