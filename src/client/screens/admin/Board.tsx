import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isMockApi } from '../../api/index.ts';
import { reencode } from '../../lib/photo.ts';
import type { Facility, Fault, Issue, IssueStatus } from '../../api/index.ts';
import { ISSUE_STATUSES, STATUS_KO } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { Loading } from '../../components/Loading.tsx';
import { IssueRow } from './IssueRow.tsx';
import { CompleteDialog } from './CompleteDialog.tsx';
import '../../styles/base.css';
import './admin.css';

type Filter = 'all' | IssueStatus;

/** 받침이 있으면 '으로', 없거나 ㄹ 받침이면 '로'. */
function josaRo(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return '(으)로';
  const jong = code % 28;
  return jong === 0 || jong === 8 ? '로' : '으로';
}

// 빈 현황판을 시연용으로 채우는 예시 신고 (화면 안에서 같은 경로로 접수한다)
const SAMPLES: Array<{ facility: Facility; fault: Fault; addressLabel: string; status: IssueStatus }> = [
  { facility: 'streetlight', fault: 'light_out', addressLabel: '서울특별시 중구 세종대로 부근', status: 'received' },
  { facility: 'sidewalk', fault: 'hole', addressLabel: '서울특별시 중구 을지로 2가 부근', status: 'assigned' },
  { facility: 'bench', fault: 'broken', addressLabel: '서울특별시 중구 정동길 부근', status: 'in_progress' },
  { facility: 'streetlight', fault: 'flicker', addressLabel: '서울특별시 중구 남대문로 부근', status: 'received' },
];

async function seedSamples(): Promise<void> {
  for (const s of SAMPLES) {
    const photo = await api.uploadPhoto({ file: new Blob([new Uint8Array(8)], { type: 'image/jpeg' }) });
    const loc = await api.locate({ lat: photo.lat ?? 37.5665, lng: photo.lng ?? 126.978, facility: s.facility });
    const location = { ...loc, addressLabel: s.addressLabel };
    const form = await api.form({ photoId: photo.id, facility: s.facility, fault: s.fault, addressLabel: s.addressLabel, department: loc.department });
    const r = await api.submitReport({ photoId: photo.id, facility: s.facility, fault: s.fault, location, form, reporterToken: 'demo-admin' });
    if (s.status !== 'received' && r.agencyRef) await api.patchAgencyRequest(r.agencyRef, { status: s.status });
  }
}

