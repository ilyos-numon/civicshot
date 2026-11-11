import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const apiPort = Number(process.env.API_PORT ?? process.env.PORT ?? 8870);
const target = `http://localhost:${apiPort}`;
const proxy = Object.fromEntries(
  ['^/api(/|$)', '^/mock-agency(/|$)', '^/health$'].map((p) => [p, { target, changeOrigin: true }]),
);

export default defineConfig({
  test: { exclude: ['node_modules/**', 'dist/**'] },
  // 개발 서버 콜드 스타트 완화: 의존성을 미리 묶고, 시작할 때 진입 파일을 미리 변환해 둔다.
  // (E2E 가 spec 마다 새 서버를 띄우므로 첫 화면 요청이 느리면 첫 테스트가 시간 초과로 흔들렸다.)
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react-router-dom', 'exifr', 'compressorjs', 'idb', 'leaflet'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      devOptions: { enabled: true },
      manifest: {
        name: '찍고끝',
        short_name: '찍고끝',
        description: '찍으면 끝, 신고는 저희가 할게요',
        lang: 'ko',
        display: 'standalone',
        start_url: '/',
        background_color: '#f7f7f5',
        theme_color: '#1f6feb',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: { proxy, warmup: { clientFiles: ['./index.html', './src/client/main.tsx', './src/client/App.tsx'] } },
  preview: { proxy },
});
