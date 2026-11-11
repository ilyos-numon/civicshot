import { useEffect, useState } from 'react';
import '../styles/base.css';

export function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="cs-offline" data-testid="offline-banner" role="status">
      <span className="cs-offline__dot" aria-hidden="true" />
      인터넷이 끊겼어요. 연결되면 이어서 보낼게요.
    </div>
  );
}
