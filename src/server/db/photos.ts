import type { DatabaseSync } from 'node:sqlite';
import type { Photo } from '../../shared/types.ts';

export interface PhotoRow {
  id: string;
  path: string;
  lat: number | null;
  lng: number | null;
  taken_at: string | null;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  created_at: string;
  purged: number;
}

export function insertPhoto(db: DatabaseSync, row: Omit<PhotoRow, 'purged'>): void {
  db.prepare(
    'INSERT INTO photos (id, path, lat, lng, taken_at, width, height, bytes, sha256, created_at, purged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
  ).run(row.id, row.path, row.lat, row.lng, row.taken_at, row.width, row.height, row.bytes, row.sha256, row.created_at);
}

export function getPhotoRow(db: DatabaseSync, id: string): PhotoRow | undefined {
  return db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as PhotoRow | undefined;
}

export function listExpiredPhotos(db: DatabaseSync, cutoffIso: string): PhotoRow[] {
  return db.prepare('SELECT * FROM photos WHERE purged = 0 AND created_at < ?').all(cutoffIso) as unknown as PhotoRow[];
}

export function markPurged(db: DatabaseSync, id: string): void {
  db.prepare('UPDATE photos SET purged = 1 WHERE id = ?').run(id);
}

export function toPhoto(r: PhotoRow): Photo {
  return {
    id: r.id,
    lat: r.lat,
    lng: r.lng,
    takenAt: r.taken_at,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    createdAt: r.created_at,
    purged: r.purged === 1,
  };
}
