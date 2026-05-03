/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, XCircle, Loader2, Share2, Database } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useWalSSE, type WalEvent } from '../../hooks/useWalSSE';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface GraphStatsResponse {
  available: boolean;
  vertexCount: number;
  edgeCount: number;
  graphName: string;
  lastPopulatedAt: string | null;
}

interface PopulateResponse {
  totalItems: number;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

/* ─── Component ───────────────────────────────────────────────────────────── */

export function KnowledgeGraphSection() {
  const { workspaceId } = useWorkspace();
  const [stats, setStats] = useState<GraphStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Population progress state
  const [populating, setPopulating] = useState(false);
  const [populateTotal, setPopulateTotal] = useState(0);
  const [populateCompleted, setPopulateCompleted] = useState(0);
  const [populateError, setPopulateError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await apiFetch<GraphStatsResponse>('/api/graph/stats');
      setStats(data);
    } catch {
      setError('Failed to load graph stats');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchStats();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [fetchStats]);

  // Subscribe to WAL events for population progress
  useWalSSE(useCallback((event: WalEvent) => {
    if (!workspaceId) return;
    if (event.workspace_id !== workspaceId) return;

    const payload = typeof event.payload === 'string'
      ? JSON.parse(event.payload)
      : event.payload;

    if (event.event_type === 'graph_populate_started') {
      setPopulating(true);
      setPopulateTotal(payload?.totalItems ?? 0);
      setPopulateCompleted(0);
      setPopulateError(null);
    } else if (event.event_type === 'graph_populate_progress') {
      setPopulateCompleted(payload?.completed ?? 0);
      setPopulateTotal(payload?.total ?? 0);
    } else if (event.event_type === 'graph_populate_finished') {
      setPopulating(false);
      setPopulateCompleted(payload?.completed ?? 0);
      if (payload?.error) {
        setPopulateError('Population encountered errors');
      }
      // Refresh stats after population completes
      fetchStats();
    }
  }, [workspaceId, fetchStats]));

  async function handlePopulate() {
    if (!workspaceId || populating) return;
    setPopulateError(null);
    setPopulateCompleted(0);

    try {
      const res = await apiFetch<PopulateResponse>('/api/graph/populate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      setPopulateTotal(res.totalItems);
      if (res.totalItems > 0) {
        setPopulating(true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to start population';
      if (msg.includes('409') || msg.includes('already in progress')) {
        setPopulateError('Population already in progress');
      } else {
        setPopulateError(msg);
      }
    }
  }

  const progressPct = populateTotal > 0
    ? Math.round((populateCompleted / populateTotal) * 100)
    : 0;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-primary">Knowledge Graph</h2>
        <p className="text-xs text-muted mt-0.5">
          Apache AGE graph database for codebase relationship tracking
        </p>
      </div>

      <div className="border border-border rounded-lg p-4 bg-bg">
        {loading && (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Loading graph stats…</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center gap-2 text-muted">
            <XCircle className="w-4 h-4 text-red-400" />
            <span className="text-xs">{error}</span>
          </div>
        )}

        {stats && !loading && !error && (
          <>
            {/* Status badge */}
            <div className="flex items-center gap-2 mb-4">
              <Share2 size={16} className="text-muted" />
              <span className="text-sm font-medium text-[var(--text)]">Status</span>
              <span className="ml-auto">
                {stats.available ? (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-400 border border-green-500/20">
                    <CheckCircle2 className="w-3 h-3" />
                    Available
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                    <XCircle className="w-3 h-3" />
                    Unavailable
                  </span>
                )}
              </span>
            </div>

            {stats.available ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="bg-surface border border-border rounded-lg p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Vertices</p>
                    <p className="text-lg font-semibold text-primary">{stats.vertexCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-surface border border-border rounded-lg p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Edges</p>
                    <p className="text-lg font-semibold text-primary">{stats.edgeCount.toLocaleString()}</p>
                  </div>
                  <div className="bg-surface border border-border rounded-lg p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Graph Name</p>
                    <p className="text-sm font-mono text-primary">{stats.graphName}</p>
                  </div>
                  <div className="bg-surface border border-border rounded-lg p-3">
                    <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Last Populated</p>
                    <p className="text-xs text-primary">{formatTimestamp(stats.lastPopulatedAt)}</p>
                  </div>
                </div>

                {/* Populate Graph button + progress */}
                <div className="mt-4">
                  {populating ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-muted">
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Populating graph…
                        </span>
                        <span>{populateCompleted} / {populateTotal} ({progressPct}%)</span>
                      </div>
                      <div className="w-full bg-surface border border-border rounded-full h-2 overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out"
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <button
                        onClick={handlePopulate}
                        disabled={!workspaceId}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Database className="w-3.5 h-3.5" />
                        Populate Graph
                      </button>
                      {populateError && (
                        <span className="text-xs text-red-400">{populateError}</span>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="bg-surface border border-border rounded-lg p-4 text-center">
                <p className="text-sm text-muted">
                  Knowledge graph not available — install Apache AGE extension
                </p>
                <p className="text-xs text-muted/60 mt-1">
                  Use self-hosted PostgreSQL with AGE for full graph support.
                  The graph layer is optional — core functionality works without it.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default KnowledgeGraphSection;
