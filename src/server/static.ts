import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** API 접두사. 여기서 못 찾은 경로는 index.html 이 아니라 JSON 404 로 끝난다. */
const API_PREFIXES = ['/api/', '/mock-agency/'];
const isApi = (path: string): boolean => path === '/api' || path === '/mock-agency' || API_PREFIXES.some((p) => path.startsWith(p));

/**
 * 빌드된 SPA(CLIENT_DIST_DIR, 기본 dist/client)를 서빙한다. index.html 이 없으면(개발 중) 아무것도 등록하지 않는다.
 * 모든 API 라우트 다음에 등록해야 한다.
 */
export function registerStatic(app: Hono, distDir: string = process.env.CLIENT_DIST_DIR ?? 'dist/client'): void {
  const indexPath = join(distDir, 'index.html');
  if (!existsSync(indexPath)) return;
  // serveStatic 의 root 는 cwd 기준 상대 경로여야 한다.
  const root = relative(process.cwd(), distDir) || '.';
  const files = serveStatic({
    root,
    onFound: (path, c) => {
      const p = path.replaceAll('\\', '/');
      if (p.includes('/assets/')) c.header('Cache-Control', 'public, max-age=31536000, immutable');
      else if (p.endsWith('/sw.js') || p.endsWith('/index.html') || p.endsWith('/registerSW.js')) c.header('Cache-Control', 'no-cache');
    },
  });
  app.on(['GET', 'HEAD'], '*', async (c, next) => {
    if (isApi(c.req.path)) return next();
    return files(c, next);
  });
  app.on(['GET', 'HEAD'], '*', (c, next) => {
    const path = c.req.path;
    const last = path.slice(path.lastIndexOf('/') + 1);
    if (isApi(path) || last.includes('.')) return next();
    c.header('Cache-Control', 'no-cache');
    return c.html(readFileSync(indexPath, 'utf8'));
  });
}