export function Board() {
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [flashId, setFlashId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Issue | null>(null);
  const [dialogError, setDialogError] = useState<string>();
  const [seeding, setSeeding] = useState(false);
  const [notice, setNotice] = useState('');
  const flashTimer = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const list = await api.listIssues({ limit: 200 });
      setIssues([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.receiptNo.localeCompare(a.receiptNo)));
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => window.clearTimeout(flashTimer.current);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, received: 0, assigned: 0, in_progress: 0, completed: 0 };
    for (const i of issues ?? []) {
      c.all++;
      c[i.status]++;
    }
    return c;
  }, [issues]);
  const visible = (issues ?? []).filter((i) => filter === 'all' || i.status === filter);

  const applyStatus = async (issue: Issue, status: IssueStatus, completionPhotoId?: string) => {
    if (!issue.agencyRef) return;
    setSavingId(issue.id);
    setRowError(({ [issue.id]: _, ...rest }) => rest);
    try {
      await api.patchAgencyRequest(issue.agencyRef, { status, completionPhotoId });
      const fresh = await api.getIssue(issue.id);
      setIssues((list) => list?.map((i) => (i.id === issue.id ? fresh : i)) ?? null);
      setNotice(`접수번호 ${issue.receiptNo} 신고를 '${STATUS_KO[status]}'${josaRo(STATUS_KO[status])} 바꿨어요. 신고한 분 화면에도 반영돼요.`);
      setFlashId(issue.id);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashId(null), 1600);
      return true;
    } catch {
      setRowError((e) => ({ ...e, [issue.id]: '바꾸지 못했어요. 다시 골라 주세요.' }));
      return false;
    } finally {
      setSavingId(null);
    }
  };

  const onChange = (issue: Issue, next: IssueStatus) => {
    if (next === issue.status) return;
    if (next === 'completed') {
      setDialogError(undefined);
      setCompleting(issue);
      return;
    }
    void applyStatus(issue, next);
  };

  const onSaveComplete = async (file: File) => {
    if (!completing) return;
    setDialogError(undefined);
    setSavingId(completing.id);
    try {
      // 메타데이터를 지운 JPEG 으로 다시 만들어 올린다(서버는 JPEG 만 받는다).
      const photo = await api.uploadPhoto({ file: await reencode(file) });
      const ok = await applyStatus(completing, 'completed', photo.id);
      if (ok) setCompleting(null);
      else setDialogError('저장하지 못했어요. 잠시 뒤 다시 눌러 주세요.');
    } catch {
      setSavingId(null);
      setDialogError('사진을 올리지 못했어요. 다시 골라 주세요.');
    }
  };

  const onSeed = async () => {
    setSeeding(true);
    try {
      await seedSamples();
      await load();
    } catch {
      setLoadError(true);
    } finally {
      setSeeding(false);
    }
  };

  const filters: Filter[] = ['all', ...ISSUE_STATUSES];

  return (
    <main data-testid="screen-admin" className="ad-screen">
      <p className="ad-demo" data-testid="admin-demo-banner">
        <span className="ad-demo__tag">DEMO</span>
        데모용 관리자 화면이에요. 실제 지자체와 연결되어 있지 않아요
      </p>
      <div className="ad-wrap">
        <header className="ad-head">
          <div>
            <p className="ad-head__brand">찍고끝 담당자</p>
            <h1 className="ad-head__title">신고 현황판</h1>
            <p className="ad-head__meta">
              {issues ? `처리할 신고 ${counts.all - counts.completed}건 · 전체 ${counts.all}건` : '신고를 불러오고 있어요'}
            </p>
          </div>
          {issues && issues.length > 0 && (
            <Button variant="secondary" size="md" onClick={() => void load()}>새로고침</Button>
          )}
        </header>

        {loadError ? (
          <ErrorState text="신고 목록을 불러오지 못했어요." onRetry={() => void load()} />
        ) : !issues ? (
          <Loading text="신고 목록을 불러오고 있어요" />
        ) : issues.length === 0 ? (
          <section className="ad-empty cs-card" data-testid="admin-empty">
            <h2 className="ad-empty__title">접수된 신고가 없어요</h2>
            <p className="ad-empty__text">
              시민이 사진으로 신고하면 여기에 바로 올라와요.{isMockApi ? ' 시연하려면 예시 신고를 만들어 보세요.' : ''}
            </p>
            {isMockApi && (
              <Button variant="primary" size="md" data-testid="admin-seed" loading={seeding} onClick={() => void onSeed()}>
                예시 신고 4건 만들기
              </Button>
            )}
          </section>
        ) : (
          <>
            <div className="ad-filters" role="group" aria-label="상태로 거르기">
              {filters.map((f) => (
                <button
                  key={f}
                  type="button"
                  className="ad-filter"
                  data-testid={`admin-filter-${f}`}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? '전체' : STATUS_KO[f]}
                  <span className="ad-filter__n">{counts[f]}</span>
                </button>
              ))}
            </div>
            <p className="ad-toast" role="status" aria-live="polite">{notice}</p>
            {visible.length === 0 ? (
              <section className="ad-empty cs-card" data-testid="admin-empty-filter">
                <h2 className="ad-empty__title">'{filter === 'all' ? '전체' : STATUS_KO[filter]}' 상태인 신고가 없어요</h2>
                <Button variant="secondary" size="md" onClick={() => setFilter('all')}>전체 보기</Button>
              </section>
            ) : (
              <div className="ad-table-wrap">
                <table className="ad-table">
                  <thead>
                    <tr>
                      <th scope="col">접수번호 · 시각</th>
                      <th scope="col">시설 · 고장</th>
                      <th scope="col">위치 · 담당</th>
                      <th scope="col">신고</th>
                      <th scope="col">처리 상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((i) => (
                      <IssueRow
                        key={i.id}
                        issue={i}
                        saving={savingId === i.id}
                        flash={flashId === i.id}
                        error={rowError[i.id]}
                        onChange={onChange}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
      <CompleteDialog
        issue={completing}
        saving={!!completing && savingId === completing.id}
        error={dialogError}
        onCancel={() => setCompleting(null)}
        onSave={(f) => void onSaveComplete(f)}
      />
    </main>
  );
}
