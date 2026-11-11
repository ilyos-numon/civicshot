import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Fault } from '../../api/index.ts';
import { FACILITY_KO, FAULTS, FAULT_KO } from '../../../shared/types.ts';
import { Button } from '../../components/Button.tsx';
import { Field } from '../../components/Field.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { PhotoFrame } from '../../components/PhotoFrame.tsx';
import { OfflineBanner } from '../../components/OfflineBanner.tsx';
import { LocationPicker, type LatLng } from '../../components/map/LocationPicker.tsx';
import { errorCode, readFlow, writeFlow, type FlowState } from './flow.ts';
import '../../styles/base.css';

type Editing = null | 'facility' | 'fault' | 'location';
type Supported = keyof typeof FAULTS;
const SUPPORTED: Supported[] = ['streetlight', 'bench', 'sidewalk'];

export function Confirm() {
  const nav = useNavigate();
  const [flow, setFlow] = useState<FlowState>(() => readFlow());
  // 위치가 없으면(GPS 없음·지원 지역 밖) 지도부터 연다.
  const [editing, setEditing] = useState<Editing>(() => (flow.photoId && !flow.location ? 'location' : null));
  const [busy, setBusy] = useState(false);
  const [placeError, setPlaceError] = useState('');
  const [edited, setEdited] = useState<Record<string, boolean>>({});

  const update = (patch: Partial<FlowState>) => setFlow(writeFlow(patch));
  const mark = (k: string) => setEdited((e) => ({ ...e, [k]: true }));
  const facility = flow.facility as Supported | undefined;

  if (!flow.photoId || !facility || !SUPPORTED.includes(facility)) {
    return (
      <main data-testid="screen-confirm" className="cs-screen">
        <div className="cs-body">
          <h1 className="cs-h1">찍은 사진이 없어요</h1>
          <p className="cs-lead">처음 화면에서 사진을 먼저 찍어 주세요.</p>
        </div>
        <div className="cs-dock">
          <Button variant="primary" size="lg" full onClick={() => nav('/')}>사진 찍으러 가기</Button>
        </div>
      </main>
    );
  }

  async function pickPlace(p: LatLng) {
    setBusy(true);
    setPlaceError('');
    try {
      const location = await api.locate({ lat: p.lat, lng: p.lng, facility: facility! });
      update({ location, lat: p.lat, lng: p.lng, needsPlace: false, placeText: undefined });
      mark('location');
      setEditing(null);
    } catch (e) {
      setPlaceError(
        errorCode(e) === 'out_of_coverage'
          ? '아직 이 지역은 받지 않아요. 서울 안에서 골라 주세요.'
          : '위치를 확인하지 못했어요. 다시 눌러 주세요.',
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(flow.fault && flow.location);
  const faultLabel = flow.fault ? FAULT_KO[flow.fault] : '';

  return (
    <main data-testid="screen-confirm" className="cs-screen">
      <OfflineBanner />
      <header className="cs-top">
        <button type="button" className="cs-top__back" aria-label="다시 찍기" onClick={() => nav('/')}>‹</button>
        <p className="cs-top__brand">찍고끝</p>
        <span className="cs-top__step">1 / 3</span>
      </header>
      <div className="cs-body">
        <div>
          <h1 className="cs-h1">이렇게 신고할게요</h1>
          <p className="cs-lead">맞지 않는 칸만 고쳐 주세요.</p>
        </div>
        {flow.preview && <PhotoFrame src={flow.preview} />}
        <section className="cs-card cs-fields" aria-label="신고 내용">
          <div data-testid="field-facility">
            <Field label="시설" value={FACILITY_KO[facility]} auto={!edited.facility} onEdit={() => setEditing('facility')} />
          </div>
          <div data-testid="field-fault">
            <Field label="고장" value={faultLabel} auto={!edited.fault} onEdit={() => setEditing('fault')} />
          </div>
          <div data-testid="field-location">
            <Field
              label="위치"
              value={flow.location?.addressLabel ?? ''}
              auto={!edited.location}
              hint={flow.location ? undefined : '사진에 위치가 없어요. 지도에서 골라 주세요.'}
              onEdit={() => setEditing('location')}
            />
          </div>
          <div data-testid="field-department">
            <Field
              label="담당"
              value={flow.location?.department ?? ''}
              auto
              hint={flow.location ? undefined : '위치를 고르면 찾아 드려요'}
            />
          </div>
        </section>
      </div>
      <div className="cs-dock">
        <Button variant="primary" size="lg" full data-testid="btn-next" disabled={!ready} onClick={() => nav('/preview')}>
          다음
        </Button>
      </div>

      <Sheet open={editing === 'facility'} title="어떤 시설인가요?" onClose={() => setEditing(null)}>
        <div className="cs-choices">
          {SUPPORTED.map((f) => (
            <button
              key={f}
              type="button"
              className="cs-choice"
              aria-pressed={f === facility}
              onClick={() => {
                update({ facility: f, fault: f === facility ? flow.fault : FAULTS[f][0] });
                mark('facility');
                if (f !== facility) mark('fault');
                setEditing(null);
              }}
            >
              {FACILITY_KO[f]}
              {f === facility && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={editing === 'fault'} title="어디가 고장 났나요?" onClose={() => setEditing(null)}>
        <div className="cs-choices">
          {FAULTS[facility].map((f: Fault) => (
            <button
              key={f}
              type="button"
              className="cs-choice"
              aria-pressed={f === flow.fault}
              onClick={() => {
                update({ fault: f });
                mark('fault');
                setEditing(null);
              }}
            >
              {FAULT_KO[f]}
              {f === flow.fault && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      </Sheet>
      <Sheet open={editing === 'location'} title="어디인가요?" onClose={() => setEditing(null)}>
        <LocationPicker
          initial={flow.lat != null && flow.lng != null ? { lat: flow.lat, lng: flow.lng } : undefined}
          onPick={(p) => void (busy ? undefined : pickPlace(p))}
        />
        {busy && <p className="cs-note" role="status">위치를 확인하고 있어요</p>}
        {placeError && <p className="cs-field__hint" role="alert" data-testid="place-error">{placeError}</p>}
      </Sheet>
    </main>
  );
}
