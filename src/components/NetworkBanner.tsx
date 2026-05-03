/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { WifiOff } from 'lucide-react';
import { BASE_URL } from '../lib/apiFetch';

const HEALTH_URL = `${BASE_URL}/api/health`;
const POLL_INTERVAL = 5_000; // 5s

/**
 * Hook: polls /api/health + navigator.onLine.
 * Returns true when backend is unreachable OR browser is offline.
 */
export function useNetworkOffline(): boolean {
  const [offline, setOffline] = useState(false);

  const check = useCallback(async () => {
    if (!navigator.onLine) { setOffline(true); return; }
    try {
      const res = await fetch(HEALTH_URL, { method: 'GET', cache: 'no-store' });
      setOffline(!res.ok);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, POLL_INTERVAL);

    const goOffline = () => setOffline(true);
    const goOnline = () => { check(); };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);

    return () => {
      clearInterval(id);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  }, [check]);

  return offline;
}

/**
 * Inline amber indicator for the top bar.
 * Renders a compact pill when offline, null when online.
 */
export function NetworkIndicator({ offline }: { offline: boolean }) {
  if (!offline) return null;
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium text-warning bg-warning/15 border border-warning/30 animate-[slideDown_200ms_ease-out]">
      <WifiOff size={12} />
      <span className="hidden sm:inline">Offline</span>
    </div>
  );
}

/**
 * @deprecated Use useNetworkOffline + NetworkIndicator instead.
 * Kept for backwards compat — renders fixed overlay banner.
 */
export default function NetworkBanner() {
  const offline = useNetworkOffline();
  if (!offline) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[60] bg-warning/15 border-b border-warning/30 px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium text-warning animate-[slideDown_200ms_ease-out]">
      <WifiOff size={14} />
      Connection lost — retrying…
    </div>
  );
}
