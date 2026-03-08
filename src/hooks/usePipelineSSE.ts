import { useState, useRef } from 'react';
import { useWalSSE, type WalEvent } from './useWalSSE';

export type { WalEvent };

export function usePipelineSSE(runId: string | null, workspaceId?: string | null) {
  const [events, setEvents] = useState<WalEvent[]>([]);

  // Track previous runId so we can reset the event list when it changes.
  // Using a ref comparison + state reset avoids an extra useEffect.
  const prevRunIdRef = useRef<string | null>(runId);
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId;
    // Trigger a synchronous reset before the next render.
    setEvents([]);
  }

  // Register with the shared WAL SSE singleton.
  // useWalSSE keeps the callback in a ref so we don't need useCallback here.
  useWalSSE((event: WalEvent) => {
    if (!runId) return;

    // Filter: only accept events belonging to THIS run.
    // The shared SSE broadcasts all events — ignore unrelated runs.
    if (event.payload) {
      try {
        const p = JSON.parse(event.payload);
        if (p.run_id != null && String(p.run_id) !== runId) return;
      } catch { /* non-JSON payload — allow through */ }
    }

    setEvents((prev) => [...prev, event]);
  });

  return events;
}
