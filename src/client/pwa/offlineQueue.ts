import { openDB } from 'idb';
import type { Api, ReportInput } from '../api/types.ts';

/** 오프라인 제출 대기열에 넣는 신고 페이로드. 이름·연락처 같은 개인정보는 담지 않는다. */
export type ReportRequest = ReportInput & { photo?: Blob };

export interface OutboxItem {
  id: string;
  payload: ReportRequest;
  createdAt: number;
  attempts: number;
  /** 영구 오류(4xx)로 더 보내지 않는 항목. 삭제하지 않고 표시만 한다. */
  failed?: { status: number; message: string };
}

/** 저장소 어댑터. 기본은 IndexedDB(idb), 테스트는 인메모리를 주입한다. */
export interface OutboxStore {
  put(item: OutboxItem): Promise<void>;
  getAll(): Promise<OutboxItem[]>;
  delete(id: string): Promise<void>;
}

const DB_NAME = 'civicshot';
const STORE = 'outbox';

export function idbStore(): OutboxStore {
  const db = () =>
    openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      },
    });
  return {
    async put(item) {
      await (await db()).put(STORE, item);
    },
    async getAll() {
      return (await (await db()).getAll(STORE)) as OutboxItem[];
    },
    async delete(id) {
      await (await db()).delete(STORE, id);
    },
  };
}

export function memoryStore(): OutboxStore {
  const m = new Map<string, OutboxItem>();
  return {
    async put(item) {
      m.set(item.id, structuredClone(item));
    },
    async getAll() {
      return [...m.values()].map((i) => structuredClone(i)).sort((a, b) => a.createdAt - b.createdAt);
    },
    async delete(id) {
      m.delete(id);
    },
  };
}

let store: OutboxStore | null = null;
let flushing: Promise<{ sent: number; failed: number }> | null = null;

/** 테스트용: 저장소를 바꿔 끼운다. null 이면 기본(IndexedDB)으로 돌아간다. */
export function setOutboxStore(s: OutboxStore | null): void {
  store = s;
  flushing = null;
}

function getStore(): OutboxStore {
  if (!store) store = idbStore();
  return store;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** HTTP 4xx 처럼 다시 보내도 소용없는 오류인지. status 가 없으면 네트워크 오류로 본다. */
function permanentStatus(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' && s >= 400 && s < 500 ? s : null;
}

export async function enqueueReport(payload: ReportRequest): Promise<string> {
  const id = newId();
  await getStore().put({ id, payload, createdAt: Date.now(), attempts: 0 });
  return id;
}

/** 아직 보내야 할 항목 수(영구 실패 표시된 항목 제외). */
export async function pendingCount(): Promise<number> {
  return (await getStore().getAll()).filter((i) => !i.failed).length;
}

export async function listOutbox(): Promise<OutboxItem[]> {
  return getStore().getAll();
}

async function doFlush(api: Api): Promise<{ sent: number; failed: number }> {
  const s = getStore();
  let sent = 0;
  let failed = 0;
  for (const item of await s.getAll()) {
    if (item.failed) continue;
    let cur = item;
    try {
      const { photo, ...input } = cur.payload;
      // 사진을 아직 못 올린 항목: 먼저 올리고 받은 photoId 로 바꿔 저장한다(다음 시도에 다시 올리지 않게).
      if (photo && !input.photoId) {
        const uploaded = await api.uploadPhoto({ file: photo, lat: input.location.lat, lng: input.location.lng });
        input.photoId = uploaded.id;
        cur = { ...cur, payload: input };
        await s.put(cur);
      }
      await api.submitReport(input);
      await s.delete(item.id);
      sent++;
    } catch (err) {
      const status = permanentStatus(err);
      if (status !== null) {
        failed++;
        await s.put({
          ...cur,
          attempts: cur.attempts + 1,
          failed: { status, message: err instanceof Error ? err.message : String(err) },
        });
      } else {
        // 네트워크 오류: 남겨 두고 다음 기회에 다시 보낸다. 뒤 항목도 같은 이유로 실패할 테니 멈춘다.
        await s.put({ ...cur, attempts: cur.attempts + 1 });
        break;
      }
    }
  }
  return { sent, failed };
}

/** 대기열을 보낸다. 이미 보내는 중이면 같은 작업을 공유해 중복 전송을 막는다. */
export function flushQueue(api: Api): Promise<{ sent: number; failed: number }> {
  if (!flushing) {
    flushing = doFlush(api).finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

/** 온라인으로 돌아오면 자동으로 보낸다. 해제 함수를 돌려준다. */
export function startAutoFlush(api: Api): () => void {
  const onOnline = () => {
    void flushQueue(api).catch(() => undefined);
  };
  window.addEventListener('online', onOnline);
  if (navigator.onLine) onOnline();
  return () => window.removeEventListener('online', onOnline);
}
