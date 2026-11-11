import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import { createRequest, getRequest, isServiceCode, listRequests, MOCK_SERVICES, toOpen311 } from './store.ts';
import { patchAgencyRequest } from './server.ts';

/** 앱 안의 모의 기관: Open311 GeoReport v2 서브셋 + 담당자 admin. */
export function mockAgencyRoutes(app: Hono, ctx: AppContext): void {
  const { db, config } = ctx;

  app.get('/mock-agency/v2/services.json', (c) => c.json(MOCK_SERVICES));

  app.post('/mock-agency/v2/requests.json', async (c) => {
    let form: Record<string, string | File>;
    try {
      form = (await c.req.parseBody()) as Record<string, string | File>;
    } catch {
      return c.json({ error: 'invalid_input' }, 400);
    }
    const s = (k: string) => (typeof form[k] === 'string' ? (form[k] as string) : '');
    if (!s('api_key')) return c.json({ error: 'unauthorized', message: 'api_key' }, 403);
    const serviceCode = s('service_code');
    const lat = Number(s('lat'));
    const lng = Number(s('long'));
    if (!isServiceCode(serviceCode) || s('lat') === '' || s('long') === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return c.json({ error: 'invalid_input' }, 400);
    }
    const r = createRequest(db, { serviceCode, description: s('description'), lat, lng, mediaUrl: s('media_url') || null });
    return c.json([{ service_request_id: r.id }], 201);
  });

  app.get('/mock-agency/v2/requests/:file', (c) => {
    const id = c.req.param('file').replace(/\.json$/, '');
    const r = getRequest(db, id);
    if (!r) return c.json({ error: 'not_found' }, 404);
    return c.json([toOpen311(r)]);
  });

  app.get('/mock-agency/admin/requests', (c) => c.json(listRequests(db)));

  app.patch('/mock-agency/admin/requests/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { status?: unknown; completionPhotoId?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid_input' }, 422);
    const result = await patchAgencyRequest(db, config.selfBaseUrl, c.req.param('id'), body);
    if (!result.ok) return c.json({ error: result.error, ...(result.message ? { message: result.message } : {}) }, result.status);
    return c.json(result.request);
  });
}
