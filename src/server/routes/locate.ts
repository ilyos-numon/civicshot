import type { Hono } from 'hono';
import type { AppContext } from '../router.ts';
import type { Facility, Location } from '../../shared/types.ts';
import { FACILITIES } from '../../shared/types.ts';
import { departmentFor, lookupJurisdiction } from '../geo/jurisdiction.ts';
import { reverseLabel } from '../geo/reverse.ts';

export function locateRoutes(app: Hono, ctx: AppContext): void {
  app.post('/api/locate', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { lat?: unknown; lng?: unknown; facility?: unknown } | null;
    const { lat, lng, facility } = body ?? {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return c.json({ error: 'invalid_input', message: '위치 값이 올바르지 않아요' }, 400);
    }
    if (typeof facility !== 'string' || !(FACILITIES as readonly string[]).includes(facility)) {
      return c.json({ error: 'invalid_input', message: '시설 종류가 올바르지 않아요' }, 400);
    }
    if (facility === 'emergency' || facility === 'unsupported') return c.json({ error: 'unsupported' }, 422);
    const j = lookupJurisdiction(lat, lng);
    if (!j) return c.json({ error: 'out_of_coverage', message: '아직 지원하지 않는 지역이에요' }, 422);
    const label = await reverseLabel(lat, lng, { geocoder: ctx.config.geocoder, nominatimUrl: ctx.config.nominatimUrl, sigName: j.sigName });
    const loc: Location = { lat, lng, sigCode: j.sigCode, sigName: j.sigName, department: departmentFor(j.sigCode, facility as Facility), addressLabel: label.addressLabel, source: label.source };
    return c.json(loc, 200);
  });
}
