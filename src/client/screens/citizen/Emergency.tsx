import { useNavigate } from 'react-router-dom';
import { buttonClass, Button } from '../../components/Button.tsx';
import { OfflineBanner } from '../../components/OfflineBanner.tsx';
import { readFlow, resetFlow } from './flow.ts';
import '../../styles/base.css';

export function Emergency() {
  const nav = useNavigate();
  const unsupported = readFlow().facility === 'unsupported';

  if (unsupported) {
    return (
      <main data-testid="screen-emergency" className="cs-screen">
        <OfflineBanner />
        <header className="cs-top"><p className="cs-top__brand">찍고끝</p></header>
        <div className="cs-body">
          <div>
            <h1 className="cs-h1">이 시설은 아직 받지 않아요</h1>
            <p className="cs-lead">지금은 가로등·벤치·보도블록 고장만 신고할 수 있어요. 다른 민원은 120 다산콜센터로 문의해 주세요.</p>
          </div>
        </div>
        <div className="cs-dock">
          <a href="tel:120" className={buttonClass('secondary', 'lg', true)}>120에 문의하기</a>
          <Button variant="primary" size="lg" full onClick={() => { resetFlow(); nav('/'); }}>다시 찍기</Button>
        </div>
      </main>
    );
  }

  return (
    <main data-testid="screen-emergency" className="cs-screen">
      <OfflineBanner />
      <header className="cs-top"><p className="cs-top__brand">찍고끝</p></header>
      <div className="cs-body">
        <div>
          <h1 className="cs-h1 cs-emergency-title">지금 바로 전화해 주세요</h1>
          <p className="cs-lead">
            사람이 다쳤거나 위험해 보여요. 이런 일은 신고 글로 기다리면 늦어요. 아래 번호로 바로 연결해 주세요.
          </p>
        </div>
        <ul className="cs-note" style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 6 }}>
          <li>다친 사람·불·연기가 보이면 119</li>
          <li>사고·범죄·위협이 있으면 112</li>
        </ul>
      </div>
      <div className="cs-dock">
        <a href="tel:119" className={`${buttonClass('danger', 'lg', true)} cs-call`}>
          <span className="cs-call__num">119</span>
          <span className="cs-call__what">화재·구급</span>
        </a>
        <a href="tel:112" className={`${buttonClass('secondary', 'lg', true)} cs-call`}>
          <span className="cs-call__num">112</span>
          <span className="cs-call__what">경찰</span>
        </a>
      </div>
    </main>
  );
}
