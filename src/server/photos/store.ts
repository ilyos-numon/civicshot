import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const PHOTOS_SUBDIR = 'photos';

export function isJpeg(buf: Uint8Array): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

export interface StrippedJpeg {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * JPEG 마커를 따라가며 APP1~APP15(EXIF·XMP 등)와 COM 세그먼트를 제거한다.
 * SOF 에서 가로·세로를 읽는다. 구조가 깨졌으면 null.
 */
export function stripJpegMetadata(buf: Uint8Array): StrippedJpeg | null {
  if (!isJpeg(buf)) return null;
  const parts: Uint8Array[] = [buf.subarray(0, 2)];
  let width = 0;
  let height = 0;
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) {
      i++;
      marker = buf[i + 1];
    }
    if (marker === undefined) return null;
    if (marker === 0xda) {
      // SOS: 나머지는 압축 데이터 그대로
      parts.push(buf.subarray(i));
      break;
    }
    if (marker === 0xd9) {
      parts.push(buf.subarray(i, i + 2));
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > buf.length) return null;
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (len < 2 || i + 2 + len > buf.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && len >= 7) {
      height = (buf[i + 5]! << 8) | buf[i + 6]!;
      width = (buf[i + 7]! << 8) | buf[i + 8]!;
    }
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) parts.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!width || !height) return null;
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out, width, height };
}

export interface StoredFile {
  id: string;
  path: string; // DATA_DIR 기준 상대경로
  sha256: string;
  bytes: number;
}

export function saveJpeg(dataDir: string, bytes: Uint8Array, id: string = randomUUID()): StoredFile {
  const dir = join(dataDir, PHOTOS_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const rel = `${PHOTOS_SUBDIR}/${id}.jpg`;
  writeFileSync(join(dataDir, rel), bytes);
  return { id, path: rel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

export function sanitizeLat(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= -90 && n <= 90 ? n : null;
}
export function sanitizeLng(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n >= -180 && n <= 180 ? n : null;
}
export function sanitizeTakenAt(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
