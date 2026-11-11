import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, isMockApi } from '../../api/index.ts';
import { HttpError } from '../../api/client.ts';
import { extractPhotoMeta, reencode } from '../../lib/photo.ts';
import { Button, buttonClass } from '../../components/Button.tsx';
import { Loading } from '../../components/Loading.tsx';
import { ErrorState } from '../../components/ErrorState.tsx';
import { OfflineBanner } from '../../components/OfflineBanner.tsx';
import { errorCode, isOutOfScope, makePreview, resetFlow, scenario, takeMeToo, writeFlow } from './flow.ts';
import '../../styles/base.css';

const SAMPLES = [
  { name: 'streetlight', label: '가로등' },
  { name: 'bench', label: '벤치' },
  { name: 'sidewalk', label: '보도블록' },
] as const;

type Phase = 'idle' | 'busy' | 'error' | 'unavailable' | 'limited';

const NOTICE = '사진은 확인을 위해 해외에 있는 외부 서비스로 보내질 수 있어요. 기기 정보와 위치는 함께 보내지 않아요.';

export function Capture() {
  const nav = useNavigate();
  const [phase, setPhase] = useState<Phase>('idle');
  const fileRef = useRef<File | null>(null);
  const [external, setExternal] = useState(false);
  const [limit, setLimit] = useState<{ scope?: string; retryAfterSec?: number }>({});

  // 사진이 외부로 나가는 서버일 때만 고지한다. 조회 실패는 조용히 넘긴다.
  useEffect(() => {
    if (isMockApi) return;
    let alive = true;
    api.status().then(
      (s) => alive && setExternal(s.backends?.vision === 'qwen'),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  async function run(file: File) {
    setPhase('busy');
    try {
      const meToo = takeMeToo();
      resetFlow();
      const [meta, preview] = await Promise.all([extractPhotoMeta(file), makePreview(file)]);
      const blob = await reencode(file);
      const photo = await api.uploadPhoto({ file: blob, lat: meta.lat, lng: meta.lng, takenAt: meta.takenAt });
      let cls;
      try {
        cls = await api.classify({ photoId: photo.id });
      } catch (e) {
        if (e instanceof HttpError && e.error === 'rate_limited') {
          setLimit({ scope: e.scope, retryAfterSec: e.retryAfterSec });
          setPhase('limited');
          return;
        }
        throw e;
      }
      // 사진 확인 자체가 안 됐으면 '받지 않는 시설'로 안내하지 않고 다시 해 보게 한다.
      if (cls.error === 'vision_unavailable' && !meToo && scenario() === null) {
        setPhase('unavailable');
        return;
      }
      // "나도 신고": 사진만으로 시설을 알아보지 못했으면 상태 화면에서 고른 시설을 쓴다. 응급은 그대로 둔다.
      const useMeToo = meToo && cls.facility === 'unsupported';
      const facility = scenario() ?? (useMeToo ? meToo.facility : cls.facility);
      const fault = useMeToo ? meToo.fault : cls.fault;
      const lat = meta.lat ?? meToo?.lat ?? null;
      const lng = meta.lng ?? meToo?.lng ?? null;
      const hasGps = meta.lat !== null && meta.lng !== null;
      writeFlow({ photoId: photo.id, preview, hasGps, lat, lng, facility, fault });
      if (isOutOfScope(facility) && (!cls.error || useMeToo || scenario() !== null)) {
        nav('/emergency');
        return;
      }
      let location = null;
      if (lat !== null && lng !== null) {
        try {
          location = await api.locate({ lat, lng, facility });
        } catch (e) {
          // 지원 지역 밖이면 지도에서 다시 고르게 한다.
          if (errorCode(e) !== 'out_of_coverage') throw e;
        }
      }
      writeFlow({ location, needsPlace: !location });
      nav('/confirm');
    } catch {
      setPhase('error');
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    fileRef.current = file;
    void run(file);
  }

  async function onSample(name: string) {
    setPhase('busy');
    try {
      const res = await fetch(`/samples/${name}.jpg`);
      if (!res.ok) throw new Error(String(res.status));
      const file = new File([await res.blob()], `${name}.jpg`, { type: 'image/jpeg' });
      fileRef.current = file;
      await run(file);
    } catch {
      setPhase('error');
    }
  }

  return (
    <main data-testid="screen-capture" className="cs-screen">
      <OfflineBanner />
      {phase === 'busy' ? (
        <Loading text="사진을 확인하고 있어요" />
      ) : (
        <>
          <div className="cs-body">
            <div className="cs-finder" aria-hidden="true">고장 난 곳이 화면에 들어오게 찍어 주세요</div>
            <div className="cs-capture-hero" style={{ flex: 'none' }}>
              <div>
                <h1 className="cs-capture-title">찍고끝</h1>
                <p className="cs-capture-sub">찍으면 끝, 신고는 저희가 할게요</p>
              </div>
              <ol className="cs-howto" aria-label="이렇게 하면 돼요">
                <li>고장 난 가로등·벤치·보도블록을 찍어요</li>
                <li>어디에 무엇을 낼지 저희가 채워요</li>
                <li>확인하고 보내면 끝이에요</li>
              </ol>
              {external && (
                <p className="cs-notice" data-testid="external-notice">
                  {NOTICE}
                </p>
              )}
              {phase === 'unavailable' && (
                <div className="cs-status cs-status--warn" data-testid="vision-unavailable" role="status">
                  <p className="cs-status__text">사진을 확인하지 못했어요. 다시 해 볼래요?</p>
                  <Button
                    variant="secondary"
                    size="md"
                    onClick={() => (fileRef.current ? void run(fileRef.current) : setPhase('idle'))}
                  >
                    다시 해 볼게요
                  </Button>
                </div>
              )}
              {phase === 'limited' && (
                <div className="cs-status cs-status--wait" data-testid="rate-limited" role="status">
                  <p className="cs-status__text">
                    {limit.scope === 'minute'
                      ? `지금은 확인 요청이 많아요. 약 ${limit.retryAfterSec ?? 60}초 뒤에 다시 해 주세요.`
                      : '오늘은 여기까지 확인할 수 있어요. 내일 다시 해 주세요.'}
                  </p>
                  <p className="cs-status__hint">샘플 사진으로는 계속 체험할 수 있어요.</p>
                </div>
              )}
              {phase === 'error' && (
                <ErrorState
                  text="사진을 확인하지 못했어요. 잠시 뒤 다시 해 주세요."
                  onRetry={() => (fileRef.current ? void run(fileRef.current) : setPhase('idle'))}
                />
              )}
            </div>
          </div>
          <div className="cs-dock">
            <input
              id="pick-photo"
              data-testid="pick-photo"
              className="cs-file"
              type="file"
              accept="image/*"
              capture="environment"
              onChange={onPick}
            />
            <label htmlFor="pick-photo" className={buttonClass('primary', 'lg', true)} style={{ minHeight: 64 }}>
              사진 찍기
            </label>
            <p className="cs-note" style={{ textAlign: 'center' }}>앨범에 있는 사진도 고를 수 있어요</p>
            <section className="cs-samples" aria-labelledby="cs-samples-title">
              <h2 id="cs-samples-title" className="cs-samples-title">사진이 없나요? 샘플로 체험해 보기</h2>
              <div className="cs-samples-row">
                {SAMPLES.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    data-testid={`sample-${s.name}`}
                    className="cs-sample-btn"
                    onClick={() => void onSample(s.name)}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
