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
import { Layers, AlertTriangle, CheckCircle2, Loader2, ChevronRight, FileText, Search, Network } from 'lucide-react';
import {
  useContextTrace,
  type ContextTraceEvent,
  type ContextTracePhase,
  type ContextTraceStatus,
  type RetrievalTelemetryDetail,
  type RetrievalCandidateDetail,
  type RetrievalTelemetryState,
} from '../hooks/useContextTrace';
import { useRelevanceGraph } from '../hooks/useRelevanceGraph';
import type { PositionedNode } from '../types/spec-relevance-graph';
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

  // Graph node click → open retrieval detail drawer for memory/context nodes.
  const handleGraphNodeClick = useCallback((node: PositionedNode) => {
    // Memory/context nodes may have a sourceId matching a retrievalTelemetryId
    // or we can look up the corresponding event by entityId/sourceId.
    if (node.type === 'memory' || node.type === 'context') {
      // Try to find a matching retrieval event by the node's sourceId.
      const matchingEvent = events.find(
        (e) => e.retrievalTelemetryId && (e.retrievalTelemetryId === node.sourceId || e.retrievalTelemetryId === node.entityId),
      );
      if (matchingEvent?.retrievalTelemetryId) {
        setActiveRetrievalId(matchingEvent.retrievalTelemetryId);
        resolveRetrievalTelemetry(matchingEvent.retrievalTelemetryId).catch(() => {});
        return;
      }
    }
    // For file nodes or nodes without a matching event, open the raw drawer if possible.
    if (node.type === 'file' && node.path) {
      const matchingEvent = events.find((e) => !e.synthetic && e.label?.includes(node.path!));
      if (matchingEvent) {
        setActiveRawRef(matchingEvent.rawRef);
      }
    }
  }, [events, resolveRetrievalTelemetry]);

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
              const displayRef = e.synthetic ? `synthetic:${e.seq}` : e.rawRef;
              // Rows with retrievalTelemetryId are clickable even when synthetic.
              const hasRetrieval = !!e.retrievalTelemetryId;
              const isClickable = hasRetrieval || !e.synthetic;
              return (
                <button
                  key={e.rawRef}
                  type="button"
                  onClick={() => {
                    if (hasRetrieval) {
                      setActiveRetrievalId(e.retrievalTelemetryId!);
                      resolveRetrievalTelemetry(e.retrievalTelemetryId!).catch(() => {});
                    } else if (!e.synthetic) {
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
                    <span className="text-[10px] text-muted/70 truncate">reconstructed</span>
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
  return (
    <div className="space-y-4" data-testid="retrieval-detail-content">
      {/* ─── Summary metrics ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
        <DetailField label="Tier / Method" value={detail.retrievalTier ?? 'Unknown'} testId="retrieval-tier" />
        <DetailField label="Latency" value={detail.latencyMs != null ? `${detail.latencyMs}ms` : 'Unknown'} testId="retrieval-latency" />
        <DetailField label="Candidates" value={`${detail.selectedCount} / ${detail.candidateCount} selected`} testId="retrieval-counts" />
        <DetailField label="Token budget" value={detail.tokenBudget.toLocaleString()} testId="retrieval-budget" />
      </div>

      {/* ─── Matched skills ───────────────────────────────────────────── */}
      {detail.matchedSkills.length > 0 && (
        <div data-testid="retrieval-matched-skills">
          <SectionLabel>Matched skills</SectionLabel>
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

      {/* ─── Selected candidates ──────────────────────────────────────── */}
      <div data-testid="retrieval-selected-section">
        <SectionLabel>
          Selected candidates ({detail.selectedCandidates.length})
        </SectionLabel>
        {detail.selectedCandidates.length === 0 ? (
          <p className="text-xs text-muted mt-1">No candidates selected.</p>
        ) : (
          <div className="mt-1 space-y-1.5">
            {detail.selectedCandidates.map((c) => (
              <CandidateRow key={c.key} candidate={c} />
            ))}
          </div>
        )}
      </div>

      {/* ─── Dropped candidates ───────────────────────────────────────── */}
      <div data-testid="retrieval-dropped-section">
        <SectionLabel>
          Dropped candidates ({detail.droppedCandidates.length})
        </SectionLabel>
        {detail.droppedCandidates.length === 0 ? (
          <p className="text-xs text-muted mt-1">No candidates dropped.</p>
        ) : (
          <div className="mt-1 space-y-1.5">
            {detail.droppedCandidates.map((c) => (
              <CandidateRow key={c.key} candidate={c} />
            ))}
          </div>
        )}
      </div>

      {/* ─── Raw summary ──────────────────────────────────────────────── */}
      {detail.rawSummary && (
        <div data-testid="retrieval-raw-summary">
          <SectionLabel>Raw summary</SectionLabel>
          <p className="text-xs text-muted mt-1 whitespace-pre-wrap">{detail.rawSummary}</p>
        </div>
      )}
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: RetrievalCandidateDetail }) {
  const scorePercent = Math.round(candidate.relevanceScore * 100);
  const promptLabel = candidate.enteredPrompt == null
    ? 'Unknown'
    : candidate.enteredPrompt
      ? 'Yes'
      : 'No';

  return (
    <div
      className="p-2.5 rounded border border-border/60 bg-[var(--surface-200)] space-y-1.5"
      data-testid={`candidate-${candidate.key}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[var(--text)] truncate" title={candidate.title ?? candidate.key}>
            {candidate.title ?? candidate.key}
          </p>
          {candidate.category && (
            <p className="text-[10px] text-muted truncate">{candidate.category} · {candidate.origin}</p>
          )}
          {!candidate.category && (
            <p className="text-[10px] text-muted truncate">{candidate.origin}</p>
          )}
        </div>
        <span className={`shrink-0 font-mono text-xs font-semibold ${scorePercent >= 70 ? 'text-emerald-500' : scorePercent >= 40 ? 'text-amber-500' : 'text-rose-400'}`}>
          {scorePercent}%
        </span>
      </div>

      {candidate.snippet && (
        <p
          className="text-[11px] text-muted leading-4 line-clamp-2"
          title={candidate.snippet}
        >
          {candidate.snippet}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span>Score: {Object.entries(candidate.scoreBreakdown).map(([k, v]) => `${k}: ${v}`).join(', ') || 'N/A'}</span>
        <span>Prompt: {promptLabel}</span>
        <span>Reason: {candidate.keptOrDroppedReason || 'Not recorded'}</span>
        {candidate.matchedSkills && candidate.matchedSkills.length > 0 && (
          <span>Skills: {candidate.matchedSkills.join(', ')}</span>
        )}
      </div>
    </div>
  );
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
