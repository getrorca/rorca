/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * useRelevanceGraph — Lazy-loading hook for the spec-centric memory relevance
 * graph (SMG-001 backend, SMG-002 layout engine).
 *
 * The graph is NOT fetched on mount. It is fetched only when `fetch()` is
 * explicitly called (e.g. when the user opens the graph tab). Results are
 * cached per runId so re-opening the tab does not re-fetch.
 *
 * Accepts an optional `retrievalTelemetryId` to scope the graph to a specific
 * retrieval event rather than the full run.
 */

import { useCallback, useRef, useState } from 'react';
import { apiFetch } from '../lib/apiFetch';
import type { SpecRelevanceGraphResponse, GraphFetchState } from '../types/spec-relevance-graph';

export interface UseRelevanceGraphResult {
  /** Current fetch state (idle until fetch() is called). */
  state: GraphFetchState;
  /** Trigger a lazy fetch. No-op if already loaded or in-flight. */
  fetch: (opts?: { retrievalTelemetryId?: string }) => Promise<void>;
  /** Clear cached data (e.g. on runId change). */
  reset: () => void;
}

const IDLE_STATE: GraphFetchState = { status: 'empty', data: null, error: null };

export function useRelevanceGraph(runId: number | null): UseRelevanceGraphResult {
  const [state, setState] = useState<GraphFetchState>(IDLE_STATE);
  const inflightRef = useRef<Promise<void> | null>(null);
  const cachedRunIdRef = useRef<number | null>(null);
  const cachedKeyRef = useRef<string | null>(null);

  // Reset when runId changes.
  const prevRunIdRef = useRef<number | null>(runId);
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId;
    cachedRunIdRef.current = null;
    cachedKeyRef.current = null;
    inflightRef.current = null;
    setState(IDLE_STATE);
  }

  const fetch = useCallback(async (opts?: { retrievalTelemetryId?: string }) => {
    if (runId == null) return;

    const cacheKey = opts?.retrievalTelemetryId
      ? `${runId}:${opts.retrievalTelemetryId}`
      : `${runId}`;

    // Return cached if same key.
    if (cachedRunIdRef.current === runId && cachedKeyRef.current === cacheKey && state.data) {
      return;
    }

    // De-duplicate in-flight.
    if (inflightRef.current) return;

    setState({ status: 'loading', data: null, error: null });

    const params = new URLSearchParams();
    if (opts?.retrievalTelemetryId) {
      params.set('retrievalTelemetryId', opts.retrievalTelemetryId);
    }

    const qs = params.toString();
    const url = `/api/spec-relevance-graph/by-run/${runId}${qs ? `?${qs}` : ''}`;

    const promise = apiFetch<SpecRelevanceGraphResponse>(url)
      .then((data) => {
        cachedRunIdRef.current = runId;
        cachedKeyRef.current = cacheKey;
        inflightRef.current = null;

        if (!data.available) {
          setState({
            status: 'unavailable',
            data,
            error: null,
          });
        } else if (data.nodes.length === 0) {
          setState({ status: 'empty', data, error: null });
        } else {
          setState({ status: 'ready', data, error: null });
        }
      })
      .catch((err) => {
        inflightRef.current = null;
        const message = err instanceof Error ? err.message : 'Failed to load relevance graph';
        setState({ status: 'error', data: null, error: message });
      });

    inflightRef.current = promise;
    await promise;
  }, [runId, state.data]);

  const reset = useCallback(() => {
    cachedRunIdRef.current = null;
    cachedKeyRef.current = null;
    inflightRef.current = null;
    setState(IDLE_STATE);
  }, []);

  return { state, fetch, reset };
}
