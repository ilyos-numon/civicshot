import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api/index.ts';
import { buttonClass, Button } from '../../components/Button.tsx';
import { OfflineBanner } from '../../components/OfflineBanner.tsx';
import { pushAvailable, subscribeToPush } from '../../pwa/push.ts';
import { readFlow, resetFlow, writeFlow } from './flow.ts';
import '../../styles/base.css';

export function Receipt() {
  const nav = useNavigate();
  const { token = '' } = useParams();
  const flow = readFlow();
  const result = flow.result?.statusToken === token ? flow.result : undefined;
  const canNotify = pushAvailable();
  const [notify, setNotify] = useState(canNotify && Boolean(flow.notify));
  // 새로고침·링크로 들어오면 접수 정보를 서버에서 다시 읽는다.
  const [fetched, setFetched] = useState<{ receiptNo: string; reportCount: number; issueId: string; department: string } | null>(null);
  useEffect(() => {
    if (result || !token) return;
    let alive = true;
    api.getIssueByToken(token).then(
      (i) => alive && setFetched({ receiptNo: i.receiptNo, reportCount: i.reportCount, issueId: i.id, department: i.department }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [result, token]);
  const count = result?.reportCount ?? fetched?.reportCount ?? 1;
  const issueId = result?.issueId ?? fetched?.issueId;

  async function toggleNotify(on: boolean) {
    setNotify(on);
    writeFlow({ notify: on });
    if (!on || !issueId) return;
    // 권한을 거부했거나 실패하면 조용히 끈다.
    const r = await subscribeToPush(issueId);
    if (r !== 'subscribed') {
      setNotify(false);
      writeFlow({ notify: false });
    }
  }

  return (
    <main data-testid="screen-receipt" className="cs-screen">
      <OfflineBanner />
      <header className="cs-top">
        <p className="cs-top__brand">찍고끝</p>
        <span className="cs-top__step">3 / 3</span>
      </header>
      <div className="cs-body">
        <div>
          <span className="cs-done-mark" aria-hidden="true">✓</span>
          <h1 className="cs-h1">신고가 접수됐어요</h1>
          <p className="cs-lead">{flow.location?.department ?? fetched?.department ?? '담당 부서'}로 보냈어요. 이제 기다리기만 하면 돼요.</p>
        </div>

        <section className="cs-card cs-receipt" aria-label="접수 정보">
          <div>
            <p className="cs-note">접수번호</p>
            <p className="cs-receipt__no" data-testid="receipt-no">{result?.receiptNo ?? fetched?.receiptNo ?? ''}</p>
            <p className="cs-note">QR을 찍으면 진행 상황을 볼 수 있어요</p>
          </div>
          <img className="cs-qr" data-testid="qr-image" src={api.qrUrl(token)} alt="진행 상황 보기 QR 코드" />
        </section>

        <p className="cs-count">{count > 1 ? `이미 ${count}명이 신고했어요. 하나로 묶어 전달해요.` : '처음 신고예요. 먼저 알려 주셔서 고마워요.'}</p>

        <label className="cs-card cs-toggle">
          <span>
            <strong style={{ display: 'block' }}>처리되면 알려주세요</strong>
            <span className="cs-note" data-testid="notify-note">
              {canNotify ? '고쳐지면 이 휴대폰으로 알려 드려요' : '이 기기에서는 알림을 쓸 수 없어요'}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={notify}
            disabled={!canNotify}
            onChange={(e) => void toggleNotify(e.target.checked)}
          />
        </label>
      </div>
      <div className="cs-dock">
        <Link to={`/s/${token}`} className={buttonClass('primary', 'lg', true)}>진행 상황 보기</Link>
        <Button variant="secondary" size="md" full onClick={() => { resetFlow(); nav('/'); }}>
          다른 곳 신고하기
        </Button>
      </div>
    </main>
  );
}
