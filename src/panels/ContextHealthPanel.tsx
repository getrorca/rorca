/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * ContextHealthPanel — US-012 workspace context health UI.
 *
 * Shows Hilo / graph provider availability, hydration freshness, graph counts,
 * latest errors, stale reasons, and a trigger-hydration action with
 * queued/running/outcome feedback.
 *
 * Consumes GET /api/workspaces/{workspaceId}/hydration (US-010).
 * Every network call goes through apiFetch; every color uses design tokens.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Network, RefreshCw, AlertTriangle, CheckCircle, Loader2,
  XCircle, Clock, GitBranch, FileCode, Hash, ArrowRightLeft,
  TestTube, Brackets, Zap, ChevronDown, Inbox, HardDrive,
} from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import { useWorkspace } from '../contexts/WorkspaceContext';

// ─── US-038 Diagnostics types ─────────────────────────────────────────────

interface OperatorWarning {
  severity: 'warning' | 'error' | 'info';
  category: 'hilo' | 'graph' | 'candidate' | 'hydration' | 'capture' | 'retrieval';
  message: string;
  detail: string | null;
}

interface CandidateHealthDiag {
  totalCandidates: number;
  pendingCount: number;
  approvedCount: number;
  hasBacklog: boolean;
  backlogWarning: string | null;
}

interface DiagnosticsStatus {
  status: 'ok' | 'degraded' | 'warning';
  graph: { available: boolean; vertexCount: number; edgeCount: number; isStale: boolean; staleReason: string | null };
  candidates: CandidateHealthDiag;
  warnings: OperatorWarning[];
  timestamp: string;
}

// ─── Types matching GET /api/workspaces/{workspaceId}/hydration ─────────────

type HydrationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'cancelled';

type FreshnessStatus = 'clean' | 'stale' | 'dirty' | 'unknown' | 'missing';

interface HydrationCounts {
  files?: number;
  nodes?: number;
  edges?: number;
  imports?: number;
  reverseImporters?: number;
  tests?: number;
  testedBy?: number;
  roles?: number;
  [key: string]: number | undefined;
}

