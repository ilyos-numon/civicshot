import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api, ReportInput, ReportResult } from '../../src/shared/types.ts';
import {
  enqueueReport,
  flushQueue,
  listOutbox,
  memoryStore,
  pendingCount,
  setOutboxStore,
} from '../../src/client/pwa/offlineQueue.ts';

const payload = (photoId: string): ReportInput =>
  ({
    photoId,
    facility: 'streetlight',
    fault: 'off',
    location: { lat: 37.5, lng: 127 },
    form: { title: 't', body: 'b', source: 'template' },
    reporterToken: 'tok',
  }) as unknown as ReportInput;

const result = { reportId: 'r' } as ReportResult;

function fakeApi(submit: (i: ReportInput) => Promise<ReportResult>): { api: Api; calls: ReportInput[] } {
  const calls: ReportInput[] = [];
  const api = {
    submitReport: async (i: ReportInput) => {
      calls.push(i);
      return submit(i);
    },
  } as unknown as Api;
  return { api, calls };
}

const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

beforeEach(() => setOutboxStore(memoryStore()));
afterEach(() => setOutboxStore(null));

describe('offlineQueue', () => {
  it('넣으면 대기 건수가 늘고 id 를 돌려준다', async () => {
    const id = await enqueueReport(payload('p1'));
    expect(id).toBeTypeOf('string');
    expect(await pendingCount()).toBe(1);
  });

  it('사진 Blob 을 함께 저장하고, 전송할 때는 빼고 보낸다', async () => {
    await enqueueReport({ ...payload('p1'), photo: new Blob([new Uint8Array([1, 2])], { type: 'image/jpeg' }) });
    expect((await listOutbox())[0].payload.photo).toBeInstanceOf(Blob);
    const { api, calls } = fakeApi(async () => result);
    expect(await flushQueue(api)).toEqual({ sent: 1, failed: 0 });
    expect(calls[0]).not.toHaveProperty('photo');
  });

  it('전송에 성공한 항목은 지운다', async () => {
    await enqueueReport(payload('p1'));
    await enqueueReport(payload('p2'));
    const { api, calls } = fakeApi(async () => result);
    expect(await flushQueue(api)).toEqual({ sent: 2, failed: 0 });
    expect(calls.map((c) => c.photoId)).toEqual(['p1', 'p2']);
    expect(await pendingCount()).toBe(0);
  });

  it('네트워크 오류면 남겨 두고 다음에 다시 보낸다', async () => {
    await enqueueReport(payload('p1'));
    const down = fakeApi(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await flushQueue(down.api)).toEqual({ sent: 0, failed: 0 });
    expect(await pendingCount()).toBe(1);
    const up = fakeApi(async () => result);
    expect(await flushQueue(up.api)).toEqual({ sent: 1, failed: 0 });
    expect(await pendingCount()).toBe(0);
  });

  it('4xx 같은 영구 오류는 failed 로 세고 지우지 않고 표시한다', async () => {
    await enqueueReport(payload('bad'));
    await enqueueReport(payload('ok'));
    const { api } = fakeApi(async (i) => {
      if (i.photoId === 'bad') throw httpError(422);
      return result;
    });
    expect(await flushQueue(api)).toEqual({ sent: 1, failed: 1 });
    const items = await listOutbox();
    expect(items).toHaveLength(1);
    expect(items[0].failed?.status).toBe(422);
    expect(await pendingCount()).toBe(0);
    // 표시된 항목은 다시 보내지 않는다
    const again = fakeApi(async () => result);
    expect(await flushQueue(again.api)).toEqual({ sent: 0, failed: 0 });
    expect(again.calls).toHaveLength(0);
  });

  it('동시에 flush 해도 한 번만 보낸다', async () => {
    await enqueueReport(payload('p1'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, calls } = fakeApi(async () => {
      await gate;
      return result;
    });
    const a = flushQueue(api);
    const b = flushQueue(api);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual({ sent: 1, failed: 0 });
    expect(rb).toEqual(ra);
    expect(calls).toHaveLength(1);
  });
});
