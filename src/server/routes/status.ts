import type { Hono } from 'hono';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import type { AppContext } from '../router.ts';
import type { IssueByToken, StatusResponse } from '../../shared/types.ts';
import { FACILITY_KO, FAULT_KO, STATUS_KO, type Issue } from '../../shared/types.ts';
import { getIssue } from '../db/issues.ts';

/** 빌드된 SPA 디렉터리. 요청마다 읽어 테스트가 서버별로 바꿀 수 있게 한다. */
const spaIndex = (): string => join(process.env.CLIENT_DIST_DIR ?? 'dist/client', 'index.html');

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function page(title: string, main: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:24px 20px;color:#1a1a1a;background:#fafafa;line-height:1.5}h1{font-size:1.4rem;margin:0 0 4px}
.no{font-size:1.1rem;font-weight:700;letter-spacing:.04em}.st{display:inline-block;margin:12px 0;padding:6px 14px;border-radius:999px;background:#1f6feb;color:#fff;font-weight:700}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:16px 0}dt{color:#666}dd{margin:0}p.note{color:#555;font-size:.95rem}</style></head><body><main>${main}</main></body></html>`;
}

const STATUS_NOTE: Record<Issue['status'], string> = {
  received: '신고가 잘 들어갔어요. 담당 부서에서 확인할 거예요.',
  assigned: '담당자가 정해졌어요. 곧 현장을 살펴볼 거예요.',
  in_progress: '지금 고치고 있어요.',
  completed: '다 고쳐졌어요. 신고해 주셔서 고마워요.',
};

export function renderStatusPage(issue: Issue): string {
  const updated = new Date(issue.updatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return page(`찍고끝 · ${STATUS_KO[issue.status]}`, `<h1>찍고끝</h1>
<div>접수번호 <span class="no" data-testid="receipt-no">${esc(issue.receiptNo)}</span></div>
<div class="st" data-testid="status-steps">${esc(STATUS_KO[issue.status])}</div>
<p class="note">${esc(STATUS_NOTE[issue.status])}</p>
<dl><dt>시설</dt><dd>${esc(FACILITY_KO[issue.facility])} · ${esc(FAULT_KO[issue.fault])}</dd>
<dt>같은 신고</dt><dd data-testid="report-count">${issue.reportCount}건</dd>
<dt>담당</dt><dd>${esc(issue.department)}</dd>
<dt>마지막 소식</dt><dd>${esc(updated)}</dd></dl>`);
}

export function renderNotFoundPage(): string {
  return page('찍고끝', '<h1>찍고끝</h1><p data-testid="error-state">찾을 수 없는 접수번호예요. 주소를 다시 확인해 주세요.</p>');
}

export function statusRoutes(app: Hono, ctx: AppContext): void {
  const byToken = (token: string): Issue | null => {
    const row = ctx.db.prepare('SELECT id FROM issues WHERE status_token = ?').get(token) as { id: string } | undefined;
    return row ? getIssue(ctx.db, row.id) : null;
  };
  app.get('/api/status', (c) => {
    const body: StatusResponse = {
      adapter: ctx.adapter.name,
      live: ctx.live,
      ...(ctx.refused ? { refused: ctx.refused } : {}),
      backends: { vision: ctx.config.visionBackend, llm: ctx.config.llmBackend, geocoder: ctx.config.geocoder },
    };
    return c.json(body);
  });
  app.get('/api/issues/by-token/:token/qr.svg', async (c) => {
    const issue = byToken(c.req.param('token'));
    if (!issue) return c.json({ error: 'not_found' }, 404);
    const svg = await QRCode.toString(`${ctx.config.publicBaseUrl}/s/${issue.statusToken}`, { type: 'svg', margin: 1 });
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  });
  app.get('/api/issues/by-token/:token', (c) => {
    const issue = byToken(c.req.param('token'));
    if (!issue) return c.json({ error: 'not_found' }, 404);
    const body: IssueByToken = { ...issue, ...(issue.completionPhotoId ? { completionPhotoUrl: `/api/photos/${issue.completionPhotoId}` } : {}) };
    return c.json(body);
  });
  // 상태 페이지. 빌드된 SPA 가 있으면 그 셸을, 없으면 JS 없이 읽히는 서버 렌더 페이지를 준다.
  app.get('/s/:token', (c) => {
    const issue = byToken(c.req.param('token'));
    c.header('Cache-Control', 'no-store');
    if (!issue) return c.html(renderNotFoundPage(), 404);
    const index = spaIndex();
    if (existsSync(index)) return c.html(readFileSync(index, 'utf8'));
    return c.html(renderStatusPage(issue));
  });
}
