import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import exifr from 'exifr';
import { openDb, migrate } from '../../src/server/db/db.ts';
import { getPhotoRow, insertPhoto } from '../../src/server/db/photos.ts';
import { isJpeg, saveJpeg, sanitizeLat, sanitizeLng, stripJpegMetadata } from '../../src/server/photos/store.ts';
import { runSweep } from '../../src/server/retention.ts';

const FIXTURE = new URL('../e2e/fixtures/photos/streetlight.jpg', import.meta.url);

describe('stripJpegMetadata', () => {
  it('GPS 가 든 사진에서 메타데이터를 지우고 크기를 읽는다', async () => {
    const src = new Uint8Array(readFileSync(FIXTURE));
    expect((await exifr.gps(Buffer.from(src)))?.latitude).toBeTypeOf('number');
    const out = stripJpegMetadata(src);
    expect(out).not.toBeNull();
    expect(out!.width).toBe(1280);
    expect(out!.height).toBe(960);
    expect(isJpeg(out!.bytes)).toBe(true);
    expect(await exifr.parse(Buffer.from(out!.bytes))).toBeUndefined();
  });
  it('JPEG 가 아니면 null', () => {
    expect(stripJpegMetadata(new TextEncoder().encode('hello world'))).toBeNull();
  });
});

describe('saveJpeg', () => {
  it('DATA_DIR 기준 상대경로·sha256 을 돌려준다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-store-'));
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1]);
    const s = saveJpeg(dir, bytes, 'abc');
    expect(s.path).toBe('photos/abc.jpg');
    expect(readFileSync(join(dir, s.path))).toEqual(Buffer.from(bytes));
    expect(s.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});

describe('좌표 범위', () => {
  it('범위를 벗어나면 null', () => {
    expect(sanitizeLat('37.5')).toBe(37.5);
    expect(sanitizeLat('91')).toBeNull();
    expect(sanitizeLng('-181')).toBeNull();
    expect(sanitizeLng('')).toBeNull();
    expect(sanitizeLng(null)).toBeNull();
  });
});

describe('runSweep', () => {
  it('보존 기간이 지난 사진만 지운다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-sweep-'));
    const db = openDb(':memory:');
    migrate(db);
    const now = new Date('2026-11-10T00:00:00Z');
    const mk = (id: string, created: Date) => {
      const s = saveJpeg(dir, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), id);
      insertPhoto(db, { id, path: s.path, lat: null, lng: null, taken_at: null, width: 1, height: 1, bytes: s.bytes, sha256: s.sha256, created_at: created.toISOString() });
    };
    mk('old', new Date(now.getTime() - 8 * 86_400_000));
    mk('new', new Date(now.getTime() - 1 * 86_400_000));
    const r = runSweep(db, now, { dataDir: dir, photoTtlDays: 7, reportTtlDays: 30 });
    expect(r.photosPurged).toBe(1);
    expect(getPhotoRow(db, 'old')!.purged).toBe(1);
    expect(getPhotoRow(db, 'new')!.purged).toBe(0);
    expect(existsSync(join(dir, 'photos/old.jpg'))).toBe(false);
    expect(existsSync(join(dir, 'photos/new.jpg'))).toBe(true);
  });
});
