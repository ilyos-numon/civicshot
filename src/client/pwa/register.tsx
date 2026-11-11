/** 서비스워커를 등록한다. 개발 서버·테스트 환경에서 실패해도 앱은 계속 돈다. 새 버전은 자동으로 갱신한다. */
export async function registerServiceWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    // 가상 모듈 타입은 tsconfig 에 없으므로 무시한다(Vite 가 빌드 때 해석한다).
    // @ts-ignore
    const mod: any = await import('virtual:pwa-register');
    const updateSW = mod.registerSW({
      immediate: true,
      onNeedRefresh() {
        void updateSW(true);
      },
    });
  } catch {
    // 서비스워커를 쓸 수 없는 환경: 오프라인 기능 없이 계속한다.
  }
}
