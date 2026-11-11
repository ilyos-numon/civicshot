import type { Api } from './types.ts';
import { client } from './client.ts';
import { mock } from './mock.ts';

/** 기본은 실제 서버. VITE_API_MODE=mock 일 때만 화면 프로토타입용 목업을 쓴다. */
export const isMockApi = import.meta.env.VITE_API_MODE === 'mock';
export const api: Api = isMockApi ? mock : client;
export type * from './types.ts';
