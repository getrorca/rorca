/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// @refresh reset
import { useState, useEffect, useCallback, useRef } from 'react';
import { Terminal, Clock, ChevronRight, List, XCircle, ArrowRight, AlertTriangle, X, GitBranch, ArrowUpDown, Filter, Layers, ArrowDownUp } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { usePipelineRuns, type PipelineRun } from '../hooks/usePipelineRuns';
import { useWalSSE } from '../hooks/useWalSSE';
import { useGlobalToast } from '../contexts/ToastContext';
import { apiFetch } from '../lib/apiFetch';
import RunQueueSection, { QueueEntry } from '../components/RunQueueSection';
import SpecPickerModal from '../components/SpecPickerModal';
import AgentBadge from '../components/AgentBadge';
import AppHeader from '../components/AppHeader';
import EmptyState from '../components/EmptyState';
import { useAppNavigate } from '../routes';

// ─── Types ───────────────────────────────────────────────────────────────────

// PipelineRun type imported from usePipelineRuns hook

interface WorkerHealthData {
  workerActive: boolean;
  queueHealth: 'healthy' | 'degraded' | 'critical';
  queueStats: {
    pending: number;
    active: number;
    failed: number;
    failedInLast24h: number;
    oldestPendingAgeSeconds: number | null;
  };
}

type BannerSeverity = 'critical' | 'degraded';

interface BannerInfo {
  severity: BannerSeverity;
  message: string;
}

function computeBanner(health: WorkerHealthData | null): BannerInfo | null {
  if (!health) return null;
  const { queueHealth, queueStats } = health;
  const { active, failed, failedInLast24h, oldestPendingAgeSeconds } = queueStats;

  // Priority 1: critical
  if (queueHealth === 'critical') {
    const count = failed + failedInLast24h;
    return {
      severity: 'critical',
      message: `${count} job${count !== 1 ? 's' : ''} failed in the queue. Go to Analytics > Queue Health for details.`,
    };
  }

  // Priority 2: worker stuck (pending too long, no active workers)
  if ((oldestPendingAgeSeconds ?? 0) > 30 && active === 0) {
    const pending = queueStats.pending;
    return {
      severity: 'degraded',
      message: `Worker appears stuck — ${pending} job${pending !== 1 ? 's' : ''} ${pending === 1 ? 'has' : 'have'} been queued for ${oldestPendingAgeSeconds}s. Check that the worker is running.`,
    };
  }

  // Priority 3: degraded + slow
  if (queueHealth === 'degraded' && (oldestPendingAgeSeconds ?? 0) > 120) {
    return {
      severity: 'degraded',
      message: `Jobs are processing slowly (oldest pending: ${oldestPendingAgeSeconds}s). Worker may be overloaded.`,
    };
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_DOTS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  partial_failure: 'bg-orange-500',
  paused: 'bg-yellow-500',
  cancelled: 'bg-gray-500',
  queued: 'bg-amber-500',
};

const STATUS_LABELS: Record<string, string> = {
  running: 'Running',
  done: 'Passed',
  failed: 'Failed',
  partial_failure: 'Partial Failure',
  paused: 'Paused',
  cancelled: 'Cancelled',
  queued: 'Queued',
};

function specName(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '').replace(/-/g, ' ');
}

