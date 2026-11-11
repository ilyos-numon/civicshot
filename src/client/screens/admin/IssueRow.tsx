import { FACILITY_KO, FAULT_KO, ISSUE_STATUSES, STATUS_KO } from '../../../shared/types.ts';
import type { Issue, IssueStatus } from '../../api/index.ts';

export interface IssueRowProps {
  issue: Issue;
  saving: boolean;
  flash: boolean;
  error?: string;
  onChange: (issue: Issue, next: IssueStatus) => void;
}

const fmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export function IssueRow({ issue, saving, flash, error, onChange }: IssueRowProps) {
  const step = ISSUE_STATUSES.indexOf(issue.status);
  const what = `${FACILITY_KO[issue.facility]} ${FAULT_KO[issue.fault]}`;
  return (
    <tr className={`ad-row${flash ? ' ad-row--flash' : ''}`} data-testid={`admin-row-${issue.id}`} data-status={issue.status}>
      <td className="ad-c-receipt">
        <span className="ad-receipt">{issue.receiptNo}</span>
        <time className="ad-time" dateTime={issue.createdAt}>{fmt.format(new Date(issue.createdAt))}</time>
      </td>
      <td className="ad-c-what">
        <span className="ad-what">{FACILITY_KO[issue.facility]}</span>
        <span className="ad-what__fault">{FAULT_KO[issue.fault]}</span>
      </td>
      <td className="ad-c-where">
        <span className="ad-where">{issue.addressLabel}</span>
        <span className="ad-where__dept">{issue.department}</span>
      </td>
      <td className="ad-c-count">
        <span className={`ad-count${issue.reportCount >= 3 ? ' ad-count--many' : ''}`}>{issue.reportCount}건</span>
      </td>
      <td className="ad-c-status">
        <div className="ad-status">
          <select
            className={`ad-select ad-select--${issue.status}`}
            data-testid={`admin-status-${issue.id}`}
            aria-label={`${issue.receiptNo} ${what} 처리 상태`}
            value={issue.status}
            disabled={saving || !issue.agencyRef}
            onChange={(e) => onChange(issue, e.target.value as IssueStatus)}
          >
            {ISSUE_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_KO[s]}</option>
            ))}
          </select>
          <span className="ad-pips" role="img" aria-label={`4단계 중 ${step + 1}단계`}>
            {ISSUE_STATUSES.map((s, i) => (
              <span key={s} className={`ad-pip${i <= step ? ' ad-pip--on' : ''}`} />
            ))}
          </span>
        </div>
        {error && <p className="ad-err" role="alert">{error}</p>}
      </td>
    </tr>
  );
}
