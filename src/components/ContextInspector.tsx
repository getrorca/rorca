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

import { useMemo, useState } from 'react';
import { Layers, AlertTriangle, CheckCircle2, Loader2, ChevronRight, FileText } from 'lucide-react';
import {
  useContextTrace,
  type ContextTraceEvent,
  type ContextTracePhase,
  type ContextTraceStatus,
} from '../hooks/useContextTrace';
import ContextTraceRawDrawer from './ContextTraceRawDrawer';

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
  context: 'Direction / Arbiter',
  skill: 'Skills',
  mcp: 'MCP',
  memory: 'Retrieval',
  prompt: 'Prompt Assembly',
};

/** Funnel display order — retrieval flows from raw context → assembled prompt. */
const FUNNEL_ORDER: ContextTracePhase[] = ['memory', 'context', 'skill', 'mcp', 'prompt'];

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

export default function ContextInspector({ runId, runSettled = true }: ContextInspectorProps) {
  const { events, resolveRaw, getRawState } = useContextTrace(String(runId));

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
              This run did not emit any context-assembly traces, or its trace artifact
              has been pruned. Newer runs stream retrieval, skill, and prompt phases here.
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
          return (
            <button
              key={e.rawRef}
              type="button"
              onClick={() => setActiveRawRef(e.rawRef)}
              className="w-full flex items-center gap-3 px-4 py-2 text-left border-b border-border/50 hover:bg-panel/50 transition-colors"
              data-testid={`inspector-event-${e.rawRef}`}
            >
              <span className={`shrink-0 w-2 h-2 rounded-full ${statusDot(e.status)}`} />
              <span className="font-mono text-[10px] text-muted shrink-0 w-14">{e.rawRef}</span>
              <span className="shrink-0 text-[11px] text-muted w-28 truncate">{PHASE_LABELS[e.phase]}</span>
              <span className="flex-1 min-w-0 truncate text-xs text-[var(--text)]">
                {e.label ?? e.phase}
              </span>
              {e.storyId && (
                <span className="font-mono text-[10px] text-muted shrink-0">{e.storyId}</span>
              )}
              <span className={`text-[11px] shrink-0 ${statusColor(e.status)}`}>{e.status}</span>
              {raw.loading ? (
                <Loader2 size={12} className="shrink-0 text-muted animate-spin" />
              ) : (
                <FileText size={12} className="shrink-0 text-muted/60" />
              )}
              <ChevronRight size={12} className="shrink-0 text-muted/60" />
            </button>
          );
        })}
      </div>

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
