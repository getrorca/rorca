/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextInspector — CTM-003 surface that consumes the CTM-002 context-trace
 * metadata stream and lazy rawRef fetch route.
 *
 * Responsibilities (and the invariants they protect):
 *  - Render a summary header + retrieval funnel purely from the metadata
 *    contract (phase / status / metrics / label). The heavy raw payload is
 *    never read here — only the lightweight metadata events.
 *  - Order events deterministically by `seq` (then `rawRef`) so live deliveries
 *    cannot reorder or flicker the list. De-duplication is already handled by
 *    `useContextTrace` (by rawRef); this is the ordering half of that guarantee.
 *  - Open the raw payload only when the user explicitly opens a detail view,
 *    delegating loading / error / truncation handling to ContextTraceRawDrawer.
 *  - Distinguish loading, empty, partial (some error/partial phases), and
 *    completed states WITHOUT ever asserting a run "passed" — this surface
 *    reflects context-assembly health, not the run's story result.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, AlertTriangle, CheckCircle2, Loader2, ChevronRight, FileText, Search, Network, GitBranch, Target } from 'lucide-react';
import {
  useContextTrace,
  type ContextTraceEvent,
  type ContextTracePhase,
  type ContextTraceStatus,
  type RetrievalTelemetryDetail,
  type RetrievalCandidateDetail,
  type RetrievalTelemetryState,
  type RetrievalContextReceipt,
} from '../hooks/useContextTrace';
import { useRelevanceGraph } from '../hooks/useRelevanceGraph';
import type { PositionedNode, SpecRelevanceGraphResponse, RelevanceEdge, RelevanceScoreBreakdown } from '../types/spec-relevance-graph';
import ContextTraceRawDrawer from './ContextTraceRawDrawer';
import RelevanceGraphView from './RelevanceGraphView';
import SlideOver from './SlideOver';

interface ContextInspectorProps {
  /** Numeric run id. Stringified internally for the run-scoped SSE filter. */
  runId: number;
  /**
   * When false, the inspector renders an "in progress" affordance rather than a
   * "no context yet" empty state, so an early-stage run isn't mislabeled as
   * having produced no context. Defaults to true (run is settled).
   */
  runSettled?: boolean;
}

// ─── Phase presentation ──────────────────────────────────────────────────────

const PHASE_LABELS: Record<ContextTracePhase, string> = {
  context: 'Spec / CAG / Files',
  skill: 'Skills',
  mcp: 'MCP',
  memory: 'RAG / Memory',
  graph: 'Knowledge Graph',
  prompt: 'Prompt Assembly',
};

/** Funnel display order — retrieval flows from raw context → assembled prompt. */
const FUNNEL_ORDER: ContextTracePhase[] = ['context', 'memory', 'graph', 'skill', 'mcp', 'prompt'];

function statusColor(status: ContextTraceStatus): string {
  switch (status) {
    case 'ok':
      return 'text-emerald-500';
    case 'partial':
      return 'text-amber-500';
    case 'error':
      return 'text-rose-400';
    default:
      return 'text-muted';
  }
}

function statusDot(status: ContextTraceStatus): string {
  switch (status) {
    case 'ok':
      return 'bg-emerald-500';
    case 'partial':
      return 'bg-amber-500';
    case 'error':
      return 'bg-rose-400';
    default:
      return 'bg-gray-500';
  }
}

