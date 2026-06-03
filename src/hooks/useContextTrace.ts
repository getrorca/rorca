/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * useContextTrace — CTM-002 frontend hook for the context-trace inspector.
 *
 * Subscribes to the shared WAL SSE stream by runId and surfaces metadata-only
 * context-trace events as they arrive. The heavy raw payload is NEVER carried on
 * the event — it is resolved lazily via `resolveRaw(rawRef)` only when the user
 * explicitly opens a detail view.
 *
 * Invariants enforced here:
 *  - De-duplication is by `rawRef` (deterministic + monotonic per run), so a
 *    duplicate SSE delivery is dropped (last-seq-wins, identical payload).
 *  - Memory is bounded: at most `maxEvents` metadata events are retained
 *    (oldest dropped first) so a long-running stream cannot grow unboundedly.
 *  - Raw resolutions are cached by rawRef so re-opening a detail view does not
 *    re-fetch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWalSSE, type WalEvent } from './useWalSSE';
import { apiFetch } from '../lib/apiFetch';

// ─── Browser-safe mirror of the backend contract (context-trace.ts) ──────────
// Kept local to avoid importing Node-only modules (fs/zlib) into the bundle.

export type ContextTracePhase = 'context' | 'skill' | 'mcp' | 'memory' | 'prompt';
export type ContextTraceStatus = 'start' | 'ok' | 'partial' | 'error';

export interface ContextTraceMetrics {
  tokens?: number;
  bytes?: number;
  fileCount?: number;
  durationMs?: number;
}

export interface ContextTraceEvent {
  traceId: string;
  runId: number;
  storyId?: string | null;
  seq: number;
  rawRef: string;
  phase: ContextTracePhase;
  status: ContextTraceStatus;
  ts: string;
  metrics?: ContextTraceMetrics;
  label?: string;
}

export interface ContextTraceRawRecord {
  rawRef: string;
  runId: number;
  seq: number;
  phase: ContextTracePhase;
  ts: string;
  payload: unknown;
}

/** WAL event type carrying a context-trace metadata event. */
export const CONTEXT_TRACE_WAL_EVENT_TYPE = 'context_trace';

/** Default cap on retained metadata events to bound memory. */
export const DEFAULT_MAX_CONTEXT_TRACE_EVENTS = 500;

interface RawState {
  loading: boolean;
  record: ContextTraceRawRecord | null;
  error: string | null;
}

export interface UseContextTraceResult {
  /** Ordered metadata events for this run (oldest → newest), de-duplicated. */
  events: ContextTraceEvent[];
  /** Lazily fetch the raw payload for a rawRef (cached). */
  resolveRaw: (rawRef: string) => Promise<ContextTraceRawRecord>;
  /** Current resolution state for a rawRef (for drawer loading/error UI). */
  getRawState: (rawRef: string) => RawState;
}

/**
 * Validate that a parsed WAL payload is a well-formed context-trace event.
 * Defensive: a malformed or partial event is dropped rather than rendered.
 */
function isContextTraceEvent(p: unknown): p is ContextTraceEvent {
  if (!p || typeof p !== 'object') return false;
  const e = p as Record<string, unknown>;
  return (
    typeof e.rawRef === 'string' &&
    typeof e.seq === 'number' &&
    typeof e.runId === 'number' &&
    typeof e.phase === 'string' &&
    typeof e.status === 'string' &&
    typeof e.ts === 'string'
  );
}

export function useContextTrace(
  runId: string | null,
  opts?: { maxEvents?: number },
): UseContextTraceResult {
  const maxEvents = opts?.maxEvents ?? DEFAULT_MAX_CONTEXT_TRACE_EVENTS;

  const [events, setEvents] = useState<ContextTraceEvent[]>([]);
  // Map rawRef → resolution state. Stored in a ref for cache lookups + a state
  // bump to trigger re-renders when a resolution starts/finishes.
  const rawCacheRef = useRef<Map<string, RawState>>(new Map());
  const [, forceRender] = useState(0);

  // Reset when the runId changes — events and raw cache are run-scoped.
  const prevRunIdRef = useRef<string | null>(runId);
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId;
    rawCacheRef.current = new Map();
    setEvents([]);
  }

  useWalSSE((event: WalEvent) => {
    if (!runId) return;
    if (event.event_type !== CONTEXT_TRACE_WAL_EVENT_TYPE) return;
    if (!event.payload) return;

    let parsed: unknown;
    try {
      parsed = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    } catch {
      return; // malformed JSON — drop
    }

    const p = parsed as Record<string, unknown>;
    // Run-scoped filter: the engine stamps snake_case run_id on the payload.
    if (p.run_id != null && String(p.run_id) !== runId) return;
    if (!isContextTraceEvent(parsed)) return;

    const trace = parsed as ContextTraceEvent;

    setEvents((prev) => {
      // De-duplicate by rawRef (monotonic + unique per run). A duplicate
      // delivery carries an identical payload, so we keep the existing one.
      if (prev.some((e) => e.rawRef === trace.rawRef)) return prev;

      const next = [...prev, trace];
      // Bound memory: drop oldest beyond the cap.
      if (next.length > maxEvents) {
        return next.slice(next.length - maxEvents);
      }
      return next;
    });
  });

  const getRawState = useCallback((rawRef: string): RawState => {
    return rawCacheRef.current.get(rawRef) ?? { loading: false, record: null, error: null };
  }, []);

  const resolveRaw = useCallback(
    async (rawRef: string): Promise<ContextTraceRawRecord> => {
      if (!runId) throw new Error('No run selected');

      const cached = rawCacheRef.current.get(rawRef);
      if (cached?.record) return cached.record;

      rawCacheRef.current.set(rawRef, { loading: true, record: null, error: null });
      forceRender((n) => n + 1);

      try {
        const record = await apiFetch<ContextTraceRawRecord>(
          `/api/pipeline/runs/${runId}/context-trace/${encodeURIComponent(rawRef)}`,
        );
        rawCacheRef.current.set(rawRef, { loading: false, record, error: null });
        forceRender((n) => n + 1);
        return record;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load raw payload';
        rawCacheRef.current.set(rawRef, { loading: false, record: null, error: message });
        forceRender((n) => n + 1);
        throw err;
      }
    },
    [runId],
  );

  // Drop stale resolutions if the cap shrinks the visible event window so the
  // raw cache cannot outlive its events indefinitely.
  useEffect(() => {
    const visible = new Set(events.map((e) => e.rawRef));
    let mutated = false;
    for (const key of rawCacheRef.current.keys()) {
      if (!visible.has(key) && events.length >= maxEvents) {
        rawCacheRef.current.delete(key);
        mutated = true;
      }
    }
    if (mutated) forceRender((n) => n + 1);
  }, [events, maxEvents]);

  return { events, resolveRaw, getRawState };
}
