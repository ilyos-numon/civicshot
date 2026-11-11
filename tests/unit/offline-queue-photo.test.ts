import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api, PhotoUploadInput, ReportInput, ReportResult } from '../../src/shared/types.ts';
import { enqueueReport, flushQueue, listOutbox, memoryStore, setOutboxStore } from '../../src/client/pwa/offlineQueue.ts';

const base = {
  facility: 'streetlight',
  fault: 'light_out',
  location: { lat: 37.5663, lng: 126.9779, sigCode: '11140', sigName: '중구', department: 'd', addressLabel: 'a', source: 'offline' },
  form: { title: 't', body: 'b', source: 'template' },
  reporterToken: 'tok',
} as const;

function fakeApi(opts: { uploadFails?: 'network' | 400 } = {}) {
  const uploads: PhotoUploadInput[] = [];
  const reports: ReportInput[] = [];
  const api = {
    uploadPhoto: async (i: PhotoUploadInput) => {
      uploads.push(i);
      if (opts.uploadFails === 'network') throw new TypeError('Failed to fetch');
      if (opts.uploadFails === 400) throw Object.assign(new Error('unsupported_file'), { status: 400 });
      return { id: `ph-${uploads.length}` };
    },
    submitReport: async (i: ReportInput) => {
      reports.push(i);
      return { reportId: 'r' } as ReportResult;
    },
  } as unknown as Api;
  return { api, uploads, reports };
}

beforeEach(() => setOutboxStore(memoryStore()));
afterEach(() => setOutboxStore(null));

describe('offlineQueue — 사진만 있는 항목', () => {
  it('사진을 먼저 올리고 받은 photoId 로 신고한다', async () => {
    await enqueueReport({ ...base, photoId: '', photo: new Blob([new Uint8Array([1])], { type: 'image/jpeg' }) } as never);
    const { api, uploads, reports } = fakeApi();
    expect(await flushQueue(api)).toEqual({ sent: 1, failed: 0 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].lat).toBe(37.5663);
    expect(reports[0].photoId).toBe('ph-1');
    expect(reports[0]).not.toHaveProperty('photo');
    expect(await listOutbox()).toHaveLength(0);
  });

  it('사진 업로드가 네트워크 오류면 남겨 두고 신고는 보내지 않는다', async () => {
    await enqueueReport({ ...base, photoId: '', photo: new Blob([new Uint8Array([1])]) } as never);
    const { api, reports } = fakeApi({ uploadFails: 'network' });
    expect(await flushQueue(api)).toEqual({ sent: 0, failed: 0 });
    expect(reports).toHaveLength(0);
    expect((await listOutbox())[0].payload.photo).toBeInstanceOf(Blob);
  });

  it('사진 업로드가 4xx 면 영구 실패로 표시한다', async () => {
    await enqueueReport({ ...base, photoId: '', photo: new Blob([new Uint8Array([1])]) } as never);
    const { api, reports } = fakeApi({ uploadFails: 400 });
    expect(await flushQueue(api)).toEqual({ sent: 0, failed: 1 });
    expect(reports).toHaveLength(0);
    expect((await listOutbox())[0].failed?.status).toBe(400);
  });

  it('올린 뒤 신고가 실패하면 다음 번엔 사진을 다시 올리지 않는다', async () => {
    await enqueueReport({ ...base, photoId: '', photo: new Blob([new Uint8Array([1])]) } as never);
    const uploads: unknown[] = [];
    let n = 0;
    const api = {
      uploadPhoto: async () => (uploads.push(1), { id: 'ph-x' }),
      submitReport: async (i: ReportInput) => {
        if (n++ === 0) throw new TypeError('Failed to fetch');
        return { reportId: i.photoId } as ReportResult;
      },
    } as unknown as Api;
    expect(await flushQueue(api)).toEqual({ sent: 0, failed: 0 });
    expect(await flushQueue(api)).toEqual({ sent: 1, failed: 0 });
    expect(uploads).toHaveLength(1);
  });
});
