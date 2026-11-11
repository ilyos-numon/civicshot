import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type IssueByToken } from '../../api/index.ts';
import { FACILITY_KO, FAULT_KO, STATUS_KO } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { StatusSteps } from '../../components/StatusSteps.tsx';
import { Loading } from '../../components/Loading.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { OfflineBanner } from '../../components/OfflineBanner.tsx';
import { errorCode, resetFlow, setMeToo } from './flow.ts';

const POLL_MS = 5000;
import '../../styles/base.css';

const STATUS_LINE = {
  received: '신고가 접수돼 담당 부서로 넘어가는 중이에요.',
  assigned: '담당자가 정해졌어요. 곧 현장을 살펴봐요.',
  in_progress: '지금 고치고 있어요.',
  completed: '다 고쳤어요. 알려 주셔서 고마워요.',
} as const;

const fmt = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Status() {
  const nav = useNavigate();
  const { token = '' } = useParams();
  const [issue, setIssue] = useState<IssueByToken | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setPhase('loading');
    try {
      setIssue(await api.getIssueByToken(token));
      setPhase('ready');
    } catch (e) {
      if (errorCode(e) === 'not_found') setPhase('missing');
      else if (!quiet) setPhase('error');
    }
  }, [token]);

  useEffect(() => void load(), [load]);

  // 5초마다 다시 읽는다. 완료됐거나 화면이 숨겨져 있으면 멈춘다.
  const done = issue?.status === 'completed';
  useEffect(() => {
    if (phase !== 'ready' || done) return;
    let timer: number | undefined;
    const start = () => {
      if (timer === undefined && document.visibilityState !== 'hidden') timer = window.setInterval(() => void load(true), POLL_MS);
    };
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') stop();
      else {
        void load(true);
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [phase, done, load]);

  const meToo = () => {
    resetFlow();
    if (phase === 'ready' && issue) setMeToo({ facility: issue.facility, fault: issue.fault, lat: issue.lat, lng: issue.lng });
    nav('/');
  };

  return (
    <main data-testid="screen-status" className="cs-screen">
      <OfflineBanner />
      <header className="cs-top">
        <p className="cs-top__brand">찍고끝</p>
        <span className="cs-top__step">진행 상황</span>
      </header>
      {phase === 'loading' && <Loading text="진행 상황을 불러오고 있어요" />}
      {phase === 'error' && (
        <div className="cs-body"><ErrorState text="진행 상황을 불러오지 못했어요." onRetry={() => void load()} /></div>
      )}
      {phase === 'missing' && (
        <div className="cs-body">
          <h1 className="cs-h1" data-testid="status-missing">찾을 수 없는 접수번호예요</h1>
          <p className="cs-lead">QR이나 링크가 맞는지 확인해 주세요. 이곳이 고장 났다면 지금 바로 신고할 수 있어요.</p>
        </div>
      )}
      {phase === 'ready' && issue && (
        <div className="cs-body">
          <div>
            <p className="cs-note">{issue.addressLabel}</p>
            <h1 className="cs-h1" style={{ marginTop: 4 }}>
              {FACILITY_KO[issue.facility]} {FAULT_KO[issue.fault]}
            </h1>
            <p className="cs-lead">
              <strong style={{ color: 'var(--cs-fg)' }}>{STATUS_KO[issue.status]}</strong> · {STATUS_LINE[issue.status]}
            </p>
          </div>
          <section className="cs-card" style={{ padding: 16 }} aria-label="진행 단계">
            <StatusSteps status={issue.status} />
          </section>
          {issue.completionPhotoUrl && (
            <figure className="cs-card" style={{ margin: 0, padding: 12 }}>
              <img
                src={issue.completionPhotoUrl}
                alt="고친 뒤 찍은 사진"
                data-testid="completion-photo"
                style={{ display: 'block', width: '100%', borderRadius: 10 }}
              />
              <figcaption className="cs-note" style={{ marginTop: 8 }}>담당 부서가 고친 뒤 찍은 사진이에요</figcaption>
            </figure>
          )}
          <p className="cs-count" data-testid="report-count">
            이 시설 신고 {issue.reportCount}건{issue.reportCount > 1 ? ' (하나로 묶음)' : ''}
          </p>
          <section className="cs-card">
            <dl className="cs-dl">
              <div><dt>담당</dt><dd>{issue.department}</dd></div>
              <div><dt>접수번호</dt><dd style={{ fontVariantNumeric: 'tabular-nums' }}>{issue.receiptNo}</dd></div>
              <div><dt>접수</dt><dd>{fmt(issue.createdAt)}</dd></div>
            </dl>
          </section>
        </div>
      )}
      {(phase === 'ready' || phase === 'missing') && (
        <div className="cs-dock">
          {phase === 'ready' && <p className="cs-note" style={{ textAlign: 'center' }}>같은 고장을 보셨나요? 신고가 많을수록 빨리 고쳐져요.</p>}
          <Button variant="primary" size="lg" full data-testid="btn-me-too" onClick={meToo}>
            {phase === 'ready' ? '나도 신고' : '새로 신고하기'}
          </Button>
        </div>
      )}
    </main>
  );
}
