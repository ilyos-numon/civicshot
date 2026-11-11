import { defineConfig, devices } from '@playwright/test';

const API_PORT = Number(process.env.API_PORT ?? 8870);
const PWA_PORT = Number(process.env.PWA_PORT ?? 8872);

export default defineConfig({
  testDir: 'tests/pwa',
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results/pwa',
  use: { baseURL: `http://localhost:${PWA_PORT}`, serviceWorkers: 'allow' },
  projects: [{ name: 'pwa-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: [
    {
      command: 'node src/server/main.ts',
      url: `http://localhost:${API_PORT}/health`,
      env: { PORT: String(API_PORT) },
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: `npm run build && npx vite preview --host localhost --port ${PWA_PORT} --strictPort`,
      url: `http://localhost:${PWA_PORT}/`,
      env: { API_PORT: String(API_PORT) },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