function parseUtc(ts: string): Date {
  return new Date(ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z');
}

function elapsedTime(startedAt: string, finishedAt: string | null): string {
  if (!startedAt) return '';
  try {
    const start = parseUtc(startedAt);
    if (finishedAt) {
      const end = parseUtc(finishedAt);
      const ms = end.getTime() - start.getTime();
      if (ms < 1000) return `${ms}ms`;
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return `${m}m ${s % 60}s`;
    }
    return formatDistanceToNow(start, { includeSeconds: true });
  } catch {
    return '';
  }
}

// ─── Sort / Filter types ─────────────────────────────────────────────────────

type SortField = 'id' | 'status' | 'triggered_via';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'running' | 'queued' | 'done' | 'failed' | 'cancelled';
type OriginFilter = 'all' | 'queue' | 'run_now';

function sortRuns(runs: PipelineRun[], field: SortField, dir: SortDir): PipelineRun[] {
  return [...runs].sort((a, b) => {
    let cmp = 0;
    if (field === 'id') {
      cmp = a.id - b.id;
    } else if (field === 'status') {
      cmp = (a.status || '').localeCompare(b.status || '');
    } else if (field === 'triggered_via') {
      cmp = (a.triggered_via || 'run_now').localeCompare(b.triggered_via || 'run_now');
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ─── Inline badges ───────────────────────────────────────────────────────────

function TriggeredViaBadge({ value }: { value?: 'queue' | 'run_now' }) {
  if (value === 'queue') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded bg-amber-500/15 text-amber-400 border border-amber-500/25 shrink-0">
        <Clock className="w-2.5 h-2.5" />
        Queue
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded bg-blue-500/15 text-blue-400 border border-blue-500/25 shrink-0">
      Run Now
    </span>
  );
}

function WorktreeBadge({ branchName }: { branchName?: string | null }) {
  if (!branchName) return null;
  // Show shortened branch name (last segment after last /)
  const short = branchName.includes('/') ? branchName.split('/').pop()! : branchName;
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded bg-purple-500/15 text-purple-400 border border-purple-500/25 shrink-0 max-w-[140px]"
      title={branchName}
    >
      <GitBranch className="w-2.5 h-2.5 shrink-0" />
      <span className="truncate">{short}</span>
    </span>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

interface PipelineMonitorPanelProps {
  onNavigateToRun?: (runId: number) => void;
}

export default function PipelineMonitorPanel({ onNavigateToRun }: PipelineMonitorPanelProps) {
  const { workspaceId } = useWorkspace();
  const navigateTo = useAppNavigate();
  const navigate = useNavigate();
  const { runs, refetch: refetchRuns } = usePipelineRuns(workspaceId, 10_000);
  const [_showStartHelp, _setShowStartHelp] = useState(false);
  const [_copied, setCopied] = useState(false);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [specPickerOpen, setSpecPickerOpen] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<number | null>(null);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthData | null>(null);
  const [bannerDismissedAt, setBannerDismissedAt] = useState<number | null>(null);
  const [sortField, setSortField] = useState<SortField>('id');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');

  const { show: showGlobalToast } = useGlobalToast();

  // Lifecycle is backend-owned; select active work from that persisted phase,
  // never from terminal output or browser-side WAL ordering.
  const activeRun = runs.find((run) => ['starting', 'pty_attached', 'running', 'validating'].includes(run.lifecycleStatus ?? run.lifecyclePhase ?? ''));
  const sseEvents = usePipelineSSE(activeRun ? String(activeRun.id) : null, workspaceId);

  // Derive story progress from SSE for the active run
  const storyProgress = (() => {
    if (!activeRun) return { passed: 0, failed: 0, total: 0 };
    const passed = new Set<string>();
    const failed = new Set<string>();
    const all = new Set<string>();
    for (const e of sseEvents) {
      if (!e.story_id) continue;
      all.add(e.story_id);
      if (e.event_type === 'story_passed') { passed.add(e.story_id); failed.delete(e.story_id); }
      if (e.event_type === 'story_failed') { failed.add(e.story_id); passed.delete(e.story_id); }
    }
    return { passed: passed.size, failed: failed.size, total: all.size };
  })();

  // WAL still refreshes the canonical API row but cannot author a lifecycle.
  const activeRunStatus = activeRun?.lifecycleStatus ?? activeRun?.lifecyclePhase ?? null;

  // Re-fetch runs via shared hook when SSE delivers lifecycle events
  useEffect(() => {
    const lifecycle = sseEvents.filter(e =>
      e.event_type === 'run_finished' || e.event_type === 'run_cancelled'
    );
    if (lifecycle.length > 0) refetchRuns();
  }, [sseEvents, refetchRuns]);

  // ─── Queue data ────────────────────────────────────────────────
  const fetchQueue = useCallback(() => {
    if (!workspaceId) return;
    apiFetch<{ items: QueueEntry[] }>(`/api/run-queue?workspaceId=${workspaceId}`)
      .then((data) => setQueueEntries(data.items))
      .catch(() => setQueueEntries([]));
  }, [workspaceId]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  useEffect(() => {
    const queueEvents = sseEvents.filter(
      (e) => e.event_type === 'run_queued_trigger' || e.event_type === 'run_finished'
    );
    if (queueEvents.length > 0) fetchQueue();
  }, [sseEvents, fetchQueue]);

  // ─── Worker health polling ──────────────────────────────────────
  const fetchWorkerHealth = useCallback(() => {
    apiFetch<WorkerHealthData>('/api/pipeline/worker/health')
      .then(setWorkerHealth)
      .catch(() => {/* silent — banner just won't show */});
  }, []);

  useEffect(() => { fetchWorkerHealth(); }, [fetchWorkerHealth]);

  useEffect(() => {
    const interval = setInterval(fetchWorkerHealth, 30_000);
    return () => clearInterval(interval);
  }, [fetchWorkerHealth]);

  // Global WAL SSE — handle run_queued_promoted
  const fetchRunsRef = useRef(refetchRuns);
  fetchRunsRef.current = refetchRuns;
  const fetchQueueRef = useRef(fetchQueue);
  fetchQueueRef.current = fetchQueue;
  const fetchWorkerHealthRef = useRef(fetchWorkerHealth);
  fetchWorkerHealthRef.current = fetchWorkerHealth;
  const showGlobalToastRef = useRef(showGlobalToast);
  showGlobalToastRef.current = showGlobalToast;

  useWalSSE((event) => {
    if (event.event_type === 'run_queued_promoted') {
      const payload = event.payload ? JSON.parse(event.payload) : {};
      const label = payload.spec_name
        ? String(payload.spec_name).replace(/-/g, ' ')
        : payload.spec_id
          ? String(payload.spec_id).replace(/-/g, ' ')
          : 'queued run';
      showGlobalToastRef.current(`Queued run started — ${label}`, 'success');
      fetchRunsRef.current();
      fetchQueueRef.current();
    }
    if (event.event_type === 'queue_failed_jobs_detected') {
      fetchWorkerHealthRef.current();
    }
  });

  const handleSpecPicked = useCallback(async (spec: { id: string; specName: string }) => {
    if (!workspaceId) return;
    setSpecPickerOpen(false);
    try {
      await apiFetch('/api/run-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: Number(workspaceId),
          specId: spec.id,
          specPath: `forge/specs/approved/${spec.id}.json`,
          parallelism: 1,
          autoWorktree: false,
        }),
      });
      fetchQueue();
    } catch (err) {
      console.error('[RunQueue] Add failed:', err);
    }
  }, [workspaceId, fetchQueue]);

  const _handleCopyCommand = () => {
    const cmd = `./forge/run-loop.sh --json forge/specs/approved/<spec>.json`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRunClick = (runId: number) => {
    if (onNavigateToRun) {
      onNavigateToRun(runId);
    }
  };

  // ─── Partition runs ─────────────────────────────────────────────
  const activeRuns = runs.filter(r => r.status === 'running' || r.status === 'paused');
  const queuedRuns = runs.filter(r => r.status === 'queued');
  const completedRuns = runs.filter(r =>
    r.status !== 'running' && r.status !== 'paused' && r.status !== 'queued'
  );

  // ─── Filtered + sorted completed runs ─────────────────────────
  const filteredCompleted = completedRuns.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (originFilter !== 'all' && (r.triggered_via || 'run_now') !== originFilter) return false;
    return true;
  });
  const sortedCompleted = sortRuns(filteredCompleted, sortField, sortDir);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  // ─── Banner ──────────────────────────────────────────────────────────────
  const banner = computeBanner(workerHealth);
  // Dismiss expires every minute so the banner re-evaluates if condition persists
  const dismissMinute = Math.floor(Date.now() / 60_000);
  const isBannerDismissed =
    banner?.severity !== 'critical' &&
    bannerDismissedAt !== null &&
    bannerDismissedAt === dismissMinute;

  const handleDismissBanner = () => {
    setBannerDismissedAt(dismissMinute);
  };

  const showBanner = banner !== null && !isBannerDismissed;

  // ─── Empty State ─────────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        Select a workspace to view pipeline runs.
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        {/* Queue warning banner — shown even in empty state */}
        {showBanner && banner && (
          <div
            role="alert"
            className="w-full max-w-md mb-4 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300"
          >
            <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
            <p className="flex-1 text-xs leading-snug">{banner.message}</p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => navigate('/analytics')}
                className="hidden sm:inline text-[10px] font-medium underline-offset-2 hover:underline"
              >
                View queue →
              </button>
              {(banner.message.includes('worker') || banner.message.includes('Worker')) && (
                <button
                  onClick={() => navigate('/settings/system')}
                  className="hidden sm:inline text-[10px] font-medium underline-offset-2 hover:underline"
                >
                  Check worker
                </button>
              )}
              {banner.severity !== 'critical' && (
                <button onClick={handleDismissBanner} aria-label="Dismiss banner" className="rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-700/40 transition-colors">
                  <X size={13} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )}
        <EmptyState
          icon={Terminal}
          heading="No pipeline runs yet"
          subtext="Approve a spec from the Board, then click Run. Each story executes as an isolated subprocess with the full tool set."
          action={{ label: 'Go to Specs', onClick: () => navigateTo('specs'), icon: ArrowRight }}
        />

        {/* Queue section in empty state */}
        <div className="w-full max-w-md mt-6 rounded-lg border border-[var(--border)] bg-[var(--surface)]">
          <div className="p-3 flex items-center justify-between border-b border-[var(--border)]">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Queue
              {queueEntries.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--accent)]/15 text-[var(--accent)] font-semibold">
                  {queueEntries.length}
                </span>
              )}
            </span>
          </div>
          <RunQueueSection entries={queueEntries} onRefresh={fetchQueue} onAddClick={() => setSpecPickerOpen(true)} />
        </div>

        {workspaceId && (
          <SpecPickerModal
            workspaceId={workspaceId}
            open={specPickerOpen}
            onClose={() => setSpecPickerOpen(false)}
            onSelect={handleSpecPicked}
          />
        )}
      </div>
    );
  }

  // ─── Main Layout — Queue/History List Only ─────────────────────────────────

  return (
    <div role="main" aria-label="Pipeline monitor - view and manage pipeline runs" className="flex flex-col h-full bg-bg">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">Pipeline</span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-sm text-muted">Queue & Runs</span>
          </div>
        }
      />

      {/* Queue warning banner */}
      {showBanner && banner && (
        <div
          role="alert"
          className="mx-4 mt-3 flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-800 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-300"
        >
          <AlertTriangle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
          <p className="flex-1 text-xs leading-snug">{banner.message}</p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => navigate('/analytics')}
              className="hidden sm:inline text-[10px] font-medium underline-offset-2 hover:underline"
              aria-label="View queue in Analytics"
            >
              View queue →
            </button>
            {banner.message.includes('worker') || banner.message.includes('Worker') ? (
              <button
                onClick={() => navigate('/settings/system')}
                className="hidden sm:inline text-[10px] font-medium underline-offset-2 hover:underline"
                aria-label="Check worker in Settings"
              >
                Check worker
              </button>
            ) : null}
            {banner.severity !== 'critical' && (
              <button
                onClick={handleDismissBanner}
                aria-label="Dismiss banner"
                className="rounded p-0.5 hover:bg-amber-200/60 dark:hover:bg-amber-700/40 transition-colors"
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Active Run Summary Card */}
        {activeRuns.map((run) => {
          const isThisActive = run.id === activeRun?.id;
          const status = isThisActive && activeRunStatus ? activeRunStatus : run.status;
          const completed = isThisActive ? storyProgress.passed + storyProgress.failed : 0;
          const total = isThisActive ? storyProgress.total : 0;
          const progressPct = total > 0 ? Math.round((completed / total) * 100) : 0;

          return (
            <button
              key={run.id}
              onClick={() => handleRunClick(run.id)}
              className="w-full text-left rounded-lg border border-blue-500/30 bg-blue-500/5 hover:bg-blue-500/10 transition-colors p-4"
            >
              <div className="flex items-center gap-3 mb-2">
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${STATUS_DOTS[status] || 'bg-blue-500 animate-pulse'}`} />
                <h3 className="text-sm font-medium capitalize flex-1 truncate">{specName(run.spec_path)}</h3>
                <span className="px-2 py-0.5 text-[10px] font-semibold rounded-full bg-blue-500/20 text-blue-400">
                  {STATUS_LABELS[status] || status}
                </span>
                <AgentBadge agentType={run.agentType} agentModel={run.agentModel} />
                <ChevronRight size={16} className="text-muted shrink-0" />
              </div>

              {/* Progress bar */}
              {total > 0 && (
                <div className="mb-2">
                  <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] mb-1">
                    <span>{storyProgress.passed}/{total} stories passed</span>
                    <span>{progressPct}%</span>
                  </div>
                  <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap text-[10px] text-[var(--text-muted)]">
                <span>Started {formatDistanceToNow(parseUtc(run.started_at), { addSuffix: true })}</span>
                <span>&middot;</span>
                <span>Elapsed: {elapsedTime(run.started_at, null)}</span>
                <TriggeredViaBadge value={run.triggered_via} />
                <WorktreeBadge branchName={run.branch_name} />
                {run.parallelism != null && run.parallelism > 1 ? (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded bg-purple-500/15 text-purple-400 border border-purple-500/25 shrink-0">
                    <Layers className="w-2.5 h-2.5" />
                    Wave ×{run.parallelism}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded bg-zinc-500/15 text-zinc-400 border border-zinc-500/25 shrink-0">
                    <ArrowDownUp className="w-2.5 h-2.5" />
                    Sequential
                  </span>
                )}
              </div>
            </button>
          );
        })}

        {/* Queued Runs */}
        {queuedRuns.length > 0 && (
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)] mb-2 px-1">
              Queued
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-400 font-semibold">
                {queuedRuns.length}
              </span>
            </h3>
            <div className="space-y-1">
              {queuedRuns.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
                >
                  <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium rounded bg-amber-500/20 text-amber-400 border border-amber-500/30 shrink-0">
                    <Clock className="w-2.5 h-2.5" />
                    #{run.queue_position ?? '?'}
                  </span>
                  <span className="text-sm capitalize truncate flex-1">{specName(run.spec_path)}</span>
                  <WorktreeBadge branchName={run.branch_name} />
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      setCancellingRunId(run.id);
                      try {
                        await apiFetch(`/api/pipeline/runs/${run.id}`, { method: 'DELETE' });
                        refetchRuns();
                      } catch (err) {
                        console.error('[Queue] Cancel failed:', err);
                      } finally {
                        setCancellingRunId(null);
                      }
                    }}
                    disabled={cancellingRunId === run.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50 shrink-0"
                  >
                    <XCircle className="w-3 h-3" />
                    {cancellingRunId === run.id ? 'Cancelling...' : 'Cancel'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Run Queue (from queue table) */}
        {(queueEntries.length > 0 || !activeRuns.length) && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <div className="p-3 flex items-center justify-between border-b border-[var(--border)]">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Queue
                {queueEntries.length > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--accent)]/15 text-[var(--accent)] font-semibold">
                    {queueEntries.length}
                  </span>
                )}
              </span>
              <button
                onClick={() => setSpecPickerOpen(true)}
                aria-label="Add to queue"
                className="p-1 rounded hover:bg-[var(--border)] transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
                title="Add to Queue"
              >
                <List className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              </button>
            </div>
            <RunQueueSection entries={queueEntries} onRefresh={fetchQueue} onAddClick={() => setSpecPickerOpen(true)} />
          </div>
        )}

        {/* Recent Completed Runs */}
        {completedRuns.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2 px-1">
              <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Recent Runs
                {filteredCompleted.length !== completedRuns.length && (
                  <span className="ml-1.5 text-[10px] font-normal normal-case">
                    ({filteredCompleted.length} of {completedRuns.length})
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-1.5">
                {/* Status filter */}
                <div className="relative">
                  <select
                    value={statusFilter}
                    onChange={e => setStatusFilter(e.target.value as StatusFilter)}
                    className="appearance-none pl-5 pr-2 py-0.5 text-[10px] rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent/50"
                    aria-label="Filter by status"
                  >
                    <option value="all">All statuses</option>
                    <option value="done">Passed</option>
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                  <Filter size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                </div>
                {/* Origin filter */}
                <div className="relative">
                  <select
                    value={originFilter}
                    onChange={e => setOriginFilter(e.target.value as OriginFilter)}
                    className="appearance-none pl-5 pr-2 py-0.5 text-[10px] rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] cursor-pointer focus:outline-none focus:ring-1 focus:ring-accent/50"
                    aria-label="Filter by origin"
                  >
                    <option value="all">All origins</option>
                    <option value="queue">Queue</option>
                    <option value="run_now">Run Now</option>
                  </select>
                  <Filter size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                </div>
                {/* Sort toggle */}
                <button
                  onClick={() => toggleSort('id')}
                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)] hover:bg-[var(--surface-hover)] transition-colors"
                  title={`Sort by ${sortField} ${sortDir}`}
                  aria-label="Toggle sort order"
                >
                  <ArrowUpDown size={10} />
                  {sortDir === 'desc' ? 'Newest' : 'Oldest'}
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {sortedCompleted.slice(0, 20).map((run) => (
                <button
                  key={run.id}
                  onClick={() => handleRunClick(run.id)}
                  className="w-full text-left flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-hover)] transition-colors p-3"
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOTS[run.status] || 'bg-zinc-500'}`} />
                  <span className="text-sm capitalize truncate flex-1 min-w-0">{specName(run.spec_path)}</span>
                  <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full shrink-0 ${
                    run.status === 'done' ? 'bg-emerald-500/20 text-emerald-400'
                    : run.status === 'failed' || run.status === 'partial_failure' ? 'bg-red-500/20 text-red-400'
                    : 'bg-gray-500/20 text-gray-400'
                  }`}>
                    {STATUS_LABELS[run.status] || run.status}
                  </span>
                  <TriggeredViaBadge value={run.triggered_via} />
                  <WorktreeBadge branchName={run.branch_name} />
                  <AgentBadge agentType={run.agentType} agentModel={run.agentModel} />
                  <span className="text-[10px] text-[var(--text-muted)] shrink-0">
                    {elapsedTime(run.started_at, run.finished_at)}
                  </span>
                  <ChevronRight size={14} className="text-muted shrink-0" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Spec Picker Modal */}
      {workspaceId && (
        <SpecPickerModal
          workspaceId={workspaceId}
          open={specPickerOpen}
          onClose={() => setSpecPickerOpen(false)}
          onSelect={handleSpecPicked}
        />
      )}
    </div>
  );
}
