import { useState, useEffect } from 'react';
import { BASE_URL } from '../lib/apiFetch';

export interface WalEvent {
  id: number;
  ts: string;
  event_type: string;
  workspace_id: string | null;
  spec_id: string | null;
  story_id: string | null;
  actor: string;
  payload: string | null;
}

export function usePipelineSSE(runId: string | null) {
  const [events, setEvents] = useState<WalEvent[]>([]);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      return;
    }

    const url = `${BASE_URL}/api/pipeline/stream?runId=${runId}`;
    const es = new EventSource(url);

    es.addEventListener('wal_event', (e) => {
      const event: WalEvent = JSON.parse(e.data);
      setEvents((prev) => [...prev, event]);
    });

    es.onerror = () => {
      // EventSource auto-reconnects; no action needed
    };

    return () => {
      es.close();
    };
  }, [runId]);

  return events;
}
