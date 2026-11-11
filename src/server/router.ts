import { Hono } from 'hono';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import type { SubmissionAdapter } from './submission/adapter.ts';
import { healthRoutes } from './routes/health.ts';
import { statusRoutes } from './routes/status.ts';
import { photosRoutes } from './routes/photos.ts';
import { classifyRoutes } from './routes/classify.ts';
import { locateRoutes } from './routes/locate.ts';
import { formRoutes } from './routes/form.ts';
import { reportsRoutes } from './routes/reports.ts';
import { issuesRoutes } from './routes/issues.ts';
import { pushRoutes } from './routes/push.ts';
import { adminRoutes } from './routes/admin.ts';
import { webhooksRoutes } from './routes/webhooks.ts';
import { testRoutes } from './routes/test.ts';
import { mockAgencyRoutes } from './mock-agency/index.ts';
import { registerStatic } from './static.ts';

/** 모든 라우트 등록 함수가 받는 공유 컨텍스트 (계약 고정). */
export interface AppContext {
  config: Config;
  db: DatabaseSync;
  adapter: SubmissionAdapter;
  live: boolean;
  refused?: string;
}

export type RouteRegistrar = (app: Hono, ctx: AppContext) => void;

/** 고정 목록. 각 단계는 자기 라우트 파일 안만 채운다. */
const REGISTRARS: readonly RouteRegistrar[] = [
  healthRoutes,
  statusRoutes,
  photosRoutes,
  classifyRoutes,
  locateRoutes,
  formRoutes,
  reportsRoutes,
  issuesRoutes,
  pushRoutes,
  adminRoutes,
  webhooksRoutes,
  testRoutes,
  mockAgencyRoutes,
];

export function notImplemented(c: { json: (body: unknown, status: 501) => Response }): Response {
  return c.json({ error: 'not_implemented' }, 501);
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  for (const register of REGISTRARS) register(app, ctx);
  registerStatic(app);
  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });
  return app;
}
