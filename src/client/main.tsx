import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { api } from './api/index.ts';
import { registerServiceWorker } from './pwa/register.tsx';
import { startAutoFlush } from './pwa/offlineQueue.ts';
import './styles/tokens.css';

void registerServiceWorker();
// 오프라인일 때 대기열에 넣은 신고를 연결되면 보낸다. 앱 전체에서 한 번만 건다.
startAutoFlush(api);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
