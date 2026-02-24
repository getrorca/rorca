import { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

export default function NetworkBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);

    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] bg-warning/15 border-b border-warning/30 px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium text-warning animate-[slideDown_200ms_ease-out]">
      <WifiOff size={14} />
      Connection lost — retrying…
    </div>
  );
}
