// @refresh reset
import { useState, useEffect, useCallback, useRef } from 'react';
import { Terminal, Clock, ChevronRight, List, XCircle, ArrowRight, AlertTriangle, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
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

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled' | 'queued';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  retried_from_run_id: number | null;
  agent_type?: string;
  agent_model?: string | null;
  parallelism?: number;
  branch_name?: string | null;
  worktree_path?: string | null;
  queue_position?: number | null;
  queued_at?: string | null;
}

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

// ─── Component ───────────────────────────────────────────────────────────────

interface PipelineMonitorPanelProps {
  onNavigateToRun?: (runId: number) => void;
}

export default function PipelineMonitorPanel({ onNavigateToRun }: PipelineMonitorPanelProps) {
  const { workspaceId } = useWorkspace();
  const navigateTo = useAppNavigate();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [_showStartHelp, _setShowStartHelp] = useState(false);
  const [_copied, setCopied] = useState(false);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [specPickerOpen, setSpecPickerOpen] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<number | null>(null);
  const [workerHealth, setWorkerHealth] = useState<WorkerHealthData | null>(null);
  const [bannerDismissedAt, setBannerDismissedAt] = useState<number | null>(null);

  const { show: showGlobalToast } = useGlobalToast();

  // SSE for live updates on the active run
  const activeRun = runs.find(r => r.status === 'running' || r.status === 'paused');
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

  // Update active run status from SSE lifecycle events
  const activeRunStatus = (() => {
    if (!activeRun) return null;
    let status = activeRun.status;
    for (const e of sseEvents) {
      if (e.event_type === 'run_finished') status = 'done';
      if (e.event_type === 'run_cancelled') status = 'cancelled';
      if (e.event_type === 'run_paused') status = 'paused';
      if (e.event_type === 'run_resumed') status = 'running';
    }
    return status;
  })();

  // Fetch run list
  const fetchRuns = useCallback(() => {
    if (!workspaceId) return;
    apiFetch<{ items: PipelineRun[]; total: number; hasMore: boolean }>(`/api/pipeline/runs?workspaceId=${workspaceId}`)
      .then((data) => setRuns(data.items))
      .catch(console.error);
  }, [workspaceId]);

  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // Poll runs every 15s
  useEffect(() => {
    const interval = setInterval(fetchRuns, 15_000);
    const onOnline = () => fetchRuns();
    window.addEventListener('online', onOnline);
    return () => { clearInterval(interval); window.removeEventListener('online', onOnline); };
  }, [fetchRuns]);

  // Re-fetch runs when SSE delivers lifecycle events
  useEffect(() => {
    const lifecycle = sseEvents.filter(e =>
      e.event_type === 'run_finished' || e.event_type === 'run_cancelled'
    );
    if (lifecycle.length > 0) fetchRuns();
  }, [sseEvents, fetchRuns]);

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
  const fetchRunsRef = useRef(fetchRuns);
  fetchRunsRef.current = fetchRuns;
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
                <AgentBadge agentType={run.agent_type} agentModel={run.agent_model} />
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

              <div className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
                <span>Started {formatDistanceToNow(parseUtc(run.started_at), { addSuffix: true })}</span>
                <span>&middot;</span>
                <span>Elapsed: {elapsedTime(run.started_at, null)}</span>
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
                  <button
                    onClick={async (e) => {
                      e.stopPropagation();
                      setCancellingRunId(run.id);
                      try {
                        await apiFetch(`/api/pipeline/runs/${run.id}`, { method: 'DELETE' });
                        setRuns((prev) => prev.filter((r) => r.id !== run.id));
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
            <h3 className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)] mb-2 px-1">
              Recent Runs
            </h3>
            <div className="space-y-1">
              {completedRuns.slice(0, 20).map((run) => (
                <button
                  key={run.id}
                  onClick={() => handleRunClick(run.id)}
                  className="w-full text-left flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-hover)] transition-colors p-3"
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOTS[run.status] || 'bg-zinc-500'}`} />
                  <span className="text-sm capitalize truncate flex-1">{specName(run.spec_path)}</span>
                  <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full shrink-0 ${
                    run.status === 'done' ? 'bg-emerald-500/20 text-emerald-400'
                    : run.status === 'failed' || run.status === 'partial_failure' ? 'bg-red-500/20 text-red-400'
                    : 'bg-gray-500/20 text-gray-400'
                  }`}>
                    {STATUS_LABELS[run.status] || run.status}
                  </span>
                  <AgentBadge agentType={run.agent_type} agentModel={run.agent_model} />
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
