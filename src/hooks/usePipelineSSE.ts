/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useRef, useEffect } from 'react';
import { useWalSSE, type WalEvent } from './useWalSSE';
import { BASE_URL } from '../lib/apiFetch';

export type { WalEvent };

export function usePipelineSSE(runId: string | null, _workspaceId?: string | null) {
  const [events, setEvents] = useState<WalEvent[]>([]);

  // Track previous runId so we can reset the event list when it changes.
  // Using a ref comparison + state reset avoids an extra useEffect.
  const prevRunIdRef = useRef<string | null>(runId);
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId;
    // Trigger a synchronous reset before the next render.
    setEvents([]);
  }

  // Seed historical WAL events from REST endpoint when runId changes.
  // This avoids the 5-minute delay caused by /api/pipeline/stream replaying
  // thousands of old events at 50/tick from id=0 before reaching this run's events.
  useEffect(() => {
    if (!runId || runId === 'all') return;

    let cancelled = false;

    async function seedHistoricalEvents() {
      try {
        const res = await fetch(`${BASE_URL}/api/pipeline/runs/${runId}/wal-events`);
        if (!res.ok || cancelled) return;
        const data = await res.json() as { events: WalEvent[] };
        if (cancelled) return;
        if (Array.isArray(data.events) && data.events.length > 0) {
          setEvents((prev) => {
            // Merge: historical first, then any live events that arrived in the
            // meantime. Deduplicate by id (live events may already be in prev).
            const seenIds = new Set(data.events.map((e) => e.id));
            const liveOnly = prev.filter((e) => !seenIds.has(e.id));
            return [...data.events, ...liveOnly];
          });
        }
      } catch {
        // Non-fatal — live SSE will still work, just with the old delay
      }
    }

    seedHistoricalEvents();
    return () => { cancelled = true; };
  }, [runId]);

  // Register with the shared WAL SSE singleton.
  // useWalSSE keeps the callback in a ref so we don't need useCallback here.
  useWalSSE((event: WalEvent) => {
    if (!runId) return;

    // Filter: only accept events belonging to THIS run.
    // The shared SSE broadcasts all events — ignore unrelated runs.
    if (event.payload) {
      try {
        const p = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        if (p.run_id != null && String(p.run_id) !== runId) return;
      } catch { /* non-JSON payload — allow through */ }
    }

    setEvents((prev) => {
      // Deduplicate: historical seed may have already added this event
      if (prev.some((e) => e.id === event.id)) return prev;
      return [...prev, event];
    });
  });

  return events;
}
