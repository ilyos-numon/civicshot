import type { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { AppContext } from '../router.ts';
import { classify, needsExternalCall } from '../vision/index.ts';
import { clientIp, limiterFor, rateLimited } from '../ratelimit.ts';

interface PhotoRow {
  path: string;
  sha256: string | null;
  lat: number | null;
  lng: number | null;
  purged: number;
}

export function classifyRoutes(app: Hono, ctx: AppContext): void {
  app.post('/api/classify', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { photoId?: unknown } | null;
    const photoId = typeof body?.photoId === 'string' ? body.photoId : null;
    if (!photoId) return c.json({ error: 'not_found' }, 404);
    const row = ctx.db.prepare('SELECT path, sha256, lat, lng, purged FROM photos WHERE id=?').get(photoId) as PhotoRow | undefined;
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.purged) return c.json({ error: 'purged' }, 410);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(ctx.config.dataDir, row.path));
    } catch {
      return c.json({ error: 'not_found' }, 404);
    }
    const input = { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), lat: row.lat, lng: row.lng };
    const external = needsExternalCall(input, ctx.config);
    if (external) {
      const r = await limiterFor(ctx.config).consume(clientIp(c, ctx.config.trustedProxyHops));
      if (!r.ok) {
        console.info(`classify rate_limited scope=${r.scope}`);
        return rateLimited(c, r);
      }
    }
    const started = Date.now();
    const result = await classify(input, ctx.config);
    const sample = ctx.config.visionBackend === 'qwen' && !external;
    console.info(
      `classify facility=${result.facility} fault=${result.fault ?? 'null'} confidence=${result.confidence.toFixed(2)} source=${result.source} error=${result.error ?? '-'} sample=${sample} ms=${Date.now() - started}`,
    );
    return c.json(result, 200);
  });
}
