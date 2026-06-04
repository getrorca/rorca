/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * useSpecRelevanceGraph — Fetches the spec-centric relevance graph from the
 * backend and derives loading/error/ready state.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../lib/apiFetch';
import type {
  SpecRelevanceGraphResponse,
  GraphFetchState,
} from '../types/spec-relevance-graph';
import { deriveGraphState } from '../lib/relevance-visual';

export interface UseSpecRelevanceGraphOptions {
  workspaceId: string | null;
  specSlug?: string;
  runId?: number;
  maxFiles?: number;
  maxMemories?: number;
  maxEdges?: number;
}

export function useSpecRelevanceGraph(
  opts: UseSpecRelevanceGraphOptions,
): GraphFetchState & { refetch: () => void } {
  const { workspaceId, specSlug, runId, maxFiles, maxMemories, maxEdges } = opts;

  const [data, setData] = useState<SpecRelevanceGraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchGraph = useCallback(async () => {
    if (!workspaceId || (!specSlug && !runId)) return;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({ workspaceId });
      if (specSlug) params.set('specSlug', specSlug);
      if (runId != null) params.set('runId', String(runId));
      if (maxFiles != null) params.set('maxFiles', String(maxFiles));
      if (maxMemories != null) params.set('maxMemories', String(maxMemories));
      if (maxEdges != null) params.set('maxEdges', String(maxEdges));

      const response = await apiFetch<SpecRelevanceGraphResponse>(
        `/api/spec-relevance-graph?${params.toString()}`,
      );
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load relevance graph');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, specSlug, runId, maxFiles, maxMemories, maxEdges]);

  useEffect(() => {
    fetchGraph();
  }, [fetchGraph]);

  const status = deriveGraphState(data, loading, error);

  return { status, data, error, refetch: fetchGraph };
}
