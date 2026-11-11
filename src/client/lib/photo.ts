import exifr from 'exifr';
import Compressor from 'compressorjs';

export interface PhotoMeta {
  lat: number | null;
  lng: number | null;
  takenAt: string | null;
}

export const LONG_EDGE = 1600;
export const QUALITY = 0.8;

/** 사진 안의 촬영 위치·시각을 읽는다. 없으면 null. */
export async function extractPhotoMeta(file: Blob): Promise<PhotoMeta> {
  let lat: number | null = null;
  let lng: number | null = null;
  let takenAt: string | null = null;
  try {
    const gps = await exifr.gps(file);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      lat = gps.latitude;
      lng = gps.longitude;
    }
  } catch {
    // 위치 정보 없음
  }
  try {
    const tags = (await exifr.parse(file, ['DateTimeOriginal', 'CreateDate'])) as
      | { DateTimeOriginal?: Date; CreateDate?: Date }
      | undefined;
    const d = tags?.DateTimeOriginal ?? tags?.CreateDate;
    if (d instanceof Date && !Number.isNaN(d.getTime())) takenAt = d.toISOString();
  } catch {
    // 촬영 시각 없음
  }
  return { lat, lng, takenAt };
}

async function hasMetadata(blob: Blob): Promise<boolean> {
  try {
    const out = await exifr.parse(blob);
    return out !== undefined && out !== null && Object.keys(out).length > 0;
  } catch {
    return false;
  }
}

function compress(file: Blob): Promise<Blob> {
  return new Promise((resolve, reject) => {
    new Compressor(file, {
      quality: QUALITY,
      maxWidth: LONG_EDGE,
      maxHeight: LONG_EDGE,
      mimeType: 'image/jpeg',
      retainExif: false,
      success: resolve,
      error: reject,
    });
  });
}

async function canvasReencode(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, LONG_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas unavailable');
  g.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', QUALITY),
  );
}

/** 긴 변 1600px·품질 0.8 JPEG 로 다시 만든다. 메타데이터는 남기지 않는다. */
export async function reencode(file: Blob): Promise<Blob> {
  let out: Blob;
  try {
    out = await compress(file);
  } catch {
    return canvasReencode(file);
  }
  if (await hasMetadata(out)) return canvasReencode(file);
  return out.type === 'image/jpeg' ? out : new Blob([out], { type: 'image/jpeg' });
}
