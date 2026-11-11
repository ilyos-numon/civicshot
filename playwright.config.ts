import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.API_PORT ?? 8870);
const E2E_PORT = Number(process.env.E2E_PORT ?? 8871);
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 8873);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results',
  use: { baseURL: BASE_URL },
  projects: [
    { name: 'mobile-chromium', testIgnore: /ui-(citizen|admin)\.spec\.ts/, use: { ...devices['Pixel 7'] } },
    // 화면 프로토타입 spec 은 백엔드 없이 mock API 로 돈다 (별도 Vite 서버, 포트 MOCK_PORT).
    {
      name: 'mobile-mock',
      testMatch: /ui-(citizen|admin)\.spec\.ts/,
      use: { ...devices['Pixel 7'], baseURL: `http://localhost:${MOCK_PORT}` },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'node src/server/main.ts',
          url: `http://localhost:${API_PORT}/health`,
          env: { PORT: String(API_PORT) },
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: `npx vite --host localhost --port ${E2E_PORT} --strictPort`,
          url: `http://localhost:${E2E_PORT}/`,
          env: { API_PORT: String(API_PORT), VITE_API_MODE: 'real' },
          reuseExistingServer: true,
          timeout: 60_000,
        },
        {
          command: `npx vite --host localhost --port ${MOCK_PORT} --strictPort`,
          url: `http://localhost:${MOCK_PORT}/`,
          env: { API_PORT: String(API_PORT), VITE_API_MODE: 'mock' },
          reuseExistingServer: true,
          timeout: 60_000,
        },
      ],
});
