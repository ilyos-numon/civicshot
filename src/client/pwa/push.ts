import { api } from '../api/index.ts';

const VAPID_KEY: string = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';

/** 이 기기·설정에서 완료 알림을 쓸 수 있는지. 공개키가 없거나 브라우저가 지원하지 않으면 false. */
export function pushAvailable(): boolean {
  return (
    VAPID_KEY.trim() !== '' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

export type PushResult = 'subscribed' | 'denied' | 'unavailable' | 'failed';

/** 완료 알림 구독. 권한 거부·미지원은 조용히 결과만 돌려준다(던지지 않는다). */
export async function subscribeToPush(issueId: string): Promise<PushResult> {
  if (!pushAvailable()) return 'unavailable';
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';
    const reg = await withTimeout(navigator.serviceWorker.ready, 5000);
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_KEY.trim()) }));
    await api.subscribePush({ issueId, subscription: sub.toJSON() });
    return 'subscribed';
  } catch {
    return 'failed';
  }
}
