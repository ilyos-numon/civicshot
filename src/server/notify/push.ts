import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { FACILITY_KO, type Issue } from '../../shared/types.ts';
import { listSubscriptions } from '../db/push.ts';

export interface PushPayload { title: string; body: string; url: string }

export interface NotifyDeps {
  db: DatabaseSync;
  config: Pick<Config, 'publicBaseUrl' | 'pushSinkUrl' | 'vapidPublicKey' | 'vapidPrivateKey' | 'vapidSubject'>;
  fetchImpl?: typeof fetch;
  sendNotification?: (subscription: unknown, payload: string, options: unknown) => Promise<unknown>;
  log?: (msg: string) => void;
}

type SendFn = (subscription: unknown, payload: string, options: unknown) => Promise<unknown>;

/** web-push 는 타입 선언이 없어 필요할 때만 불러온다. */
async function loadWebPush(): Promise<{ sendNotification: SendFn }> {
  const name = 'web-push';
  const mod = (await import(name)) as { default?: { sendNotification: SendFn }; sendNotification?: SendFn };
  return mod.default ?? (mod as { sendNotification: SendFn });
}

export type PushMode = 'sink' | 'webpush' | 'skip';

/** 마지막 글자 받침이 있으면 '이', 없으면 '가'. 한글이 아니면 '이'. */
export function subjectParticle(word: string): '이' | '가' {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return '이';
  return code % 28 === 0 ? '가' : '이';
}

export function completionPayload(issue: Issue, publicBaseUrl: string): PushPayload {
  return { title: '고쳐졌어요', body: `신고하신 ${FACILITY_KO[issue.facility]}${subjectParticle(FACILITY_KO[issue.facility])} 처리 완료됐어요`, url: `${publicBaseUrl}/s/${issue.statusToken}` };
}

export function pushMode(config: NotifyDeps['config']): PushMode {
  if (config.pushSinkUrl) return 'sink';
  if (config.vapidPublicKey && config.vapidPrivateKey) return 'webpush';
  return 'skip';
}

/**
 * 완료 알림을 이 이슈의 구독마다 보낸다. 실패는 로그 한 줄로 남기고 던지지 않는다.
 * 키·구독 endpoint 는 로그에 쓰지 않는다. 보낸 건수를 돌려준다.
 */
export async function sendCompletionPush(issue: Issue, deps: NotifyDeps): Promise<number> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    const mode = pushMode(deps.config);
    const subs = listSubscriptions(deps.db, issue.id);
    if (subs.length === 0) return 0;
    if (mode === 'skip') {
      log(`push skipped: no push keys configured (${subs.length} subscription(s))`);
      return 0;
    }
    const payload = completionPayload(issue, deps.config.publicBaseUrl);
    let sent = 0;
    for (const s of subs) {
      try {
        if (mode === 'sink') {
          const res = await (deps.fetchImpl ?? fetch)(deps.config.pushSinkUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: s.subscription, payload }),
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) throw new Error(`sink responded ${res.status}`);
        } else {
          const send = deps.sendNotification ?? (await loadWebPush()).sendNotification;
          await send(s.subscription, JSON.stringify(payload), {
            vapidDetails: { subject: deps.config.vapidSubject, publicKey: deps.config.vapidPublicKey, privateKey: deps.config.vapidPrivateKey },
            TTL: 86_400,
          });
        }
        sent++;
      } catch (err) {
        log(`push failed for subscription ${s.id}: ${(err as Error).name}`);
      }
    }
    return sent;
  } catch (err) {
    log(`push failed: ${(err as Error).name}`);
    return 0;
  }
}
