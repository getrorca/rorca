/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, XCircle, Loader2, Share2, Database, ListOrdered, RefreshCw, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../lib/apiFetch';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useWalSSE, type WalEvent } from '../../hooks/useWalSSE';
import type { DatabaseCapability } from '../../contexts/CapabilitiesContext';

/* ─── Types ───────────────────────────────────────────────────────────────── */

interface WorkspaceStatusResponse {
  workspaceId: string;
  databaseCapability: DatabaseCapability;
  graph: {
    available: boolean;
    graphMode: DatabaseCapability['graphMode'];
    vertexCount: number;
    edgeCount: number;
    graphName: string;
    lastPopulatedAt: string | null;
    warnings: string[];
  };
}

interface PopulateResponse {
  totalItems: number;
}

interface ScoreBreakdown {
  total: number;
  semantic: number;
  structural: number;
  graph: number;
  provenance: number;
  recency: number;
  pinned: number;
  skills: number;
  historical: number;
  diversityPenalty: number;
  echoChamberPenalty: number;
  repetitionPenalty: number;
  duplicationPenalty: number;
}

interface OntologyExplainabilityItem {
  tone: 'active' | 'suppressed' | 'conflict';
  label: string;
  relationType: 'SUPERSEDES' | 'CONFLICTS_WITH';
  relationKey: string;
  otherMemoryId: string;
  otherCanonicalKey: string;
  counterpartRetrieved: boolean;
}

interface CandidateExplainability {
  scoringVersion: string;
  retrievalMode: string;
  scoreBreakdown: ScoreBreakdown;
  provenanceEdges: string[];
  provenanceEdgeOverflow: number;
  provenanceConfidence: string | null;
  provenanceSourceType: string | null;
  provenanceSource: string | null;
  graphSignalCount: number;
  rankReasons: string[];
  rankReasonOverflow: number;
  ontologyExplainability: {
    status: 'available' | 'partial' | 'unavailable';
    message: string;
    explanations: OntologyExplainabilityItem[];
    totalExplanationCount: number;
    hiddenExplanationCount: number;
  };
}

interface RetrievalDebugCandidate {
  key: string;
  finalScore: number;
  decision?: 'keep' | 'drop' | 'needs-more' | 'conflict';
  supersededBy?: string;
  conflictsWith?: string[];
  explainability?: CandidateExplainability;
}

interface RetrievalDebugEvent {
  id: string;
  queryPreview: string;
  scoringVersion: string | null;
  retrievalMode: string | null;
  candidates: RetrievalDebugCandidate[];
}