function formatDuration(ms: number | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Derived funnel model (metadata-only) ────────────────────────────────────

interface FunnelRow {
  phase: ContextTracePhase;
  /** Total trace events emitted for this phase (candidate deliveries). */
  candidates: number;
  /** Events that resolved ok/partial (kept into the assembled context). */
  kept: number;
  /** Events that errored (dropped from the assembled context). */
  dropped: number;
  /** Summed kept file/selection count from metrics.fileCount, when present. */
  fileCount: number | null;
  /** Summed inline token estimate from metrics.tokens, when present. */
  tokens: number | null;
  /** Summed byte size from metrics.bytes, when present. */
  bytes: number | null;
  /** Max observed latency (metrics.durationMs) across this phase. */
  durationMs: number | null;
}

function buildFunnel(events: ContextTraceEvent[]): FunnelRow[] {
  const byPhase = new Map<ContextTracePhase, FunnelRow>();

  for (const e of events) {
    let row = byPhase.get(e.phase);
    if (!row) {
      row = {
        phase: e.phase,
        candidates: 0,
        kept: 0,
        dropped: 0,
        fileCount: null,
        tokens: null,
        bytes: null,
        durationMs: null,
      };
      byPhase.set(e.phase, row);
    }

    row.candidates += 1;
    if (e.status === 'error') row.dropped += 1;
    else row.kept += 1;

    const m = e.metrics;
    if (m) {
      if (typeof m.fileCount === 'number') row.fileCount = (row.fileCount ?? 0) + m.fileCount;
      if (typeof m.tokens === 'number') row.tokens = (row.tokens ?? 0) + m.tokens;
      if (typeof m.bytes === 'number') row.bytes = (row.bytes ?? 0) + m.bytes;
      if (typeof m.durationMs === 'number') {
        row.durationMs = row.durationMs == null ? m.durationMs : Math.max(row.durationMs, m.durationMs);
      }
    }
  }

  return FUNNEL_ORDER.filter((p) => byPhase.has(p)).map((p) => byPhase.get(p)!);
}

// ─── Component ───────────────────────────────────────────────────────────────

type InspectorView = 'list' | 'graph';

export default function ContextInspector({ runId, runSettled = true }: ContextInspectorProps) {
  const { events, resolveRaw, getRawState, resolveRetrievalTelemetry, getRetrievalTelemetryState } = useContextTrace(String(runId));
  const graph = useRelevanceGraph(runId);
  const [activeView, setActiveView] = useState<InspectorView>('list');
  const graphFetchedRef = useRef(false);

  // Lazy-load graph data only when graph view is opened.
  useEffect(() => {
    if (activeView === 'graph' && !graphFetchedRef.current) {
      graphFetchedRef.current = true;
      graph.fetch();
    }
  }, [activeView, graph]);

  // Reset graph fetch flag when runId changes.
  const prevGraphRunRef = useRef(runId);
  if (prevGraphRunRef.current !== runId) {
    prevGraphRunRef.current = runId;
    graphFetchedRef.current = false;
  }

  const [activeGraphNode, setActiveGraphNode] = useState<PositionedNode | null>(null);

  // Graph node click → open an insight drawer that explains the node in place.
  const handleGraphNodeClick = useCallback((node: PositionedNode) => {
    setActiveGraphNode(node);
  }, []);

  // Stable ordering by seq (then rawRef as a tiebreaker). De-dup already done in
  // the hook by rawRef, so this guarantees no reorder/flicker on live delivery.
  const ordered = useMemo(() => {
    return [...events].sort((a, b) => {
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.rawRef.localeCompare(b.rawRef);
    });
  }, [events]);

  const funnel = useMemo(() => buildFunnel(ordered), [ordered]);

  const summary = useMemo(() => {
    let candidates = 0;
    let kept = 0;
    let dropped = 0;
    let tokens = 0;
    let hasTokens = false;
    let maxDurationMs: number | null = null;
    let promptTokens: number | null = null;

    for (const e of ordered) {
      candidates += 1;
      if (e.status === 'error') dropped += 1;
      else kept += 1;

      const m = e.metrics;
      if (m?.tokens != null) {
        tokens += m.tokens;
        hasTokens = true;
      }
      if (m?.durationMs != null) {
        maxDurationMs = maxDurationMs == null ? m.durationMs : Math.max(maxDurationMs, m.durationMs);
      }
      // Prompt-token metric: prefer the prompt phase's token/byte signal.
      if (e.phase === 'prompt' && m) {
        if (m.tokens != null) promptTokens = m.tokens;
      }
    }

    return {
      candidates,
      kept,
      dropped,
      tokens: hasTokens ? tokens : null,
      maxDurationMs,
      promptTokens,
    };
  }, [ordered]);

  // The detail view selection. Opening sets the active event; the drawer fetches
  // the raw payload lazily (see ContextTraceRawDrawer).
  const [activeRawRef, setActiveRawRef] = useState<string | null>(null);
  const activeEvent = useMemo(
    () => (activeRawRef ? ordered.find((e) => e.rawRef === activeRawRef) ?? null : null),
    [activeRawRef, ordered],
  );
  const activeRawState = activeRawRef ? getRawState(activeRawRef) : { loading: false, record: null, error: null };

  // Retrieval telemetry detail drawer state.
  const [activeRetrievalId, setActiveRetrievalId] = useState<string | null>(null);
  const activeRetrievalEvent = useMemo(
    () => (activeRetrievalId ? ordered.find((e) => e.retrievalTelemetryId === activeRetrievalId) ?? null : null),
    [activeRetrievalId, ordered],
  );
  const activeRetrievalState: RetrievalTelemetryState = activeRetrievalId
    ? getRetrievalTelemetryState(activeRetrievalId)
    : { loading: false, detail: null, error: null };

  const activeGraphTelemetryId = useMemo(
    () => (activeGraphNode ? findTelemetryIdForGraphNode(activeGraphNode, ordered, graph.state.data) : null),
    [activeGraphNode, ordered, graph.state.data],
  );
  const activeGraphTelemetryState: RetrievalTelemetryState = activeGraphTelemetryId
    ? getRetrievalTelemetryState(activeGraphTelemetryId)
    : { loading: false, detail: null, error: null };

  useEffect(() => {
    if (!activeGraphTelemetryId) return;
    resolveRetrievalTelemetry(activeGraphTelemetryId).catch(() => {});
  }, [activeGraphTelemetryId, resolveRetrievalTelemetry]);

  const hasErrors = summary.dropped > 0;

  // ─── Empty / pending state ────────────────────────────────────────────────
  if (ordered.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted px-6 text-center" data-testid="context-inspector-empty">
        <Layers size={32} className="opacity-30" />
        {runSettled ? (
          <>
            <span className="text-sm font-medium">No context traces for this run</span>
            <span className="text-xs opacity-70 max-w-sm">
              This view only shows low-level context-trace artifacts. This run still may
              have context files, skills, retrieval telemetry, and token usage recorded in
              the Stories and Skills tabs; it just did not emit the newer trace artifact.
            </span>
          </>
        ) : (
          <>
            <Loader2 size={14} className="animate-spin" />
            <span className="text-sm font-medium">Waiting for context traces…</span>
            <span className="text-xs opacity-70 max-w-sm">
              Context-assembly traces appear here as the run injects retrieval, skill,
              and prompt context for each story.
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="context-inspector">
      {/* ─── Summary header ───────────────────────────────────────────────── */}
      <div className="shrink-0 px-4 py-3 border-b border-border bg-panel">
        <div className="flex items-center gap-2 mb-2">
          <Layers size={14} className="text-accent" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted">
            Context Inspector
          </span>
          {/* Health pill — reflects context-assembly status, NOT run pass/fail. */}
          {hasErrors ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-500/10 text-amber-500" data-testid="inspector-health-partial">
              <AlertTriangle size={10} />
              {summary.dropped} dropped
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold rounded bg-emerald-500/10 text-emerald-500" data-testid="inspector-health-ok">
              <CheckCircle2 size={10} />
              All kept
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
          <SummaryStat label="Candidates" value={summary.candidates.toLocaleString()} />
          <SummaryStat label="Kept" value={summary.kept.toLocaleString()} valueClass="text-emerald-500" />
          <SummaryStat
            label="Dropped"
            value={summary.dropped.toLocaleString()}
            valueClass={summary.dropped > 0 ? 'text-rose-400' : undefined}
          />
          {summary.maxDurationMs != null && (
            <SummaryStat label="Latency" value={formatDuration(summary.maxDurationMs) ?? '—'} />
          )}
          {summary.promptTokens != null && (
            <SummaryStat label="Prompt tokens" value={summary.promptTokens.toLocaleString()} />
          )}
          {summary.promptTokens == null && summary.tokens != null && (
            <SummaryStat label="Tokens" value={summary.tokens.toLocaleString()} />
          )}
        </div>
      </div>

      {/* ─── View toggle (List / Graph) ───────────────────────────────────── */}
      <div className="shrink-0 flex items-center gap-1 px-4 py-1.5 border-b border-border bg-panel/50" data-testid="inspector-view-toggle">
        <button
          type="button"
          onClick={() => setActiveView('list')}
          className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${activeView === 'list' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-muted hover:text-[var(--text)]'}`}
          data-testid="inspector-view-list"
        >
          <Layers size={11} className="inline -mt-0.5 mr-1" />
          List
        </button>
        <button
          type="button"
          onClick={() => setActiveView('graph')}
          className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${activeView === 'graph' ? 'bg-[var(--accent)]/10 text-[var(--accent)]' : 'text-muted hover:text-[var(--text)]'}`}
          data-testid="inspector-view-graph"
        >
          <Network size={11} className="inline -mt-0.5 mr-1" />
          Graph
        </button>
      </div>

      {activeView === 'list' ? (
        <>
          {/* ─── Retrieval funnel ─────────────────────────────────────────────── */}
          <div className="shrink-0 px-4 py-3 border-b border-border" data-testid="inspector-funnel">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
              Retrieval funnel
            </p>
            <div className="flex flex-col gap-1.5">
              {funnel.map((row) => (
                <div key={row.phase} className="flex items-center gap-3 text-xs" data-testid={`funnel-row-${row.phase}`}>
                  <span className="w-32 shrink-0 text-muted truncate">{PHASE_LABELS[row.phase]}</span>
                  <span className="font-mono text-[var(--text)]">
                    <span className="text-emerald-500">{row.kept}</span>
                    <span className="text-muted"> / {row.candidates}</span>
                    {row.dropped > 0 && (
                      <span className="text-rose-400" title={`${row.dropped} dropped (errored)`}>
                        {' '}· {row.dropped} dropped
                      </span>
                    )}
                  </span>
                  <span className="ml-auto flex items-center gap-3 text-[11px] text-muted">
                    {row.fileCount != null && <span>{row.fileCount} files</span>}
                    {row.tokens != null && <span>{row.tokens.toLocaleString()} tok</span>}
                    {formatDuration(row.durationMs ?? undefined) && (
                      <span>{formatDuration(row.durationMs ?? undefined)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ─── Event list (open → lazy raw fetch) ───────────────────────────── */}
          <div className="flex-1 overflow-y-auto" data-testid="inspector-events">
            {ordered.map((e) => {
              const raw = getRawState(e.rawRef);
              const displayRef = e.synthetic && e.rawRef.startsWith('synthetic:') ? `synthetic:${e.seq}` : e.rawRef;
              // Rows with retrievalTelemetryId are clickable even when synthetic.
              const hasRetrieval = !!e.retrievalTelemetryId;
              const hasMetadataFallback = e.synthetic && ((e.details?.length ?? 0) > 0 || !!e.metrics);
              const isClickable = hasRetrieval || hasMetadataFallback || !e.synthetic;
              return (
                <button
                  key={e.rawRef}
                  type="button"
                  onClick={() => {
                    if (hasRetrieval) {
                      setActiveRetrievalId(e.retrievalTelemetryId!);
                      resolveRetrievalTelemetry(e.retrievalTelemetryId!).catch(() => {});
                    } else if (hasMetadataFallback || !e.synthetic) {
                      setActiveRawRef(e.rawRef);
                    }
                  }}
                  className={`w-full grid grid-cols-[auto_7.5rem_8.5rem_minmax(0,1fr)_4.5rem_4rem_7rem_auto] items-center gap-3 px-4 py-2 text-left border-b border-border/50 transition-colors ${isClickable ? 'hover:bg-panel/50 cursor-pointer' : 'cursor-default'}`}
                  data-testid={`inspector-event-${e.rawRef}`}
                >
                  <span className={`w-2 h-2 rounded-full ${statusDot(e.status)}`} />
                  <span className="font-mono text-[10px] text-muted truncate" title={e.rawRef}>{displayRef}</span>
                  <span className="text-[11px] text-muted truncate">{PHASE_LABELS[e.phase]}</span>
                  <span className="min-w-0 text-xs text-[var(--text)] leading-4">
                    <span className="block truncate">{e.label ?? e.phase}</span>
                    {e.synthetic && e.details && e.details.length > 0 && (
                      <span className="block mt-0.5 text-[10px] text-muted truncate" title={e.details.join(' · ')}>{e.details.join(' · ')}</span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-muted truncate">{e.storyId ?? ''}</span>
                  <span className={`text-[11px] truncate ${statusColor(e.status)}`}>{e.status}</span>
                  {hasRetrieval ? (
                    <span className="inline-flex items-center gap-1 text-[10px] text-[var(--accent)] truncate">
                      <Search size={10} />
                      {e.synthetic ? 'reconstructed' : 'relevance'}
                    </span>
                  ) : e.synthetic ? (
                    <span className="text-[10px] text-muted/70 truncate">metadata</span>
                  ) : raw.loading ? (
                    <Loader2 size={12} className="text-muted animate-spin" />
                  ) : (
                    <FileText size={12} className="text-muted/60" />
                  )}
                  {isClickable ? (
                    <ChevronRight size={12} className="text-muted/60" />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        /* ─── Graph view (lazy-loaded) ──────────────────────────────────────── */
        <RelevanceGraphView
          state={graph.state}
          selectedNodeId={activeGraphNode?.id ?? null}
          onNodeClick={handleGraphNodeClick}
        />
      )}

      {/* ─── Lazy raw payload drawer ──────────────────────────────────────── */}
      <ContextTraceRawDrawer
        isOpen={activeRawRef != null}
        onClose={() => setActiveRawRef(null)}
        event={activeEvent}
        loading={activeRawState.loading}
        error={activeRawState.error}
        record={activeRawState.record}
        onResolve={(rawRef) => {
          // Resolution errors are surfaced via getRawState; swallow the rejection
          // here so an unhandled promise rejection can't escape the inspector.
          resolveRaw(rawRef).catch(() => { /* state already records the error */ });
        }}
      />

      {/* ─── Retrieval telemetry detail drawer ────────────────────────────── */}
      <RetrievalDetailDrawer
        isOpen={activeRetrievalId != null}
        onClose={() => setActiveRetrievalId(null)}
        event={activeRetrievalEvent}
        state={activeRetrievalState}
      />

      {/* ─── Graph node insight drawer ──────────────────────────────────── */}
      <GraphNodeInsightDrawer
        isOpen={activeGraphNode != null}
        onClose={() => setActiveGraphNode(null)}
        node={activeGraphNode}
        graphData={graph.state.data}
        telemetryId={activeGraphTelemetryId}
        telemetryState={activeGraphTelemetryState}
        onOpenRetrieval={(telemetryId) => {
          setActiveGraphNode(null);
          setActiveRetrievalId(telemetryId);
          resolveRetrievalTelemetry(telemetryId).catch(() => {});
        }}
      />
    </div>
  );
}

function SummaryStat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-muted">{label}</span>
      <span className={`font-mono font-semibold ${valueClass ?? 'text-[var(--text)]'}`}>{value}</span>
    </span>
  );
}

// ─── Retrieval detail drawer ─────────────────────────────────────────────────

interface RetrievalDetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  event: ContextTraceEvent | null;
  state: RetrievalTelemetryState;
}

function RetrievalDetailDrawer({ isOpen, onClose, event, state }: RetrievalDetailDrawerProps) {
  const title = event
    ? `Retrieval · ${event.label ?? event.rawRef}`
    : 'Retrieval detail';

  return (
    <SlideOver isOpen={isOpen} onClose={onClose} title={title}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4" data-testid="retrieval-detail-drawer">
        {state.loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted" data-testid="retrieval-detail-loading">
            <Loader2 size={14} className="animate-spin" />
            Loading retrieval details…
          </div>
        )}

        {state.error && !state.loading && (
          <div className="flex items-start gap-2 p-3 rounded bg-rose-500/5 border border-rose-500/20 text-sm text-rose-400" data-testid="retrieval-detail-error">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Could not load retrieval details</p>
              <p className="text-[12px] text-rose-400/80 mt-0.5">{state.error}</p>
            </div>
          </div>
        )}

        {state.detail && !state.loading && !state.error && (
          <RetrievalDetailContent detail={state.detail} />
        )}

        {!state.detail && !state.loading && !state.error && (
          <p className="text-sm text-muted py-10 text-center">No retrieval detail available.</p>
        )}
      </div>
    </SlideOver>
  );
}

function RetrievalDetailContent({ detail }: { detail: RetrievalTelemetryDetail }) {
  const usedCandidates = detail.selectedCandidates.filter((candidate) => candidate.enteredPrompt !== false);
  const keptOutsidePrompt = detail.selectedCandidates.filter((candidate) => candidate.enteredPrompt === false);
  const droppedSummary = summarizeDroppedCandidates(detail.droppedCandidates);

  return (
    <div className="space-y-4" data-testid="retrieval-detail-content">
      {/* ─── Human summary ────────────────────────────────────────────── */}
      <div className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Memory Relevance</p>
            <p className="mt-1 text-sm text-[var(--text)]">
              {usedCandidates.length} sent to agent · {keptOutsidePrompt.length} relevant but not sent · {detail.droppedCandidates.length} ignored
            </p>
          </div>
          {detail.needsMoreEvidence && (
            <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
              Needs more evidence
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <DetailField label="Tier / Method" value={detail.retrievalTier ?? 'Unknown'} testId="retrieval-tier" />
          <DetailField label="Latency" value={detail.latencyMs != null ? `${detail.latencyMs}ms` : 'Unknown'} testId="retrieval-latency" />
          <DetailField label="Candidates" value={`${detail.selectedCount} / ${detail.candidateCount} selected`} testId="retrieval-counts" />
          <DetailField label="Token budget" value={detail.tokenBudget.toLocaleString()} testId="retrieval-budget" />
          <DetailField label="Story" value={detail.storyId || 'Unknown'} />
          <DetailField label="Query" value={detail.query || 'Not recorded'} />
        </div>
      </div>

      <ContextReceiptCard detail={detail} />

      {detail.contradictions.length > 0 && (
        <div className="rounded border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-500">
          <p className="font-medium">Potentially conflicting memories</p>
          <ul className="mt-1 list-disc pl-4 space-y-0.5">
            {detail.contradictions.map(([left, right], index) => (
              <li key={`${left}-${right}-${index}`}>{left} conflicts with {right}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ─── Matched skills ───────────────────────────────────────────── */}
      {detail.matchedSkills.length > 0 && (
        <div data-testid="retrieval-matched-skills">
          <SectionLabel>Matched because</SectionLabel>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {detail.matchedSkills.map((skill) => (
              <span
                key={skill}
                className="px-2 py-0.5 text-[10px] font-medium rounded bg-[var(--accent)]/10 text-[var(--accent)]"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ─── Used candidates ──────────────────────────────────────────── */}
      <CandidateSection
        testId="retrieval-selected-section"
        title="Sent to agent"
        candidates={usedCandidates}
        emptyText="No memories or context candidates were sent to the agent."
        storyId={detail.storyId}
        tone="used"
      />

      {keptOutsidePrompt.length > 0 && (
        <CandidateSection
          testId="retrieval-kept-section"
          title="Relevant, not sent"
          candidates={keptOutsidePrompt}
          emptyText="No selected candidates were held back from the agent context."
          storyId={detail.storyId}
          tone="kept"
        />
      )}

      {/* ─── Dropped candidates ───────────────────────────────────────── */}
      <div data-testid="retrieval-dropped-section">
        <details className="group rounded border border-border/70 bg-[var(--surface-100)]" data-testid="retrieval-dropped-details">
          <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 text-xs text-[var(--text)]">
            <span className="font-medium">Ignored candidates ({detail.droppedCandidates.length})</span>
            <span className="text-muted">{droppedSummary || 'No ignored candidates'}</span>
          </summary>
          <div className="border-t border-border/70 p-3">
            {detail.droppedCandidates.length === 0 ? (
              <p className="text-xs text-muted">No candidates were dropped.</p>
            ) : (
              <div className="space-y-2">
                {detail.droppedCandidates.map((candidate) => (
                  <CandidateCard key={candidate.key} candidate={candidate} storyId={detail.storyId} tone="dropped" />
                ))}
              </div>
            )}
          </div>
        </details>
      </div>

      {/* ─── Raw summary ──────────────────────────────────────────────── */}
      {detail.rawSummary && (
        <details className="rounded border border-border/70 bg-[var(--surface-100)]" data-testid="retrieval-raw-summary">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text)]">Retrieval run summary</summary>
          <p className="border-t border-border/70 p-3 text-xs text-muted whitespace-pre-wrap">{detail.rawSummary}</p>
        </details>
      )}
    </div>
  );
}

// ─── Graph node insight drawer ──────────────────────────────────────────────

interface GraphNodeInsightDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  node: PositionedNode | null;
  graphData: SpecRelevanceGraphResponse | null;
  telemetryId: string | null;
  telemetryState: RetrievalTelemetryState;
  onOpenRetrieval: (telemetryId: string) => void;
}

function GraphNodeInsightDrawer({
  isOpen,
  onClose,
  node,
  graphData,
  telemetryId,
  telemetryState,
  onOpenRetrieval,
}: GraphNodeInsightDrawerProps) {
  const title = node ? `${nodeTypeLabel(node.type)} · ${truncateText(node.title || node.label, 72)}` : 'Context insight';

  return (
    <SlideOver isOpen={isOpen} onClose={onClose} title={title}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4" data-testid="graph-node-insight-drawer">
        {node ? (
          <GraphNodeInsightContent
            node={node}
            graphData={graphData}
            telemetryId={telemetryId}
            telemetryState={telemetryState}
            onOpenRetrieval={onOpenRetrieval}
          />
        ) : (
          <p className="text-sm text-muted py-10 text-center">No graph node selected.</p>
        )}
      </div>
    </SlideOver>
  );
}

function GraphNodeInsightContent({
  node,
  graphData,
  telemetryId,
  telemetryState,
  onOpenRetrieval,
}: {
  node: PositionedNode;
  graphData: SpecRelevanceGraphResponse | null;
  telemetryId: string | null;
  telemetryState: RetrievalTelemetryState;
  onOpenRetrieval: (telemetryId: string) => void;
}) {
  const relatedEdges = useMemo(() => getRelatedEdges(node, graphData), [node, graphData]);
  const relatedNodes = useMemo(() => getRelatedNodes(node, graphData, relatedEdges), [node, graphData, relatedEdges]);
  const candidate = useMemo(
    () => (telemetryState.detail ? findCandidateForGraphNode(node, telemetryState.detail) : null),
    [node, telemetryState.detail],
  );
  const storyId = telemetryState.detail?.storyId || node.storyId || graphData?.hub?.storyId || '';
  const status = getGraphNodeStatus(node, candidate);
  const score = candidate?.relevanceScore ?? node.relevanceScore ?? null;
  const breakdown = mergeScoreBreakdown(node, candidate);
  const insight = describeGraphNodeInsight(node, candidate, graphData, relatedEdges.length);
  const guide = describeGraphNodeGuide(node, candidate, graphData, relatedEdges.length);
  const candidateTone = candidate ? candidateToneFromCandidate(candidate) : node.dropped ? 'dropped' : node.enteredPrompt ? 'used' : 'kept';

  return (
    <div className="space-y-4" data-testid="graph-node-insight">
      <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                {nodeTypeLabel(node.type)}
              </span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}>
                {status.label}
              </span>
              {node.category && <MemoryCategoryBadge category={node.category} />}
            </div>
            <h3 className="mt-2 text-base font-semibold text-[var(--text)]" title={node.label}>
              {candidate?.title || node.title || node.label}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted">{insight}</p>
          </div>
          {score != null && (
            <span className={`shrink-0 rounded px-2 py-1 font-mono text-sm font-semibold ${scoreClass(Math.round(score * 100))}`} title="Overall relevance score">
              {Math.round(score * 100)}%
            </span>
          )}
        </div>

        {node.keptOrDroppedReason && (
          <div className="rounded bg-[var(--surface-100)] p-2.5 text-xs leading-5 text-[var(--text)]">
            <span className="font-semibold text-muted">Decision: </span>{node.keptOrDroppedReason}
          </div>
        )}

        {telemetryId && (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
            {telemetryState.loading && <Loader2 size={12} className="animate-spin" />}
            {telemetryState.error && <span className="text-rose-400">Could not load full retrieval receipt: {telemetryState.error}</span>}
            {telemetryState.detail && (
              <button
                type="button"
                onClick={() => onOpenRetrieval(telemetryId)}
                className="inline-flex items-center gap-1 rounded bg-[var(--accent)]/10 px-2 py-1 text-[var(--accent)] hover:bg-[var(--accent)]/15"
              >
                <Search size={11} />
                Open full retrieval receipt
              </button>
            )}
          </div>
        )}
      </section>

      <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3" data-testid="graph-node-guide">
        <SectionLabel>What am I looking at?</SectionLabel>
        <div className="grid gap-2 md:grid-cols-3">
          <GuideTile label="Represents" value={guide.represents} />
          <GuideTile label="Why it matters" value={guide.whyItMatters} />
          <GuideTile label="Useful next step" value={guide.nextStep} />
        </div>
      </section>

      {node.type === 'hub' && graphData && <HubInsight graphData={graphData} />}
      {node.type === 'file' && <FileInsight node={node} relatedNodes={relatedNodes} />}

      {(node.type === 'memory' || node.type === 'context') && !candidate && (
        <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3">
          <SectionLabel>Memory context</SectionLabel>
          <MemoryFact label="Title" value={node.title || node.label} />
          <MemoryFact label="Rule / snippet" value={node.snippet || 'No snippet was recorded for this graph node.'} />
          <MemoryFact label="Scope" value={node.sourceId || node.entityId} />
        </section>
      )}

      {(node.type === 'memory' || node.type === 'context') && candidate && (
        <CandidateCard candidate={candidate} storyId={storyId} tone={candidateTone} />
      )}

      {breakdown && <GraphScoreBreakdownPanel breakdown={breakdown} finalScore={score} />}

      <ConnectedEvidenceList node={node} graphData={graphData} edges={relatedEdges} relatedNodes={relatedNodes} />
    </div>
  );
}

function GuideTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-[var(--surface-100)] p-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xs leading-5 text-[var(--text)]">{value}</p>
    </div>
  );
}

function HubInsight({ graphData }: { graphData: SpecRelevanceGraphResponse }) {
  return (
    <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3">
      <div className="flex items-center gap-2">
        <GitBranch size={13} className="text-[var(--accent)]" />
        <SectionLabel>Graph hub</SectionLabel>
      </div>
      <p className="text-xs leading-5 text-[var(--text)]">{graphData.summary.hubLabel}</p>
      <div className="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        <DetailField label="Nodes" value={graphData.summary.nodeCount.toLocaleString()} />
        <DetailField label="Edges" value={graphData.summary.edgeCount.toLocaleString()} />
        <DetailField label="Selected" value={graphData.summary.selectedCount.toLocaleString()} />
        <DetailField label="Dropped" value={graphData.summary.droppedCount.toLocaleString()} />
      </div>
      {graphData.fallback.missingReasons.length > 0 && (
        <p className="rounded bg-[var(--surface-100)] p-2 text-[11px] leading-5 text-muted">
          {graphData.fallback.missingReasons.join(' · ')}
        </p>
      )}
    </section>
  );
}

function FileInsight({ node, relatedNodes }: { node: PositionedNode; relatedNodes: PositionedNode[] }) {
  const memoryNodes = relatedNodes.filter((n) => n.type === 'memory' || n.type === 'context');
  return (
    <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Target size={13} className="text-[var(--accent)]" />
        <SectionLabel>File context</SectionLabel>
      </div>
      <MemoryFact label="Path" value={node.path || node.entityId} />
      <p className="text-xs leading-5 text-muted">
        This file was routed into the run context. Connected memory nodes below explain why the file may matter to the current story.
      </p>
      {memoryNodes.length > 0 && (
        <div className="space-y-1.5">
          {memoryNodes.slice(0, 5).map((memory) => (
            <div key={memory.id} className="flex items-center justify-between gap-2 rounded bg-[var(--surface-100)] px-2 py-1.5 text-xs">
              <span className="truncate text-[var(--text)]" title={memory.label}>{memory.label}</span>
              {memory.relevanceScore != null && <span className="font-mono text-muted">{Math.round(memory.relevanceScore * 100)}%</span>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function GraphScoreBreakdownPanel({ breakdown, finalScore }: { breakdown: RelevanceScoreBreakdown; finalScore: number | null }) {
  const rows = [
    ['semantic', 'Semantic / vector', 'Embedding similarity between query and candidate.'],
    ['graph', 'Graph / path', 'Graph proximity or relationship evidence.'],
    ['recency', 'Recency', 'How fresh the memory is.'],
    ['skill', 'Skill alignment', 'Overlap with story or matched skills.'],
    ['arbiter', 'Arbiter', 'Final selection weight.'],
    ['keyword', 'Keyword', 'Lexical keyword overlap.'],
  ] as const;

  return (
    <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3" data-testid="graph-score-breakdown">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>Why it ranked here</SectionLabel>
        {finalScore != null && <span className="font-mono text-xs text-muted">final {Math.round(finalScore * 100)}%</span>}
      </div>
      <div className="space-y-2">
        {rows.map(([key, label, description]) => (
          <ScoreBreakdownRow key={key} label={label} description={description} value={breakdown[key]} />
        ))}
      </div>
    </section>
  );
}

function ScoreBreakdownRow({ label, description, value }: { label: string; description: string; value: number | null | undefined }) {
  const pct = typeof value === 'number' ? Math.round(Math.max(0, Math.min(1, value)) * 100) : null;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-[11px]">
        <span className="text-[var(--text)]" title={description}>{label}</span>
        <span className="font-mono text-muted">{pct == null ? 'n/a' : `${pct}%`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-[var(--surface-100)]">
        <div
          className="h-full rounded bg-[var(--accent)]"
          style={{ width: `${pct ?? 0}%`, opacity: pct == null ? 0.2 : 0.75 }}
        />
      </div>
    </div>
  );
}

function ConnectedEvidenceList({
  node,
  graphData,
  edges,
  relatedNodes,
}: {
  node: PositionedNode;
  graphData: SpecRelevanceGraphResponse | null;
  edges: RelevanceEdge[];
  relatedNodes: PositionedNode[];
}) {
  if (!graphData || edges.length === 0) {
    return (
      <section className="rounded border border-border bg-[var(--surface-200)] p-3">
        <SectionLabel>Connected evidence</SectionLabel>
        <p className="mt-2 text-xs text-muted">No graph edges were recorded for this node.</p>
      </section>
    );
  }

  return (
    <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-2" data-testid="graph-connected-evidence">
      <SectionLabel>Connected evidence ({edges.length})</SectionLabel>
      {edges.map((edge) => {
        const otherId = edge.source === node.id ? edge.target : edge.source;
        const other = relatedNodes.find((n) => n.id === otherId);
        return (
          <div key={edge.id} className="rounded bg-[var(--surface-100)] p-2.5 text-xs space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-[var(--text)]">{formatRelationLabel(edge.relation)}</span>
              {other && <span className="max-w-[260px] truncate text-muted" title={other.label}>{other.label}</span>}
            </div>
            <p className="text-[11px] leading-5 text-muted">{edge.evidence || 'No explicit edge evidence recorded.'}</p>
            {edge.scoreContribution != null && (
              <p className="font-mono text-[10px] text-muted">score contribution: {edge.scoreContribution.toFixed(3)}</p>
            )}
          </div>
        );
      })}
    </section>
  );
}

function ContextReceiptCard({ detail }: { detail: RetrievalTelemetryDetail }) {
  const receipt = detail.contextReceipt ?? buildFallbackReceipt(detail);
  const selectedCount = detail.selectedCandidates.filter((candidate) => candidate.enteredPrompt !== false).length;
  const ignoredCount = detail.droppedCandidates.length;
  const promptSize = receipt.promptBytes != null ? `${receipt.promptBytes.toLocaleString()} bytes` : 'Size unknown';

  return (
    <section className="rounded border border-border bg-[var(--surface-200)] p-3 space-y-3" data-testid="context-receipt">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Context Receipt</p>
          <p className="mt-1 text-sm font-semibold text-[var(--text)]">
            {receipt.storyTitle || receipt.storyId}
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            {receipt.specTitle || receipt.specId || 'Unknown spec'} · Story {receipt.storyId}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5 text-[10px] text-muted">
          <span className="rounded bg-[var(--surface-300)] px-1.5 py-0.5">{selectedCount} sent</span>
          <span className="rounded bg-[var(--surface-300)] px-1.5 py-0.5">{ignoredCount} ignored</span>
          <span className="rounded bg-[var(--surface-300)] px-1.5 py-0.5">{promptSize}</span>
        </div>
      </div>

      <div className="rounded bg-[var(--surface-100)] p-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Retrieval query / task</p>
        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-[var(--text)]">{receipt.retrievalQuery || detail.query || 'Not recorded'}</p>
      </div>

      <div className="grid gap-2 md:grid-cols-3">
        {(receipt.receiptSteps && receipt.receiptSteps.length > 0 ? receipt.receiptSteps : defaultReceiptSteps(detail)).map((step, index) => (
          <div key={`${step}-${index}`} className="rounded border border-border/60 bg-[var(--surface-100)] p-2.5 text-xs text-muted">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Step {index + 1}</p>
            <p className="mt-1 leading-5">{step}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <details className="rounded border border-border/70 bg-[var(--surface-100)]" data-testid="context-receipt-story">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text)]">View story</summary>
          <div className="space-y-2 border-t border-border/70 p-3 text-xs text-muted">
            {receipt.storyDescription ? (
              <p className="whitespace-pre-wrap leading-5">{receipt.storyDescription}</p>
            ) : (
              <p>Story description was not available in the spec file for this run.</p>
            )}
            {receipt.acceptanceCriteria && receipt.acceptanceCriteria.length > 0 && (
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Acceptance criteria</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {receipt.acceptanceCriteria.map((criterion, index) => (
                    <li key={`${criterion}-${index}`}>{criterion}</li>
                  ))}
                </ul>
              </div>
            )}
            {receipt.specPath && <p className="font-mono text-[10px]">{receipt.specPath}</p>}
          </div>
        </details>

        <details className="rounded border border-border/70 bg-[var(--surface-100)]" data-testid="context-receipt-prompt">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-[var(--text)]">View prompt excerpt</summary>
          <div className="border-t border-border/70 p-3 text-xs text-muted">
            {receipt.promptExcerpt ? (
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-[var(--surface-200)] p-2 font-mono text-[11px] leading-5 text-[var(--text)]">{receipt.promptExcerpt}</pre>
            ) : (
              <p>{receipt.promptUnavailableReason || 'Prompt excerpt is not available for this retrieval.'}</p>
            )}
            {receipt.promptRawRef && <p className="mt-2 font-mono text-[10px] text-muted">rawRef: {receipt.promptRawRef}</p>}
          </div>
        </details>
      </div>
    </section>
  );
}

function buildFallbackReceipt(detail: RetrievalTelemetryDetail): RetrievalContextReceipt {
  return {
    storyId: detail.storyId,
    storyTitle: null,
    storyDescription: null,
    acceptanceCriteria: [],
    retrievalQuery: detail.query,
    promptRawRef: null,
    promptExcerpt: null,
    promptBytes: null,
    promptUnavailableReason: 'This run does not include prompt receipt metadata yet.',
    receiptSteps: defaultReceiptSteps(detail),
  };
}

function defaultReceiptSteps(detail: RetrievalTelemetryDetail): string[] {
  return [
    `Story ${detail.storyId || 'Unknown'} triggered context retrieval.`,
    `${detail.selectedCount}/${detail.candidateCount} memory candidates were selected for agent context.`,
    'Selected memories are shown below with dropped candidates collapsed for review.',
  ];
}

function findTelemetryIdForGraphNode(
  node: PositionedNode,
  events: ContextTraceEvent[],
  graphData: SpecRelevanceGraphResponse | null,
): string | null {
  if (node.retrievalTelemetryId) return node.retrievalTelemetryId;

  const direct = events.find(
    (event) => event.retrievalTelemetryId && (
      event.retrievalTelemetryId === node.sourceId ||
      event.retrievalTelemetryId === node.entityId ||
      event.retrievalTelemetryId === node.id
    ),
  );
  if (direct?.retrievalTelemetryId) return direct.retrievalTelemetryId;

  const graphNodeTelemetry = graphData?.nodes.find((n) => n.id === node.id)?.retrievalTelemetryId;
  if (graphNodeTelemetry) return graphNodeTelemetry;

  const retrievalIds = [...new Set(
    events
      .filter((event) => event.phase === 'memory' || event.phase === 'graph')
      .map((event) => event.retrievalTelemetryId)
      .filter((id): id is string => Boolean(id)),
  )];
  return retrievalIds.length === 1 ? retrievalIds[0] : null;
}

function getRelatedEdges(node: PositionedNode, graphData: SpecRelevanceGraphResponse | null): RelevanceEdge[] {
  if (!graphData) return [];
  return graphData.edges.filter((edge) => edge.source === node.id || edge.target === node.id);
}

function getRelatedNodes(
  node: PositionedNode,
  graphData: SpecRelevanceGraphResponse | null,
  edges: RelevanceEdge[],
): PositionedNode[] {
  if (!graphData) return [];
  const ids = new Set(edges.map((edge) => (edge.source === node.id ? edge.target : edge.source)));
  return graphData.nodes.filter((n) => ids.has(n.id)) as PositionedNode[];
}

function findCandidateForGraphNode(
  node: PositionedNode,
  detail: RetrievalTelemetryDetail,
): RetrievalCandidateDetail | null {
  const candidates = [...detail.selectedCandidates, ...detail.droppedCandidates];
  const nodeIds = [node.entityId, node.sourceId, node.id].filter((id): id is string => Boolean(id));

  return candidates.find((candidate) => {
    const candidateIds = [candidate.key, candidate.canonicalKey].filter((id): id is string => Boolean(id));
    return candidateIds.some((id) => nodeIds.includes(id)) ||
      nodeIds.some((nodeId) => candidateIds.some((candidateId) => nodeId.includes(candidateId) || candidateId.includes(nodeId)));
  }) ?? null;
}

function nodeTypeLabel(type: PositionedNode['type']): string {
  switch (type) {
    case 'hub': return 'Spec hub';
    case 'file': return 'Routed file';
    case 'context': return 'Context item';
    case 'memory': return 'Memory';
    default: return 'Graph node';
  }
}

function getGraphNodeStatus(node: PositionedNode, candidate: RetrievalCandidateDetail | null): { label: string; className: string } {
  if (candidate?.supersededBy) return { label: 'Superseded', className: 'bg-rose-500/10 text-rose-400' };
  if ((candidate?.conflictsWith?.length ?? 0) > 0 || candidate?.decision === 'conflict') return { label: 'Conflicting', className: 'bg-rose-500/10 text-rose-400' };
  if (node.dropped || candidate?.decision === 'drop') return { label: 'Ignored', className: 'bg-rose-500/10 text-rose-400' };
  if (candidate?.decision === 'needs-more') return { label: 'Needs review', className: 'bg-amber-500/10 text-amber-500' };
  if (node.enteredPrompt || candidate?.enteredPrompt) return { label: 'Sent to agent', className: 'bg-emerald-500/10 text-emerald-500' };
  if (node.selected || candidate?.selected) return { label: 'Relevant, not sent', className: 'bg-amber-500/10 text-amber-500' };
  if (node.type === 'file') return { label: 'Routed', className: 'bg-[var(--accent)]/10 text-[var(--accent)]' };
  if (node.type === 'hub') return { label: 'Center', className: 'bg-[var(--accent)]/10 text-[var(--accent)]' };
  return { label: 'Candidate', className: 'bg-[var(--surface-300)] text-muted' };
}

function mergeScoreBreakdown(node: PositionedNode, candidate: RetrievalCandidateDetail | null): RelevanceScoreBreakdown | null {
  const candidateBreakdown = candidate?.scoreBreakdown;
  const nodeBreakdown = node.scoreBreakdown;
  if (!candidateBreakdown && !nodeBreakdown) return null;
  return {
    semantic: candidateBreakdown?.semantic ?? nodeBreakdown?.semantic ?? null,
    graph: candidateBreakdown?.graph ?? nodeBreakdown?.graph ?? null,
    recency: candidateBreakdown?.recency ?? nodeBreakdown?.recency ?? null,
    skill: candidateBreakdown?.skill ?? nodeBreakdown?.skill ?? null,
    arbiter: nodeBreakdown?.arbiter ?? candidate?.relevanceScore ?? node.relevanceScore ?? null,
    keyword: candidateBreakdown?.keyword ?? nodeBreakdown?.keyword ?? null,
  };
}

function describeGraphNodeInsight(
  node: PositionedNode,
  candidate: RetrievalCandidateDetail | null,
  graphData: SpecRelevanceGraphResponse | null,
  edgeCount: number,
): string {
  const score = Math.round((candidate?.relevanceScore ?? node.relevanceScore ?? 0) * 100);
  if (node.type === 'hub') {
    return `This is the center of the context graph. It anchors ${graphData?.summary.nodeCount ?? 0} nodes and ${graphData?.summary.edgeCount ?? 0} evidence edges for this run.`;
  }
  if (node.type === 'file') {
    return `Rorca routed this file as relevant context for the story. It has ${edgeCount} graph connection${edgeCount === 1 ? '' : 's'} back to the run hub or memories.`;
  }
  if (node.dropped || candidate?.decision === 'drop') {
    return `Rorca considered this memory at ${score}% relevance, then left it out of the agent prompt because stronger or safer context was available.`;
  }
  if (candidate?.enteredPrompt === false) {
    return `Rorca judged this memory relevant at ${score}% but held it outside the prompt to preserve budget or diversity.`;
  }
  return `Rorca used this memory as context at ${score}% relevance. The score bars below show which retrieval signals made it useful.`;
}

function describeGraphNodeGuide(
  node: PositionedNode,
  candidate: RetrievalCandidateDetail | null,
  graphData: SpecRelevanceGraphResponse | null,
  edgeCount: number,
): { represents: string; whyItMatters: string; nextStep: string } {
  const score = Math.round((candidate?.relevanceScore ?? node.relevanceScore ?? 0) * 100);

  if (node.type === 'hub') {
    return {
      represents: graphData?.summary.hubLabel || 'The run, story, or spec this context graph is centered on.',
      whyItMatters: 'Every line from this node is evidence Rorca considered while assembling context for the agent.',
      nextStep: 'Click an outer memory bubble to see the exact rule, provenance, score, and prompt decision.',
    };
  }

  if (node.type === 'file') {
    return {
      represents: `A source file Rorca predicted or routed into context${node.path ? `: ${node.path}` : '.'}`,
      whyItMatters: 'Files on this ring are the code areas Rorca expected the story to touch or need for orientation.',
      nextStep: edgeCount > 1
        ? 'Review the connected memories to understand what prior lessons apply to this file.'
        : 'Use this as a quick check that context routing targeted the right code area.',
    };
  }

  if (node.dropped || candidate?.decision === 'drop') {
    return {
      represents: 'A memory candidate Rorca evaluated but did not send to the agent.',
      whyItMatters: `It scored ${score}%, but was treated as lower-value, redundant, stale, or risky compared with selected context.`,
      nextStep: 'Check the decision reason and score bars; if it looks important, the retrieval rules may need tuning.',
    };
  }

  if (candidate?.enteredPrompt === false) {
    return {
      represents: 'A relevant memory Rorca kept as evidence but held outside the final prompt.',
      whyItMatters: `It scored ${score}%, but was likely omitted to preserve token budget or diversify context.`,
      nextStep: 'Open the full retrieval receipt to compare it with memories that were actually sent.',
    };
  }

  return {
    represents: 'A workspace memory that was selected as useful context for the agent.',
    whyItMatters: `It scored ${score}% and shaped what the agent saw before working on the story.`,
    nextStep: 'Read the rule/context fields and score breakdown to understand exactly why it influenced the run.',
  };
}

function candidateToneFromCandidate(candidate: RetrievalCandidateDetail): CandidateTone {
  if (!candidate.selected || candidate.decision === 'drop') return 'dropped';
  if (candidate.enteredPrompt === false) return 'kept';
  return 'used';
}

function formatRelationLabel(relation: string): string {
  return relation.replace(/_/g, ' ').split(' ').map(sentenceCase).join(' ');
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;
}

function CandidateSection({
  testId,
  title,
  candidates,
  emptyText,
  storyId,
  tone,
}: {
  testId: string;
  title: string;
  candidates: RetrievalCandidateDetail[];
  emptyText: string;
  storyId: string;
  tone: CandidateTone;
}) {
  return (
    <div data-testid={testId}>
      <SectionLabel>{title} ({candidates.length})</SectionLabel>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted mt-1">{emptyText}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.key} candidate={candidate} storyId={storyId} tone={tone} />
          ))}
        </div>
      )}
    </div>
  );
}

type CandidateTone = 'used' | 'kept' | 'dropped';

type TaxonomyTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

interface TaxonomyChip {
  label: string;
  value: string;
  tone?: TaxonomyTone;
  showLabel?: boolean;
}

function CandidateCard({ candidate, storyId, tone }: { candidate: RetrievalCandidateDetail; storyId: string; tone: CandidateTone }) {
  const scorePercent = Math.round(candidate.relevanceScore * 100);
  const promptLabel = candidate.enteredPrompt == null
    ? 'Unknown'
    : candidate.enteredPrompt
      ? 'Yes'
      : 'No';
  const display = getCandidateDisplay(candidate);
  const status = getCandidateStatus(candidate, tone);
  const matchedBecause = getMatchedBecause(candidate);
  const taxonomy = getCandidateTaxonomy(candidate, storyId, tone);
  const context = describeCandidateContext(candidate, storyId);
  const scope = describeCandidateScope(candidate, storyId);

  return (
    <article
      className={`rounded border ${status.borderClass} bg-[var(--surface-200)] p-3 space-y-3`}
      data-testid={`candidate-${candidate.key}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5" aria-label="Memory taxonomy">
            {taxonomy.map((chip) => (
              <TaxonomyBadge key={`${chip.label}:${chip.value}`} chip={chip} />
            ))}
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Title</p>
            <h4 className="mt-0.5 text-sm font-semibold text-[var(--text)]" title={display.title}>
              {display.title}
            </h4>
          </div>
        </div>
        <span className={`shrink-0 rounded px-2 py-1 font-mono text-xs font-semibold ${scoreClass(scorePercent)}`} title="Overall relevance score">
          {scorePercent}%
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <MemoryFact label="Rule" value={display.rule || 'No explicit rule text was recorded for this memory.'} />
        <MemoryFact label="Context" value={context} />
      </div>

      <div className="rounded bg-[var(--surface-100)] p-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Relevance to this story</p>
        <p className="mt-1 text-xs leading-5 text-[var(--text)]">{explainCandidateRelevance(candidate, tone)}</p>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <MemoryFact label="Scope" value={scope} />
        <MemoryFact label="Source" value={describeCandidateSource(candidate)} />
      </div>

      {matchedBecause.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Matched because</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {matchedBecause.map((item) => (
              <span key={item} className="rounded bg-[var(--surface-300)] px-1.5 py-0.5 text-[10px] text-muted">
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      {candidate.relatedFiles && candidate.relatedFiles.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Related files</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {candidate.relatedFiles.slice(0, 6).map((file) => (
              <span key={file} className="rounded bg-[var(--surface-300)] px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {file}
              </span>
            ))}
            {candidate.relatedFiles.length > 6 && (
              <span className="text-[10px] text-muted">+{candidate.relatedFiles.length - 6} more</span>
            )}
          </div>
        </div>
      )}

      <details className="rounded border border-border/60 bg-[var(--surface-100)]">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-medium text-muted">Evidence</summary>
        <div className="border-t border-border/60 p-2.5 text-[11px] text-muted space-y-1.5">
          <p>Score: {Object.entries(candidate.scoreBreakdown).map(([k, v]) => `${k}: ${formatScoreValue(v)}`).join(', ') || 'N/A'}</p>
          <p>Sent to agent: {promptLabel}</p>
          <p>Decision: {candidate.decision || (candidate.selected ? 'keep' : 'drop')}</p>
          <p>Reason: {candidate.keptOrDroppedReason || 'Not recorded'}</p>
          {candidate.conflictsWith && candidate.conflictsWith.length > 0 && <p>Conflicts with: {candidate.conflictsWith.join(', ')}</p>}
          {candidate.supersededBy && <p>Superseded by: {candidate.supersededBy}</p>}
          <p className="break-all">Key: {candidate.key}</p>
          {candidate.canonicalKey && <p className="break-all">Graph key: {candidate.canonicalKey}</p>}
        </div>
      </details>
    </article>
  );
}

function MemoryCategoryBadge({
  category,
  showPrefix = false,
  compact = false,
}: {
  category: string;
  showPrefix?: boolean;
  compact?: boolean;
}) {
  const style = memoryCategoryStyle(category);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border font-semibold ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]'} ${style.badgeClass}`}
      title={`${style.description} (${category})`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dotClass}`} aria-hidden="true" />
      {showPrefix && <span className="opacity-75">Type:</span>}
      <span>{style.label}</span>
    </span>
  );
}

function memoryCategoryStyle(category: string): { label: string; badgeClass: string; dotClass: string; description: string } {
  const normalized = category.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  switch (normalized) {
    case 'architecture':
      return {
        label: 'Architecture',
        badgeClass: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
        dotClass: 'bg-sky-300',
        description: 'Structural or system-design guidance',
      };
    case 'convention':
      return {
        label: 'Convention',
        badgeClass: 'bg-violet-500/10 text-violet-300 border-violet-500/30',
        dotClass: 'bg-violet-300',
        description: 'Project style, naming, or process rule',
      };
    case 'bug fix':
    case 'bugfix':
      return {
        label: 'Bug Fix',
        badgeClass: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
        dotClass: 'bg-rose-300',
        description: 'Previously fixed issue or regression lesson',
      };
    case 'decision':
      return {
        label: 'Decision',
        badgeClass: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
        dotClass: 'bg-amber-300',
        description: 'Product or engineering choice that should be preserved',
      };
    case 'pattern':
      return {
        label: 'Pattern',
        badgeClass: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
        dotClass: 'bg-emerald-300',
        description: 'Reusable implementation approach',
      };
    case 'gotcha':
      return {
        label: 'Gotcha',
        badgeClass: 'bg-orange-500/10 text-orange-300 border-orange-500/30',
        dotClass: 'bg-orange-300',
        description: 'Trap, constraint, or surprising behavior to avoid',
      };
    default:
      return {
        label: category || 'Memory',
        badgeClass: 'bg-[var(--surface-300)] text-muted border-border/60',
        dotClass: 'bg-muted',
        description: 'Memory category',
      };
  }
}

function TaxonomyBadge({ chip }: { chip: TaxonomyChip }) {
  if (chip.label === 'Category') {
    return <MemoryCategoryBadge category={chip.value} showPrefix={chip.showLabel} compact />;
  }

  const toneClass = chip.tone === 'success'
    ? 'bg-emerald-500/10 text-emerald-500'
    : chip.tone === 'warning'
      ? 'bg-amber-500/10 text-amber-500'
      : chip.tone === 'danger'
        ? 'bg-rose-500/10 text-rose-400'
        : chip.tone === 'accent'
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'bg-[var(--surface-300)] text-muted';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${toneClass}`} title={`${chip.label}: ${chip.value}`}>
      {chip.showLabel ? <span className="text-muted/90">{chip.label}: </span> : <span className="sr-only">{chip.label}: </span>}{chip.value}
    </span>
  );
}

function MemoryFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted whitespace-pre-wrap">{value}</p>
    </div>
  );
}

function getCandidateDisplay(candidate: RetrievalCandidateDetail): { title: string; rule: string } {
  const rawTitle = candidate.title?.trim();
  const rawSnippet = candidate.snippet?.trim() ?? '';
  if (rawTitle && rawSnippet.toLowerCase().startsWith(`${rawTitle.toLowerCase()}:`)) {
    return { title: rawTitle, rule: rawSnippet.slice(rawTitle.length + 1).trim() };
  }

  if (rawTitle) return { title: rawTitle, rule: rawSnippet };

  const [title, ...rest] = rawSnippet.split(':');
  if (title?.trim() && rest.length > 0 && title.trim().length <= 120) {
    return { title: title.trim(), rule: rest.join(':').trim() };
  }

  return { title: humanizeCandidateKey(candidate.key), rule: rawSnippet };
}

function humanizeCandidateKey(key: string): string {
  const memoryId = key.match(/memory:[^:]+::(.+)$/)?.[1] ?? key.match(/^memory:(.+)$/)?.[1];
  if (memoryId) return `Memory ${memoryId.replace(/^memory-/, '').replace(/-/g, ' ')}`;
  return key.replace(/[-_]/g, ' ');
}

function getCandidateStatus(candidate: RetrievalCandidateDetail, tone: CandidateTone): { label: string; badgeClass: string; borderClass: string; tone: TaxonomyTone } {
  if (candidate.supersededBy) {
    return {
      label: 'Superseded',
      badgeClass: 'bg-rose-500/10 text-rose-400',
      borderClass: 'border-rose-500/20',
      tone: 'danger',
    };
  }
  if (candidate.conflictsWith && candidate.conflictsWith.length > 0 || candidate.decision === 'conflict') {
    return {
      label: 'Conflicting',
      badgeClass: 'bg-rose-500/10 text-rose-400',
      borderClass: 'border-rose-500/20',
      tone: 'danger',
    };
  }
  if (tone === 'dropped') {
    return {
      label: 'Ignored',
      badgeClass: 'bg-rose-500/10 text-rose-400',
      borderClass: 'border-rose-500/20',
      tone: 'danger',
    };
  }
  if (candidate.decision === 'needs-more') {
    return {
      label: 'Needs review',
      badgeClass: 'bg-amber-500/10 text-amber-500',
      borderClass: 'border-amber-500/20',
      tone: 'warning',
    };
  }
  if (tone === 'kept' || candidate.enteredPrompt === false) {
    return {
      label: 'Relevant, not sent',
      badgeClass: 'bg-amber-500/10 text-amber-500',
      borderClass: 'border-amber-500/20',
      tone: 'warning',
    };
  }
  return {
    label: 'Sent to agent',
    badgeClass: 'bg-emerald-500/10 text-emerald-500',
    borderClass: 'border-emerald-500/20',
    tone: 'success',
  };
}

function getCandidateTaxonomy(candidate: RetrievalCandidateDetail, storyId: string, tone: CandidateTone): TaxonomyChip[] {
  const status = getCandidateStatus(candidate, tone);
  const category = candidate.category || humanizeSourceType(candidate.sourceType) || 'Memory';
  const origin = humanizeSourceType(candidate.sourceType) || humanizeSourceType(candidate.origin) || '';
  const chips: TaxonomyChip[] = [
    { label: 'Category', value: category, tone: 'accent', showLabel: true },
    ...(origin && origin.toLowerCase() !== category.toLowerCase()
      ? [{ label: 'Origin', value: origin, showLabel: true }]
      : []),
    { label: 'Confidence', value: candidate.confidence ? `${sentenceCase(candidate.confidence)} confidence` : 'Confidence not recorded' },
    { label: 'Lifecycle', value: getLifecycleLabel(candidate, status.label), tone: status.tone },
    { label: 'Scope', value: getScopeLabel(candidate, storyId) },
    { label: 'Role', value: status.label, tone: status.tone },
    ...(candidate.pinned ? [{ label: 'Pinned', value: 'Pinned', tone: 'success' as TaxonomyTone }] : []),
  ];
  return chips;
}

function getLifecycleLabel(candidate: RetrievalCandidateDetail, statusLabel: string): string {
  if (candidate.supersededBy) return 'Superseded';
  if (candidate.conflictsWith && candidate.conflictsWith.length > 0 || candidate.decision === 'conflict') return 'Conflicting';
  if (candidate.decision === 'needs-more') return 'Needs review';
  if (statusLabel === 'Ignored') return 'Ignored';
  return 'Active';
}

function getScopeLabel(candidate: RetrievalCandidateDetail, _storyId: string): string {
  if (candidate.relatedFiles && candidate.relatedFiles.length > 0) return 'File/module-specific';
  if (candidate.sourceStoryId) return 'Story-specific';
  if (candidate.sourceSpecId) return 'Spec-specific';
  return 'Workspace-wide';
}

function describeCandidateScope(candidate: RetrievalCandidateDetail, storyId: string): string {
  const parts: string[] = [];
  parts.push(getScopeLabel(candidate, storyId));
  if (candidate.sourceStoryId) parts.push(`learned from story ${candidate.sourceStoryId}`);
  if (!candidate.sourceStoryId && storyId) parts.push(`being evaluated for story ${storyId}`);
  if (candidate.sourceSpecId) parts.push(`from spec ${candidate.sourceSpecId}`);
  if (candidate.relatedFiles && candidate.relatedFiles.length > 0) parts.push(`${candidate.relatedFiles.length} related file${candidate.relatedFiles.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function describeCandidateSource(candidate: RetrievalCandidateDetail): string {
  const parts = [humanizeSourceType(candidate.sourceType) || humanizeSourceType(candidate.origin) || 'Unknown source'];
  if (candidate.source) parts.push(candidate.source);
  if (candidate.sourceRunId != null) parts.push(`run #${candidate.sourceRunId}`);
  if (candidate.sourceSpecId) parts.push(`spec ${candidate.sourceSpecId}`);
  if (candidate.createdAt) parts.push(`created ${formatShortDate(candidate.createdAt)}`);
  return parts.join(' · ');
}

function describeCandidateContext(candidate: RetrievalCandidateDetail, storyId: string): string {
  const origin = describeOriginVerb(candidate.sourceType || candidate.origin);
  const provenance = getCandidateProvenance(candidate, storyId);
  const files = candidate.relatedFiles && candidate.relatedFiles.length > 0
    ? ` It is associated with ${candidate.relatedFiles.length} file${candidate.relatedFiles.length === 1 ? '' : 's'}.`
    : '';
  const source = provenance ? ` from ${provenance}` : '';
  return `This memory was ${origin}${source}.${files}`;
}

function describeOriginVerb(value?: string | null): string {
  switch (value) {
    case 'synthesis':
      return 'synthesized from prior work';
    case 'manual':
      return 'written manually';
    case 'import':
      return 'imported';
    case 'auto-extracted':
      return 'auto-extracted from repository context';
    case 'mcp':
      return 'created through MCP automation';
    case 'pinned':
      return 'pinned as durable context';
    case 'cache':
      return 'retrieved from recent memory cache';
    case 'search':
      return 'found by semantic search';
    default:
      return value ? `retrieved from ${humanizeSourceType(value).toLowerCase()}` : 'retrieved';
  }
}

function explainCandidateRelevance(candidate: RetrievalCandidateDetail, tone: CandidateTone): string {
  const reason = candidate.keptOrDroppedReason || '';
  const display = getCandidateDisplay(candidate);
  if (tone === 'dropped') {
    return reason
      ? `Rorca considered “${display.title}” but left it out: ${reason}.`
      : `Rorca considered “${display.title}” but left it out because stronger or more diverse context was available.`;
  }
  if (candidate.enteredPrompt === false) {
    return reason
      ? `Rorca judged “${display.title}” relevant, but did not send it to the agent: ${reason}.`
      : `Rorca judged “${display.title}” relevant, but kept it out of the agent context to preserve budget or diversity.`;
  }
  return reason
    ? `Rorca used this memory because ${reason}.`
    : `Rorca used this memory because it matched the current story context and ranked above the cutoff.`;
}

function getMatchedBecause(candidate: RetrievalCandidateDetail): string[] {
  const entries = new Set<string>();
  candidate.matchedSkills?.forEach((skill) => entries.add(skill));
  if (candidate.category) entries.add(candidate.category);
  const sourceType = humanizeSourceType(candidate.sourceType);
  if (sourceType) entries.add(sourceType);
  if (candidate.origin) entries.add(humanizeSourceType(candidate.origin) || candidate.origin);
  if (candidate.pinned) entries.add('Pinned memory');
  for (const [name, value] of Object.entries(candidate.scoreBreakdown)) {
    if (typeof value === 'number' && value > 0) entries.add(`${name} ${formatScoreValue(value)}`);
  }
  return [...entries].slice(0, 8);
}

function getCandidateProvenance(candidate: RetrievalCandidateDetail, storyId: string): string {
  const parts: string[] = [];
  if (candidate.sourceSpecId) parts.push(`spec ${candidate.sourceSpecId}`);
  if (candidate.sourceStoryId) parts.push(`story ${candidate.sourceStoryId}`);
  else if (storyId) parts.push(`story ${storyId}`);
  if (candidate.sourceRunId != null) parts.push(`run #${candidate.sourceRunId}`);
  return parts.join(' · ');
}

function humanizeSourceType(value?: string | null): string {
  if (!value) return '';
  const normalized = value.replace(/[-_]/g, ' ').trim();
  if (!normalized) return '';
  return normalized.split(/\s+/).map(sentenceCase).join(' ');
}

function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().slice(0, 10);
}

function summarizeDroppedCandidates(candidates: RetrievalCandidateDetail[]): string {
  if (candidates.length === 0) return '';
  const lowScore = candidates.filter((candidate) => candidate.relevanceScore < 0.4).length;
  const weak = candidates.filter((candidate) => /weak|low|below/i.test(candidate.keptOrDroppedReason || '')).length;
  const conflict = candidates.filter((candidate) => /conflict|supersed|stale/i.test(candidate.keptOrDroppedReason || '')).length;
  const parts = [
    lowScore > 0 ? `${lowScore} low score` : null,
    weak > 0 ? `${weak} weak match` : null,
    conflict > 0 ? `${conflict} stale/conflicting` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'collapsed for review';
}

function scoreClass(scorePercent: number): string {
  if (scorePercent >= 70) return 'bg-emerald-500/10 text-emerald-500';
  if (scorePercent >= 40) return 'bg-amber-500/10 text-amber-500';
  return 'bg-rose-500/10 text-rose-400';
}

function formatScoreValue(value: number | undefined): string {
  return typeof value === 'number' ? value.toFixed(2) : 'n/a';
}

function DetailField({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div data-testid={testId}>
      <span className="text-muted">{label}: </span>
      <span className="font-mono text-[var(--text)]">{value}</span>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
      {children}
    </p>
  );
}
