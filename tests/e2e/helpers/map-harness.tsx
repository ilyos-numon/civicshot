import { createRoot } from 'react-dom/client';
import { LocationPicker } from '../../../src/client/components/map/LocationPicker.tsx';
import '../../../src/client/styles/tokens.css';
import {
  enqueueReport,
  flushQueue,
  pendingCount,
  startAutoFlush,
} from '../../../src/client/pwa/offlineQueue.ts';
import type { Api, ReportInput, ReportResult } from '../../../src/shared/types.ts';

// E2E 하네스: 아직 화면에 붙지 않은 컴포넌트·모듈을 브라우저에서 직접 검증한다.
const params = new URLSearchParams(location.search);
const lat = params.get('lat');
const lng = params.get('lng');
const initial = lat && lng ? { lat: Number(lat), lng: Number(lng) } : undefined;

const w = window as unknown as Record<string, unknown>;
w.__picked = null;

const sent: ReportInput[] = [];
const fakeApi = {
  submitReport: async (input: ReportInput) => {
    if (!navigator.onLine) throw new TypeError('Failed to fetch');
    sent.push(input);
    return { reportId: `r${sent.length}` } as ReportResult;
  },
} as unknown as Api;
w.__queue = { enqueueReport, pendingCount, flush: () => flushQueue(fakeApi), sent };
w.__stopAutoFlush = startAutoFlush(fakeApi);

createRoot(document.getElementById('root')!).render(
  <div style={{ padding: 16 }}>
    <LocationPicker initial={initial} onPick={(p) => (w.__picked = p)} />
  </div>,
);
