import { ISSUE_STATUSES, STATUS_KO, type IssueStatus } from '../../shared/types.ts';
import '../styles/base.css';

export function StatusSteps({ status }: { status: IssueStatus }) {
  const at = ISSUE_STATUSES.indexOf(status);
  return (
    <ol className="cs-steps" data-testid="status-steps" aria-label={`진행 상황: ${STATUS_KO[status]}`}>
      {ISSUE_STATUSES.map((s, i) => {
        const cls = i < at ? ' cs-steps__item--done' : i === at ? ' cs-steps__item--current' : '';
        return (
          <li key={s} className={`cs-steps__item${cls}`} aria-current={i === at ? 'step' : undefined} data-step={s}>
            <span className="cs-steps__bar" aria-hidden="true" />
            <span>
              {STATUS_KO[s]}
              {i === at && <span className="cs-sr"> (현재 단계)</span>}
            </span>
            {i === at && <span className="cs-steps__mark" aria-hidden="true">지금</span>}
            {i < at && <span className="cs-sr"> (끝남)</span>}
          </li>
        );
      })}
    </ol>
  );
}
