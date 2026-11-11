import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './leaflet.css';
import { Button } from '../Button.tsx';

export interface LatLng {
  lat: number;
  lng: number;
}

export interface LocationPickerProps {
  initial?: LatLng;
  onPick(p: LatLng): void;
}

/** 서울시청 근처 */
const DEFAULT_CENTER: LatLng = { lat: 37.5663, lng: 126.9779 };

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function LocationPicker({ initial, onPick }: LocationPickerProps) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const start = initial ?? DEFAULT_CENTER;
  const [center, setCenter] = useState<LatLng>(start);

  useEffect(() => {
    if (!el.current) return;
    const map = L.map(el.current, { center: [start.lat, start.lng], zoom: 17, zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    const sync = () => {
      const c = map.getCenter();
      setCenter({ lat: round(c.lat), lng: round(c.lng) });
    };
    map.on('move', sync);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // 초기 위치는 처음 한 번만 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setCoord = (key: 'lat' | 'lng', v: string) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const next = { ...center, [key]: n };
    if (Math.abs(next.lat) > 90 || Math.abs(next.lng) > 180) return;
    mapRef.current?.setView([next.lat, next.lng]);
    setCenter(next);
  };

  return (
    <div className="cs-picker" data-testid="location-picker">
      <p className="cs-picker__hint">지도를 움직여 정확한 위치를 맞춰 주세요.</p>
      <div className="cs-picker__frame">
        <div ref={el} className="cs-picker__map" data-testid="location-map" aria-label="위치 지도" />
        <div className="cs-picker__pin" aria-hidden="true" />
      </div>
      <details className="cs-picker__coords">
        <summary>위도·경도로 직접 입력</summary>
        <div className="cs-picker__coords-row">
          <label>
            위도
            <input
              type="number"
              step="0.000001"
              inputMode="decimal"
              value={center.lat}
              onChange={(e) => setCoord('lat', e.target.value)}
              data-testid="input-lat"
            />
          </label>
          <label>
            경도
            <input
              type="number"
              step="0.000001"
              inputMode="decimal"
              value={center.lng}
              onChange={(e) => setCoord('lng', e.target.value)}
              data-testid="input-lng"
            />
          </label>
        </div>
      </details>
      <Button variant="primary" size="lg" full data-testid="btn-pick-location" onClick={() => onPick(center)}>
        여기로 할게요
      </Button>
    </div>
  );
}
