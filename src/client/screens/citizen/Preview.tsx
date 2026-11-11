import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/index.ts';
import { Button } from '../../components/Button.tsx';
import { Loading } from '../../components/Loading.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { OfflineBanner } from '../../components/OfflineBanner.tsx';
import { enqueueReport } from '../../pwa/offlineQueue.ts';
import { errorCode, isNetworkError, readFlow, reporterToken, writeFlow } from './flow.ts';
import '../../styles/base.css';

export function Preview() {
  const nav = useNavigate();
  const flow = readFlow();
  const [title, setTitle] = useState(flow.form?.title ?? '');
  const [body, setBody] = useState(flow.form?.body ?? '');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>(flow.form ? 'ready' : 'loading');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [queued, setQueued] = useState(false);

  const load = useCallback(async () => {
    const f = readFlow();
    if (!f.photoId || !f.facility || !f.location) {
      nav('/', { replace: true });
      return;
    }
    setPhase('loading');
    try {
      const form = await api.form({
        photoId: f.photoId,
        facility: f.facility,
        fault: f.fault ?? null,
        addressLabel: f.location.addressLabel,
        department: f.location.department,
      });
      writeFlow({ form });
      setTitle(form.title);
      setBody(form.body);
      setPhase('ready');
    } catch (e) {
      const code = errorCode(e);
      if (code === 'emergency' || code === 'unsupported') nav('/emergency', { replace: true });
      else setPhase('error');
    }
  }, [nav]);

  useEffect(() => {
    if (!readFlow().form) void load();
  }, [load]);

  async function submit() {
    const f = readFlow();
    if (!f.photoId || !f.facility || !f.fault || !f.location) return;
    setSending(true);
    setSendError(false);
    const form = { title: title.trim(), body: body.trim(), source: f.form?.source ?? 'template' } as const;
    // 이름·연락처 같은 개인정보는 담지 않는다. 사진은 이미 올라가 있어 photoId 만 넣는다.
    const input = { photoId: f.photoId, facility: f.facility, fault: f.fault, location: f.location, form, reporterToken: reporterToken() };
    const queue = async () => {
      await enqueueReport(input);
      writeFlow({ form });
      setQueued(true);
    };
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queue();
        return;
      }
      const result = await api.submitReport(input);
      writeFlow({ form, result });
      nav(`/receipt/${result.statusToken}`);
    } catch (e) {
      if (isNetworkError(e)) {
        try {
          await queue();
          return;
        } catch {
          /* 저장도 못 하면 아래 오류 안내 */
        }
      }
      setSendError(true);
    } finally {
      setSending(false);
    }
  }

  return (
    <main data-testid="screen-preview" className="cs-screen">
      <OfflineBanner />
      <header className="cs-top">
        <button type="button" className="cs-top__back" aria-label="이전으로" onClick={() => nav('/confirm')}>‹</button>
        <p className="cs-top__brand">찍고끝</p>
        <span className="cs-top__step">2 / 3</span>
      </header>
      {phase === 'loading' && <Loading text="신고 글을 쓰고 있어요" />}
      {phase === 'error' && (
        <div className="cs-body">
          <ErrorState text="신고 글을 만들지 못했어요." onRetry={() => void load()} />
        </div>
      )}
      {phase === 'ready' && (
        <>
          <div className="cs-body">
            <div>
              <h1 className="cs-h1">이 글로 보낼게요</h1>
              <p className="cs-lead">{flow.location?.department ?? '담당 부서'}에 그대로 전달돼요. 고쳐도 괜찮아요.</p>
            </div>
            <div>
              <label className="cs-label" htmlFor="form-title">제목</label>
              <input id="form-title" data-testid="form-title" className="cs-input" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <label className="cs-label" htmlFor="form-body">내용</label>
              <textarea id="form-body" data-testid="form-body" className="cs-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            {queued && (
              <p className="cs-count" role="status" data-testid="queued-notice">
                지금은 인터넷이 끊겨 있어요. 신고는 이 휴대폰에 담아 뒀고, 연결되면 자동으로 보낼게요.
              </p>
            )}
            {sendError && <ErrorState text="보내지 못했어요. 연결을 확인하고 다시 눌러 주세요." onRetry={() => void submit()} />}
          </div>
          <div className="cs-dock">
            <Button
              variant="primary"
              size="lg"
              full
              data-testid="btn-submit"
              loading={sending}
              disabled={queued || !title.trim() || !body.trim()}
              onClick={() => void submit()}
            >
              신고하기
            </Button>
          </div>
        </>
      )}
    </main>
  );
}