interface RetrievalDebugResponse {
  events: RetrievalDebugEvent[];
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function formatScore(score: number): string {
  return score >= 0 ? `+${score.toFixed(3)}` : score.toFixed(3);
}

function decisionBadgeClass(decision?: RetrievalDebugCandidate['decision']): string {
  if (decision === 'drop') return 'border-amber-500/20 bg-amber-500/10 text-amber-400';
  if (decision === 'conflict') return 'border-red-500/20 bg-red-500/10 text-red-300';
  if (decision === 'needs-more') return 'border-blue-500/20 bg-blue-500/10 text-blue-300';
  return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400';
}

function graphModeBadgeClass(graphMode: DatabaseCapability['graphMode']): string {
  if (graphMode === 'full') return 'bg-green-500/10 text-green-400 border border-green-500/20';
  if (graphMode === 'lite') return 'bg-amber-500/10 text-amber-400 border border-amber-500/20';
  return 'bg-red-500/10 text-red-400 border border-red-500/20';
}

function graphModeLabel(graphMode: DatabaseCapability['graphMode']): string {
  if (graphMode === 'full') return 'Available';
  if (graphMode === 'lite') return 'Lite';
  return 'Disabled';
}

function graphModeDescription(status: WorkspaceStatusResponse | null): string {
  const graphMode = status?.databaseCapability.graphMode ?? 'disabled';
  if (graphMode === 'full') return 'Apache AGE graph database for codebase relationship tracking';
  if (graphMode === 'lite') return 'Semantic-only graph surfaces are active until Apache AGE is enabled for the current database mode';
  return 'Graph features are disabled until the active database is reachable again';
}

/* ─── Component ───────────────────────────────────────────────────────────── */

export function KnowledgeGraphSection() {
  const { workspaceId } = useWorkspace();
  const [status, setStatus] = useState<WorkspaceStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Population progress state
  const [populating, setPopulating] = useState(false);
  const [populateTotal, setPopulateTotal] = useState(0);
  const [populateCompleted, setPopulateCompleted] = useState(0);
  const [populateError, setPopulateError] = useState<string | null>(null);

  const [debugEvent, setDebugEvent] = useState<RetrievalDebugEvent | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [debugError, setDebugError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setLoading(false);
      return;
    }

    try {
      const data = await apiFetch<WorkspaceStatusResponse>(`/api/workspaces/${workspaceId}/status`);
      setStatus(data);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load graph status');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchStatus();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [fetchStatus]);

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
      void fetchStatus();
    }
  }, [workspaceId, fetchStatus]));

  const loadRankingDebug = useCallback(async () => {
    if (!workspaceId) return;
    setDebugLoading(true);
    setDebugError(null);
    try {
      const data = await apiFetch<RetrievalDebugResponse>(`/api/graph/retrieval-telemetry?workspaceId=${encodeURIComponent(workspaceId)}&limit=1`);
      setDebugEvent(data.events[0] ?? null);
    } catch (err: unknown) {
      setDebugError(err instanceof Error ? err.message : 'Failed to load ranking debug');
      setDebugEvent(null);
    } finally {
      setDebugLoading(false);
    }
  }, [workspaceId]);

  async function handlePopulate() {
    if (!workspaceId || populating || status?.databaseCapability.graphMode !== 'full') return;
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

  useEffect(() => {
    setDebugEvent(null);
    setDebugError(null);
  }, [workspaceId]);

  const progressPct = populateTotal > 0
    ? Math.round((populateCompleted / populateTotal) * 100)
    : 0;

  const graphMode = status?.databaseCapability.graphMode ?? 'disabled';
  const graphWarnings = status?.databaseCapability.warnings ?? [];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-primary">Knowledge Graph</h2>
        <p className="text-xs text-muted mt-0.5">
          {graphModeDescription(status)}
        </p>
      </div>

      <div className="border border-border rounded-lg p-4 bg-bg">
        {loading && (
          <div className="flex items-center gap-2 text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Loading graph status…</span>
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center gap-2 text-muted">
            <XCircle className="w-4 h-4 text-red-400" />
            <span className="text-xs">{error}</span>
          </div>
        )}

        {status && !loading && !error && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <Share2 size={16} className="text-muted" />
              <span className="text-sm font-medium text-[var(--text)]">Status</span>
              <span className="ml-auto inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium">
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${graphModeBadgeClass(graphMode)}`}>
                  {graphMode === 'full' ? <CheckCircle2 className="w-3 h-3" /> : graphMode === 'lite' ? <AlertTriangle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                  {graphModeLabel(graphMode)}
                </span>
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-surface border border-border rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Vertices</p>
                <p className="text-lg font-semibold text-primary">{status.graph.vertexCount.toLocaleString()}</p>
              </div>
              <div className="bg-surface border border-border rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Edges</p>
                <p className="text-lg font-semibold text-primary">{status.graph.edgeCount.toLocaleString()}</p>
              </div>
              <div className="bg-surface border border-border rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Graph Name</p>
                <p className="text-sm font-mono text-primary">{status.graph.graphName}</p>
              </div>
              <div className="bg-surface border border-border rounded-lg p-3">
                <p className="text-[10px] uppercase tracking-wide text-muted mb-1">Last Populated</p>
                <p className="text-xs text-primary">{formatTimestamp(status.graph.lastPopulatedAt)}</p>
              </div>
            </div>

            <div className="mt-3 rounded-lg border border-border bg-surface p-3 text-xs text-muted space-y-1">
              <p>
                Mode: <span className="font-medium text-primary">{status.databaseCapability.dbMode}</span>
                {' · '}
                Provider: <span className="font-medium text-primary">{status.databaseCapability.provider}</span>
              </p>
              <p>
                Connection: <span className="font-mono text-primary">{status.databaseCapability.connection.url ?? 'unavailable'}</span>
              </p>
              <p>
                Extensions: AGE <span className="font-medium text-primary">{status.databaseCapability.extensions.age ? 'on' : 'off'}</span>
                {' · '}
                pgvector <span className="font-medium text-primary">{status.databaseCapability.extensions.vector ? 'on' : 'off'}</span>
              </p>
            </div>

            {graphWarnings.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
                <ul className="space-y-1">
                  {graphWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-4 space-y-4">
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
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handlePopulate}
                    disabled={!workspaceId || graphMode !== 'full'}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Database className="w-3.5 h-3.5" />
                    Populate Graph
                  </button>
                  {graphMode !== 'full' && (
                    <span className="text-xs text-muted">
                      Graph population requires full AGE support.
                    </span>
                  )}
                  {populateError && (
                    <span className="text-xs text-red-400">{populateError}</span>
                  )}
                </div>
              )}

              <div className="border-t border-border pt-4 space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-[var(--text)]">Ranking debug</p>
                    <p className="text-xs text-muted">Inspect why the latest ranked graph candidates won for this workspace.</p>
                  </div>
                  <button
                    onClick={loadRankingDebug}
                    disabled={!workspaceId || debugLoading}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-surface text-primary border border-border hover:bg-bg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {debugLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Load Debug
                  </button>
                </div>

                {debugError && (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-300">
                    {debugError}
                  </div>
                )}

                {!debugLoading && !debugError && !debugEvent && (
                  <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted">
                    No debug data loaded yet.
                  </div>
                )}

                {debugEvent && (
                  <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-[var(--text)]">
                        <ListOrdered className="w-4 h-4 text-muted" />
                        Latest retrieval event
                      </div>
                      <p className="text-xs text-muted">{debugEvent.queryPreview || 'No query preview available.'}</p>
                      <div className="flex flex-wrap gap-2 text-[11px] text-muted">
                        <span className="rounded-full border border-border px-2 py-0.5">mode: {debugEvent.retrievalMode ?? 'unknown'}</span>
                        <span className="rounded-full border border-border px-2 py-0.5">scoring: {debugEvent.scoringVersion ?? 'unknown'}</span>
                      </div>
                    </div>

                    {debugEvent.candidates.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-muted">
                        No ranked candidates were captured for this event.
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {debugEvent.candidates.slice(0, 3).map((candidate) => (
                          <div key={candidate.key} className="rounded-lg border border-border bg-bg p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-xs font-mono text-primary break-all">{candidate.key}</p>
                              <div className="flex flex-wrap items-center gap-2">
                                {candidate.decision && (
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${decisionBadgeClass(candidate.decision)}`}>
                                    {candidate.decision}
                                  </span>
                                )}
                                <span className="text-xs font-medium text-[var(--text)]">score {candidate.finalScore.toFixed(3)}</span>
                              </div>
                            </div>

                            {!candidate.explainability ? (
                              <p className="mt-2 text-xs text-muted">No debug data for this candidate.</p>
                            ) : (
                              <div className="mt-3 space-y-3">
                                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                                  {Object.entries(candidate.explainability.scoreBreakdown).map(([label, value]) => (
                                    <div key={label} className="rounded-md border border-border bg-surface px-2 py-1.5">
                                      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
                                      <p className="font-mono text-primary">{formatScore(value)}</p>
                                    </div>
                                  ))}
                                </div>
                                <div className="space-y-2 text-xs text-muted">
                                  <p>
                                    Edges: {candidate.explainability.provenanceEdges.length > 0 ? candidate.explainability.provenanceEdges.join(', ') : 'No graph edges recorded'}
                                    {candidate.explainability.provenanceEdgeOverflow > 0 ? ` (+${candidate.explainability.provenanceEdgeOverflow} more)` : ''}
                                  </p>
                                  <p>Provenance: {candidate.explainability.provenanceSourceType ?? 'unknown'} / {candidate.explainability.provenanceConfidence ?? 'unknown'}</p>
                                  {candidate.explainability.rankReasons.length > 0 && (
                                    <p>
                                      Why it ranked: {candidate.explainability.rankReasons.join(' • ')}
                                      {candidate.explainability.rankReasonOverflow > 0 ? ` • +${candidate.explainability.rankReasonOverflow} more` : ''}
                                    </p>
                                  )}
                                </div>

                                <div className="space-y-2 rounded-md border border-border bg-surface px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Ontology</span>
                                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${candidate.explainability.ontologyExplainability.status === 'available' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : candidate.explainability.ontologyExplainability.status === 'partial' ? 'border-amber-500/20 bg-amber-500/10 text-amber-400' : 'border-border bg-bg text-muted'}`}>
                                      {candidate.explainability.ontologyExplainability.status}
                                    </span>
                                  </div>
                                  <p className="text-xs text-muted">{candidate.explainability.ontologyExplainability.message}</p>
                                  {candidate.explainability.ontologyExplainability.explanations.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                      {candidate.explainability.ontologyExplainability.explanations.map((explanation) => (
                                        <span
                                          key={explanation.relationKey}
                                          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${explanation.tone === 'active' ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-400' : explanation.tone === 'suppressed' ? 'border-amber-500/20 bg-amber-500/10 text-amber-400' : 'border-red-500/20 bg-red-500/10 text-red-300'}`}
                                        >
                                          {explanation.label}
                                        </span>
                                      ))}
                                      {candidate.explainability.ontologyExplainability.hiddenExplanationCount > 0 && (
                                        <span className="rounded-full bg-bg px-2 py-0.5 text-[10px] text-muted">
                                          +{candidate.explainability.ontologyExplainability.hiddenExplanationCount} more
                                        </span>
                                      )}
                                    </div>
                                  ) : null}
                                  {candidate.supersededBy && (
                                    <p className="text-xs text-amber-300">Suppressed by {candidate.supersededBy}</p>
                                  )}
                                  {(candidate.conflictsWith?.length ?? 0) > 0 && (
                                    <p className="text-xs text-red-300">Conflicts with {candidate.conflictsWith?.slice(0, 2).join(', ')}{(candidate.conflictsWith?.length ?? 0) > 2 ? ` +${(candidate.conflictsWith?.length ?? 0) - 2} more` : ''}</p>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export default KnowledgeGraphSection;