interface LatestHydration {
  id: number;
  workspaceId: string;
  provider: string;
  status: HydrationStatus;
  gitSha: string | null;
  graphPath: string | null;
  counts: HydrationCounts;
  durationMs: number | null;
  staleReason: string | null;
  errorJson: Record<string, unknown> | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface HydrationStatusResponse {
  workspaceId: string;
  provider: 'hilo';
  latest: LatestHydration | null;
  freshness: FreshnessStatus;
  freshnessDetails: {
    gitRepo: boolean;
    hasHydration: boolean;
    headMatches: boolean;
    dirtyTree: boolean;
    currentHead: string | null;
    hydratedSha: string | null;
    humanSummary: string;
  };
  counts: HydrationCounts;
  errors: {
    hasErrors: boolean;
    latestError: Record<string, unknown> | null;
    latestErrorStatus: HydrationStatus | null;
  };
  currentStatus: HydrationStatus | null;
  actionHint: 'hydrate' | 'rehydrate' | 'wait' | 'configure_hilo' | 'none';
  actionMessage: string | null;
}

// ─── Derived state classification for the UI ───────────────────────────────

type ContextHealthState =
  | 'ready'       // hydration succeeded, graph clean/current
  | 'stale'        // graph is out of date vs current HEAD
  | 'running'      // hydration is pending or in flight
  | 'failed'       // latest hydration errored
  | 'disabled'     // Hilo not available (configure_hilo hint)
  | 'missing';     // no hydration attempted yet, but Hilo is available

function classifyState(resp: HydrationStatusResponse | null, loading: boolean): ContextHealthState {
  if (loading) return 'running';
  if (!resp) return 'missing';

  // Active hydration in flight.
  if (resp.currentStatus === 'pending' || resp.currentStatus === 'running') {
    return 'running';
  }

  // Hilo not configured or not available.
  if (resp.actionHint === 'configure_hilo') return 'disabled';

  // No hydration attempted yet.
  if (!resp.latest) return 'missing';

  // Latest hydration failed.
  if (resp.latest.status === 'failed') return 'failed';

  // Latest cancelled.
  if (resp.latest.status === 'cancelled') return 'failed';

  // Freshness check.
  if (resp.freshness === 'stale' || resp.freshness === 'dirty') return 'stale';

  // Clean and succeeded.
  return 'ready';
}

// ─── Presentation helpers ───────────────────────────────────────────────────

const STATE_CONFIG: Record<ContextHealthState, { label: string; colorClass: string; dotClass: string; icon: typeof CheckCircle }> = {
  ready:    { label: 'Ready',    colorClass: 'text-emerald-500', dotClass: 'bg-emerald-500',              icon: CheckCircle },
  stale:    { label: 'Stale',    colorClass: 'text-amber-500',  dotClass: 'bg-amber-500',               icon: Clock },
  running:  { label: 'Running',  colorClass: 'text-accent',     dotClass: 'bg-[var(--accent)]',         icon: Loader2 },
  failed:   { label: 'Failed',   colorClass: 'text-rose-400',   dotClass: 'bg-rose-400',                 icon: XCircle },
  disabled: { label: 'No Hilo',  colorClass: 'text-muted',      dotClass: 'bg-[var(--text-muted)]',      icon: AlertTriangle },
  missing:  { label: 'No data',  colorClass: 'text-muted',      dotClass: 'bg-[var(--text-muted)]',      icon: AlertTriangle },
};

const FRESHNESS_LABELS: Record<FreshnessStatus, string> = {
  clean:   'Current',
  stale:   'Out of date',
  dirty:   'Uncommitted changes',
  unknown: 'Unknown',
  missing: 'No data',
};

function formatDurationMs(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatRelativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function ContextHealthPanel() {
  const { workspaceId } = useWorkspace();

  const [data, setData] = useState<HydrationStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggerState, setTriggerState] = useState<'idle' | 'queuing' | 'running' | 'done' | 'error'>('idle');
  const [triggerMessage, setTriggerMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // US-038: Diagnostics state
  const [diag, setDiag] = useState<DiagnosticsStatus | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);

  // ── Fetch Diagnostics ────────────────────────────────────────────────────
  const fetchDiagnostics = useCallback(async () => {
    if (!workspaceId) return;
    setDiagLoading(true);
    try {
      const params = new URLSearchParams({ workspaceId });
      const resp = await apiFetch<DiagnosticsStatus>(`/api/diagnostics/status?${params}`, { silent: true });
      setDiag(resp);
    } catch {
      // Non-fatal — diagnostics just won't show
      setDiag(null);
    } finally {
      setDiagLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (workspaceId) fetchDiagnostics();
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    if (!workspaceId) {
      setData(null);
      setLoading(false);
      return;
    }
    // Don't flash loading when polling while hydrated.
    if (!data) setLoading(true);
    try {
      const resp = await apiFetch<HydrationStatusResponse>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/hydration`,
        { silent: true },
      );
      setData(resp);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to fetch hydration status');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, data]);

  useEffect(() => {
    fetchStatus();
  }, [workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while a hydration is running.
  useEffect(() => {
    if (data?.currentStatus === 'pending' || data?.currentStatus === 'running') {
      if (!pollRef.current) {
        pollRef.current = setInterval(fetchStatus, 3000);
      }
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [data?.currentStatus, fetchStatus]);

  // ── Trigger hydration ─────────────────────────────────────────────────────
  const handleTrigger = useCallback(async () => {
    if (!workspaceId) return;
    setTriggerState('queuing');
    setTriggerMessage(null);
    try {
      const resp = await apiFetch<{
        hydrationId: number;
        status: string;
        idempotent: boolean;
        message: string;
      }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/hydration`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ types: ['hilo'] }),
        },
      );
      setTriggerState('running');
      setTriggerMessage(resp.message);
      // Re-fetch to start polling.
      await fetchStatus();
    } catch (err: any) {
      setTriggerState('error');
      setTriggerMessage(err?.message ?? 'Hydration trigger failed');
      // Clear error feedback after 4 seconds.
      setTimeout(() => {
        setTriggerState('idle');
        setTriggerMessage(null);
      }, 4000);
    }
  }, [workspaceId, fetchStatus]);

  // Clear trigger done state when hydration finishes.
  useEffect(() => {
    if (
      triggerState === 'running' &&
      data?.currentStatus !== 'pending' &&
      data?.currentStatus !== 'running'
    ) {
      setTriggerState(data?.currentStatus === 'succeeded' ? 'done' : 'error');
      setTriggerMessage(
        data?.currentStatus === 'succeeded'
          ? 'Hydration completed successfully.'
          : data?.currentStatus === 'failed'
            ? 'Hydration failed. Check the error details below.'
            : null,
      );
      // Clear after 6 seconds.
      const t = setTimeout(() => {
        setTriggerState('idle');
        setTriggerMessage(null);
      }, 6000);
      return () => clearTimeout(t);
    }
  }, [data?.currentStatus, triggerState]);

  // ── Derived state ─────────────────────────────────────────────────────────
  const state = classifyState(data, loading);
  const config = STATE_CONFIG[state];
  const isRunning = state === 'running';

  // ── Empty workspace ───────────────────────────────────────────────────────
  if (!workspaceId) {
    return (
      <div className="bg-panel border border-border rounded-lg p-4">
        <div className="flex items-center justify-center py-6 text-sm text-muted">
          Select a workspace to view context health.
        </div>
      </div>
    );
  }

  // ── Loading skeleton ──────────────────────────────────────────────────────
  if (loading && !data) {
    return (
      <div className="bg-panel border border-border rounded-lg p-4" data-testid="context-health-loading">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-4 h-4 rounded bg-border animate-pulse" />
          <div className="h-4 bg-border rounded animate-pulse w-32" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-3 bg-border rounded animate-pulse w-full" />
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────
  if (error && !data) {
    return (
      <div className="bg-panel border border-border rounded-lg p-4" data-testid="context-health-error">
        <div className="flex items-start gap-2 text-sm text-rose-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Could not load hydration status</p>
            <p className="text-xs text-rose-400/80 mt-0.5">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-panel border border-border rounded-lg p-4" data-testid="context-health-panel">
      {/* ─── Header with state pill ──────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          data-testid="context-health-expand-toggle"
        >
          <Network size={16} className="text-accent" />
          <h2 className="text-sm font-semibold">Context Health</h2>
          <ChevronDown
            size={14}
            className={`text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        </button>

        <div className="flex items-center gap-2">
          {/* State badge */}
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-semibold rounded border ${
              state === 'ready'
                ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30'
                : state === 'stale'
                  ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                  : state === 'running'
                    ? 'bg-[var(--accent)]/10 text-[var(--accent)] border-[var(--accent)]/30'
                    : state === 'failed'
                      ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                      : 'bg-[var(--text-muted)]/10 text-[var(--text-muted)] border-[var(--text-muted)]/30'
            }`}
            data-testid="context-health-state-badge"
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${config.dotClass}`} />
            {config.label}
          </span>

          {/* Trigger button */}
          {state !== 'disabled' && (
            <button
              type="button"
              onClick={handleTrigger}
              disabled={isRunning || triggerState === 'queuing'}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
                isRunning || triggerState === 'queuing'
                  ? 'bg-border/50 text-muted cursor-not-allowed'
                  : 'bg-[var(--accent)]/10 text-[var(--accent)] hover:bg-[var(--accent)]/20'
              }`}
              data-testid="context-health-trigger"
            >
              {isRunning || triggerState === 'queuing' ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
              {isRunning ? 'Hydrating…' : state === 'missing' || state === 'stale' ? 'Hydrate' : 'Re-hydrate'}
            </button>
          )}
        </div>
      </div>

      {/* ─── Trigger feedback banner ─────────────────────────────────────── */}
      {triggerState !== 'idle' && triggerMessage && (
        <div
          className={`mb-3 flex items-start gap-2 p-2.5 rounded border text-xs ${
            triggerState === 'running' || triggerState === 'queuing'
              ? 'bg-[var(--accent)]/5 border-[var(--accent)]/20 text-[var(--accent)]'
              : triggerState === 'done'
                ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-500'
                : 'bg-rose-500/5 border-rose-500/20 text-rose-400'
          }`}
          data-testid="context-health-trigger-feedback"
        >
          {(triggerState === 'running' || triggerState === 'queuing') && (
            <Loader2 size={12} className="animate-spin mt-0.5 shrink-0" />
          )}
          {triggerState === 'done' && <CheckCircle size={12} className="mt-0.5 shrink-0" />}
          {triggerState === 'error' && <AlertTriangle size={12} className="mt-0.5 shrink-0" />}
          <span>{triggerMessage}</span>
        </div>
      )}

      {/* ─── Quick summary row (always visible) ──────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
        {/* Provider */}
        <span className="flex items-center gap-1 text-muted">
          <span className="text-[10px] uppercase tracking-wider">Provider</span>
          <span className="font-mono font-medium text-[var(--text)]">
            {data?.provider ?? 'hilo'}
          </span>
        </span>

        {/* Freshness */}
        <span className="flex items-center gap-1 text-muted">
          <span className="text-[10px] uppercase tracking-wider">Freshness</span>
          <span
            className={`font-medium ${
              data?.freshness === 'clean' ? 'text-emerald-500' : data?.freshness === 'stale' || data?.freshness === 'dirty' ? 'text-amber-500' : 'text-muted'
            }`}
          >
            {data ? FRESHNESS_LABELS[data.freshness] : '—'}
          </span>
        </span>

        {/* Last hydration age */}
        {data?.latest?.finishedAt && (
          <span className="flex items-center gap-1 text-muted">
            <span className="text-[10px] uppercase tracking-wider">Last run</span>
            <span className="font-medium text-[var(--text)]">
              {formatRelativeTime(data.latest.finishedAt)}
            </span>
          </span>
        )}

        {/* Duration */}
        {data?.latest?.durationMs != null && (
          <span className="flex items-center gap-1 text-muted">
            <span className="text-[10px] uppercase tracking-wider">Duration</span>
            <span className="font-mono font-medium text-[var(--text)]">
              {formatDurationMs(data.latest.durationMs)}
            </span>
          </span>
        )}
      </div>

      {/* ─── Expanded detail ─────────────────────────────────────────────── */}
      {expanded && data && (
        <div className="mt-3 pt-3 border-t border-border space-y-3" data-testid="context-health-detail">
          {/* Stale reason */}
          {data.freshness !== 'clean' && data.freshnessDetails.humanSummary && (
            <div className="flex items-start gap-2 p-2.5 rounded border border-amber-500/20 bg-amber-500/5 text-xs text-amber-500">
              <Clock size={13} className="mt-0.5 shrink-0" />
              <span>{data.freshnessDetails.humanSummary}</span>
            </div>
          )}

          {/* SHA comparison */}
          {data.freshnessDetails.gitRepo && (
            <div className="flex items-center gap-3 text-xs text-muted">
              <GitBranch size={13} />
              <span>
                HEAD:{' '}
                <code className="font-mono text-[var(--text)]">
                  {shortSha(data.freshnessDetails.currentHead) ?? '?'}
                </code>
              </span>
              <ArrowRightLeft size={12} />
              <span>
                Hydrated:{' '}
                <code className="font-mono text-[var(--text)]">
                  {shortSha(data.freshnessDetails.hydratedSha) ?? 'none'}
                </code>
              </span>
            </div>
          )}

          {/* Error details */}
          {data.errors.hasErrors && data.errors.latestError && (
            <div className="p-2.5 rounded border border-rose-500/20 bg-rose-500/5 text-xs space-y-1" data-testid="context-health-errors">
              <div className="flex items-center gap-2 text-rose-400 font-medium">
                <XCircle size={13} />
                <span>Latest Error</span>
                {data.errors.latestErrorStatus && (
                  <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-[10px] font-mono">
                    {data.errors.latestErrorStatus}
                  </span>
                )}
              </div>
              <pre className="text-rose-400/80 whitespace-pre-wrap break-words font-mono text-[11px] max-h-32 overflow-y-auto">
                {typeof data.errors.latestError === 'string'
                  ? data.errors.latestError
                  : JSON.stringify(data.errors.latestError, null, 2)}
              </pre>
            </div>
          )}

          {/* Graph counts (from latest succeeded hydration) */}
          {data.counts && Object.keys(data.counts).length > 0 && (
            <div data-testid="context-health-counts">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-2">
                Graph Counts
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {data.counts.nodes != null && (
                  <CountBadge icon={Hash} label="Nodes" value={data.counts.nodes} />
                )}
                {data.counts.edges != null && (
                  <CountBadge icon={ArrowRightLeft} label="Edges" value={data.counts.edges} />
                )}
                {data.counts.files != null && (
                  <CountBadge icon={FileCode} label="Files" value={data.counts.files} />
                )}
                {data.counts.imports != null && (
                  <CountBadge icon={Brackets} label="Imports" value={data.counts.imports} />
                )}
                {data.counts.reverseImporters != null && (
                  <CountBadge icon={Brackets} label="Rev Importers" value={data.counts.reverseImporters} />
                )}
                {data.counts.tests != null && (
                  <CountBadge icon={TestTube} label="Tests" value={data.counts.tests} />
                )}
                {data.counts.testedBy != null && (
                  <CountBadge icon={TestTube} label="Tested By" value={data.counts.testedBy} />
                )}
                {data.counts.roles != null && (
                  <CountBadge icon={Zap} label="Roles" value={data.counts.roles} />
                )}
              </div>
            </div>
          )}

          {/* No counts — missing graph */}
          {data.latest && data.latest.status === 'succeeded' && (!data.counts || Object.keys(data.counts).length === 0) && (
            <p className="text-xs text-muted">Hydration succeeded but no graph counts were recorded.</p>
          )}

          {/* Disabled/missing: show action hint */}
          {state === 'disabled' && (
            <div className="flex items-start gap-2 p-2.5 rounded border border-border bg-[var(--surface-200)] text-xs text-muted">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                {data.actionMessage ?? 'Hilo is not available for this workspace. Configure and enable Hilo to hydrate the codegraph.'}
              </span>
            </div>
          )}

          {/* Missing: no hydration yet but Hilo available */}
          {state === 'missing' && (
            <div className="flex items-start gap-2 p-2.5 rounded border border-border bg-[var(--surface-200)] text-xs text-muted">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>No hydration has been attempted. Click Hydrate to build the codegraph.</span>
            </div>
          )}

          {/* ─── US-038: Operator Diagnostics Warnings ─────────────────── */}
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              Diagnostics
            </p>

            {/* Candidate backlog */}
            {diag?.candidates && diag.candidates.hasBacklog && (
              <div
                className="flex items-start gap-2 p-2.5 rounded border border-rose-500/20 bg-rose-500/5 text-xs text-rose-400"
                data-testid="context-health-candidate-backlog"
              >
                <Inbox size={13} className="mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Candidate Backlog</span>
                  <p className="mt-0.5 text-rose-400/80">
                    {diag.candidates.backlogWarning ?? `${diag.candidates.pendingCount} pending candidates need review`}
                  </p>
                  <p className="mt-1 text-rose-400/60">
                    {diag.candidates.approvedCount} approved, {diag.candidates.totalCandidates} total
                  </p>
                </div>
              </div>
            )}

            {/* Candidate info (no backlog) */}
            {diag?.candidates && !diag.candidates.hasBacklog && diag.candidates.totalCandidates > 0 && (
              <div className="flex items-center gap-2 p-2 rounded border border-border bg-[var(--surface-200)] text-xs text-muted">
                <Inbox size={12} className="shrink-0" />
                <span>
                  <span className="font-medium text-[var(--text)]">
                    {diag.candidates.pendingCount} pending
                  </span>
                  {' · '}{diag.candidates.approvedCount} approved · {diag.candidates.totalCandidates} total candidates
                </span>
              </div>
            )}

            {/* Stale graph warning */}
            {diag?.graph && diag.graph.isStale && (
              <div
                className="flex items-start gap-2 p-2.5 rounded border border-amber-500/20 bg-amber-500/5 text-xs text-amber-500"
                data-testid="context-health-stale-graph"
              >
                <HardDrive size={13} className="mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Stale Knowledge Graph</span>
                  <p className="mt-0.5 text-amber-500/80">
                    {diag.graph.staleReason ?? 'Graph data is out of date'}
                  </p>
                  <p className="mt-1 text-amber-500/60">
                    {diag.graph.vertexCount} vertices, {diag.graph.edgeCount} edges
                  </p>
                </div>
              </div>
            )}

            {/* Missing Hilo / graph unavailable */}
            {diag?.graph && !diag.graph.available && (
              <div
                className="flex items-start gap-2 p-2.5 rounded border border-amber-500/20 bg-amber-500/5 text-xs text-amber-500"
                data-testid="context-health-missing-hilo"
              >
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <div>
                  <span className="font-medium">Hilo Graph Unavailable</span>
                  <p className="mt-0.5 text-amber-500/80">
                    Install Apache AGE or enable graph lite mode for knowledge graph features.
                  </p>
                </div>
              </div>
            )}

            {/* Other operator warnings */}
            {diag?.warnings
              ?.filter(w => w.category !== 'graph' && w.category !== 'candidate')
              .map((warning, idx) => (
                <div
                  key={idx}
                  className={`flex items-start gap-2 p-2.5 rounded border text-xs ${
                    warning.severity === 'error'
                      ? 'border-rose-500/20 bg-rose-500/5 text-rose-400'
                      : warning.severity === 'warning'
                        ? 'border-amber-500/20 bg-amber-500/5 text-amber-500'
                        : 'border-border bg-[var(--surface-200)] text-muted'
                  }`}
                  data-testid={`context-health-warning-${warning.category}`}
                >
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <div>
                    <span className="font-medium">{warning.message}</span>
                    {warning.detail && (
                      <p className="mt-0.5 opacity-80">{warning.detail}</p>
                    )}
                  </div>
                </div>
              ))}

            {/* No diagnostics warnings / loading state */}
            {diagLoading && !diag && (
              <div className="flex items-center gap-2 text-xs text-muted p-2">
                <Loader2 size={12} className="animate-spin" />
                Loading diagnostics…
              </div>
            )}

            {/* All clear */}
            {diag && (diag.warnings?.length ?? 0) === 0 && (
              <div className="flex items-center gap-2 p-2 rounded border border-emerald-500/20 bg-emerald-500/5 text-xs text-emerald-500">
                <CheckCircle size={12} className="shrink-0" />
                <span>All diagnostics clear — no warnings or issues detected.</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function CountBadge({ icon: Icon, label, value }: { icon: typeof Hash; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 p-2 rounded border border-border bg-[var(--surface-200)] text-xs">
      <Icon size={12} className="text-muted shrink-0" />
      <span className="text-muted truncate">{label}</span>
      <span className="ml-auto font-mono font-semibold text-[var(--text)] tabular-nums">
        {value.toLocaleString()}
      </span>
    </div>
  );
}
