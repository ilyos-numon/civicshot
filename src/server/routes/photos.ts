import type { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../router.ts';
import { getPhotoRow, insertPhoto, toPhoto } from '../db/photos.ts';
import { MAX_PHOTO_BYTES, sanitizeLat, sanitizeLng, sanitizeTakenAt, saveJpeg, stripJpegMetadata } from '../photos/store.ts';
import { startSweepTimer } from '../retention.ts';

export function photosRoutes(app: Hono, ctx: AppContext): void {
  const { db, config } = ctx;
  startSweepTimer(db, config.sweepMinutes, {
    dataDir: config.dataDir,
    photoTtlDays: config.photoTtlDays,
    reportTtlDays: config.reportTtlDays,
  });

  app.post('/api/photos', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_PHOTO_BYTES + 64 * 1024) return c.json({ error: 'unsupported_file' }, 400);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'unsupported_file' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File) || file.type !== 'image/jpeg' || file.size > MAX_PHOTO_BYTES) {
      return c.json({ error: 'unsupported_file' }, 400);
    }
    const stripped = stripJpegMetadata(new Uint8Array(await file.arrayBuffer()));
    if (!stripped) return c.json({ error: 'unsupported_file' }, 400);
    const stored = saveJpeg(config.dataDir, stripped.bytes);
    const row = {
      id: stored.id,
      path: stored.path,
      lat: sanitizeLat(form.get('lat')),
      lng: sanitizeLng(form.get('lng')),
      taken_at: sanitizeTakenAt(form.get('takenAt')),
      width: stripped.width,
      height: stripped.height,
      bytes: stored.bytes,
      sha256: stored.sha256,
      created_at: new Date().toISOString(),
    };
    if (row.lat === null || row.lng === null) {
      row.lat = null;
      row.lng = null;
    }
    insertPhoto(db, row);
    return c.json(toPhoto({ ...row, purged: 0 }), 201);
  });

  app.get('/api/photos/:id', (c) => {
    const row = getPhotoRow(db, c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    const abs = join(config.dataDir, row.path);
    if (row.purged === 1 || !existsSync(abs)) return c.json({ error: 'gone' }, 410);
    const body = readFileSync(abs);
    return c.body(body, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  });
}
