/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Shared WAL SSE singleton — one EventSource for all consumers.
 *
 * Chrome enforces a 6-connection limit per domain (HTTP/1.1).  Having 5+
 * independent EventSource connections to /api/pipeline/stream starves regular
 * API fetch calls, causing intermittent blank panels and slow terminal loads.
 *
 * This module holds a single EventSource and lets any number of React
 * components subscribe to its events.  The connection is opened on the first
 * subscriber and closed when the last one unsubscribes.
 */
import { useEffect, useRef } from 'react';
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

type Listener = (event: WalEvent) => void;

// ─── Module-level singleton ────────────────────────────────────────────────
const listeners = new Set<Listener>();
let es: EventSource | null = null;
let refCount = 0;

function connect() {
  if (es) return;
  es = new EventSource(`${BASE_URL}/api/pipeline/stream`);
  es.addEventListener('wal_event', (e: MessageEvent) => {
    try {
      const event: WalEvent = JSON.parse(e.data);
      listeners.forEach(fn => fn(event));
    } catch { /* ignore malformed events */ }
  });
  es.onerror = () => {
    // EventSource natively auto-reconnects — nothing to do.
  };
}

function disconnect() {
  if (!es) return;
  es.close();
  es = null;
}

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * Subscribe to WAL events via the shared singleton EventSource.
 *
 * @param onEvent  Callback fired for every WAL event.  The reference is
 *                 captured in a ref so callers don't need to memoize it.
 */
export function useWalSSE(onEvent: Listener) {
  const callbackRef = useRef<Listener>(onEvent);
  // Always keep the ref pointing at the latest callback without re-running the effect.
  callbackRef.current = onEvent;

  useEffect(() => {
    const handler: Listener = (event) => callbackRef.current(event);
    listeners.add(handler);
    refCount++;
    connect();

    return () => {
      listeners.delete(handler);
      refCount--;
      if (refCount === 0) {
        disconnect();
      }
    };
  }, []); // intentionally empty — only register once per component lifetime
}
