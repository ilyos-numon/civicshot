import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import type { Fault } from '../../shared/types.ts';
import { buildForm, generateForm, isValidPair } from '../form/index.ts';
import { clientIp, limiterFor } from '../ratelimit.ts';

interface FormBody {
  photoId?: unknown;
  facility?: unknown;
  fault?: unknown;
  addressLabel?: unknown;
  department?: unknown;
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function formRoutes(app: Hono, ctx: AppContext): void {
  app.post('/api/form', async (c) => {
    const b = (await c.req.json().catch(() => null)) as FormBody | null;
    if (!b || typeof b !== 'object') return c.json({ error: 'invalid_input' }, 400);
    if (b.facility === 'emergency') return c.json({ error: 'emergency' }, 422);
    if (b.facility === 'unsupported') return c.json({ error: 'unsupported' }, 422);
    if (!nonEmpty(b.photoId) || !nonEmpty(b.addressLabel) || !nonEmpty(b.department) || !isValidPair(b.facility, b.fault)) {
      return c.json({ error: 'invalid_input' }, 400);
    }
    const input = { facility: b.facility, fault: b.fault as Fault, addressLabel: b.addressLabel.trim(), department: b.department.trim() };
    const cfg = ctx.config;
    if (cfg.llmBackend === 'qwen' && cfg.llmApiKey) {
      const r = await limiterFor(cfg).consume(clientIp(c, cfg.trustedProxyHops));
      if (!r.ok) {
        console.info(`form llm skipped: rate_limited scope=${r.scope}`);
        return c.json(buildForm(input), 200);
      }
    }
    const form = await generateForm(input, cfg);
    return c.json(form, 200);
  });
}
