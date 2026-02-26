import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Play, Clock, ListChecks, ChevronRight, Pause, Square, CheckCircle, XCircle, ArrowRight, FolderGit2, Compass, PenLine, Settings } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
import { apiFetch, BASE_URL } from '../lib/apiFetch';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import type { PanelId } from '../components/Sidebar';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
}

interface SpecSummary {
  id: string;
  specName: string;
  storyCount: number;
  status: 'pending' | 'approved';
  generatedAt: string;
  storyTitles?: string[];
}

interface StoryResult {
  story_id: string;
  status: 'pass' | 'fail' | 'skip' | 'retry';
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseUtc(ts: string): Date {
  return new Date(ts.includes('Z') || ts.includes('+') ? ts : ts + 'Z');
}

function specLabel(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '').replace(/-/g, ' ');
}

function specSlug(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '');
}

function relativeTime(iso: string): string {
  try {
    return formatDistanceToNow(parseUtc(iso), { addSuffix: true });
  } catch {
    return '';
  }
}

const STATUS_COLORS: Record<string, string> = {
  running: 'text-blue-500',
  paused: 'text-yellow-500',
  done: 'text-emerald-500',
  failed: 'text-red-500',
  partial_failure: 'text-orange-500',
  cancelled: 'text-muted',
};

const STATUS_DOTS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  paused: 'bg-yellow-500',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  partial_failure: 'bg-orange-500',
  cancelled: 'bg-gray-500',
};

const STATUS_BADGE_STYLES: Record<string, string> = {
  running: 'bg-blue-500/10 text-blue-500',
  paused: 'bg-yellow-500/10 text-yellow-500',
  done: 'bg-emerald-500/10 text-emerald-500',
  failed: 'bg-red-500/10 text-red-500',
  partial_failure: 'bg-orange-500/10 text-orange-500',
  cancelled: 'bg-gray-500/10 text-gray-400',
};

const STATUS_BADGE_LABELS: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  done: 'Passed',
  failed: 'Failed',
  partial_failure: 'Partial',
  cancelled: 'Cancelled',
};

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const start = parseUtc(startedAt).getTime();
  const end = finishedAt ? parseUtc(finishedAt).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const totalSecs = Math.floor(diffMs / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = parseUtc(iso);
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

// ─── Section Header ─────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, label, badge, noMargin }: { icon: typeof Play; label: string; badge?: number; noMargin?: boolean }) {
  return (
    <h2 className={`flex items-center gap-2 text-sm font-bold text-[var(--text)]${noMargin ? '' : ' mb-3'}`}>
      <Icon size={16} className="text-muted" />
      {label}
      {badge != null && badge > 0 && (
        <span className="ml-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded-full bg-accent text-white">
          {badge}
        </span>
      )}
    </h2>
  );
}

// ─── Border colors by run status ────────────────────────────────────────────

const BORDER_LEFT: Record<string, string> = {
  running: 'border-l-blue-500',
  paused: 'border-l-yellow-500',
  done: 'border-l-emerald-500',
  failed: 'border-l-red-500',
  partial_failure: 'border-l-orange-500',
  cancelled: 'border-l-gray-500',
};

// ─── Active Run Section ─────────────────────────────────────────────────────

function ActiveRunCard({ run, totalStories, onNavigate }: {
  run: PipelineRun;
  totalStories: number;
  onNavigate: (panel: PanelId) => void;
}) {
  const walEvents = usePipelineSSE(String(run.id));
  const [actionLoading, setActionLoading] = useState<'pause' | 'kill' | null>(null);

  // Derive live story progress from SSE events + initial story_results
  const { passed, failed, currentStoryTitle, currentRunStatus } = useMemo(() => {
    let p = 0;
    let f = 0;
    let currentTitle: string | null = null;
    let latestStatus = run.status;

    for (const evt of walEvents) {
      const payload = evt.payload ? JSON.parse(evt.payload) : {};
      if (evt.event_type === 'story_started') {
        currentTitle = payload.story_title || evt.story_id || null;
      } else if (evt.event_type === 'story_passed') {
        p++;
        if (currentTitle === (payload.story_title || evt.story_id)) {
          currentTitle = null;
        }
      } else if (evt.event_type === 'story_failed') {
        f++;
        if (currentTitle === (payload.story_title || evt.story_id)) {
          currentTitle = null;
        }
      } else if (evt.event_type === 'run_finished') {
        latestStatus = 'done';
      } else if (evt.event_type === 'run_failed') {
        latestStatus = 'failed';
      } else if (evt.event_type === 'run_paused') {
        latestStatus = 'paused';
      } else if (evt.event_type === 'run_resumed') {
        latestStatus = 'running';
      } else if (evt.event_type === 'run_cancelled') {
        latestStatus = 'cancelled';
      }
    }
    return {
      passed: p,
      failed: f,
      currentStoryTitle: currentTitle,
      currentRunStatus: latestStatus,
    };
  }, [walEvents, run.status]);

  // Use SSE-derived status if events have come in, otherwise fall back to polled status
  const effectiveStatus = walEvents.length > 0 ? currentRunStatus : run.status;
  const completed = passed + failed;
  const total = totalStories || Math.max(completed, 1);
  const progressPct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const isActive = effectiveStatus === 'running' || effectiveStatus === 'paused';

  const handlePause = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading('pause');
    try {
      if (effectiveStatus === 'paused') {
        await apiFetch(`/api/pipeline/runs/${run.id}/resume`, { method: 'POST' });
      } else {
        await apiFetch(`/api/pipeline/runs/${run.id}/pause`, { method: 'POST' });
      }
    } catch { /* SSE will reflect the change */ }
    setActionLoading(null);
  };

  const handleKill = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setActionLoading('kill');
    try {
      await apiFetch(`/api/pipeline/runs/${run.id}/cancel`, { method: 'POST' });
    } catch { /* SSE will reflect the change */ }
    setActionLoading(null);
  };

  return (
    <button
      onClick={() => onNavigate('pipeline')}
      className={`w-full text-left p-4 bg-panel border border-border border-l-4 ${BORDER_LEFT[effectiveStatus] || 'border-l-gray-500'} rounded-lg hover:border-accent/50 transition-colors group`}
    >
      {/* Header row: status + run ID + actions */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${STATUS_DOTS[effectiveStatus] || 'bg-gray-500'}`} />
          <span className="text-sm font-semibold text-[var(--text)] capitalize">{effectiveStatus}</span>
          <span className="text-xs text-muted font-mono">#{run.id}</span>
        </div>
        <div className="flex items-center gap-1">
          {isActive && (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={handlePause}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePause(e as unknown as React.MouseEvent); }}
                className={`p-1 rounded hover:bg-bg transition-colors ${actionLoading === 'pause' ? 'opacity-50' : ''}`}
                title={effectiveStatus === 'paused' ? 'Resume' : 'Pause'}
              >
                {effectiveStatus === 'paused' ? (
                  <Play size={14} className="text-yellow-500" />
                ) : (
                  <Pause size={14} className="text-yellow-500" />
                )}
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={handleKill}
                onKeyDown={(e) => { if (e.key === 'Enter') handleKill(e as unknown as React.MouseEvent); }}
                className={`p-1 rounded hover:bg-bg transition-colors ${actionLoading === 'kill' ? 'opacity-50' : ''}`}
                title="Kill"
              >
                <Square size={14} className="text-red-500" />
              </span>
            </>
          )}
          <ChevronRight size={16} className="text-muted group-hover:text-accent transition-colors" />
        </div>
      </div>

      {/* Spec name */}
      <p className="text-sm font-medium text-[var(--text)] truncate capitalize mb-1">
        {specLabel(run.spec_path)}
      </p>

      {/* Current story */}
      {currentStoryTitle && (
        <p className="text-xs text-muted truncate mb-2">
          Running: <span className="text-[var(--text)]">{currentStoryTitle}</span>
        </p>
      )}

      {/* Progress bar */}
      <div className="w-full h-1.5 bg-border rounded-full overflow-hidden mb-2">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            effectiveStatus === 'failed' ? 'bg-red-500' :
            effectiveStatus === 'done' ? 'bg-emerald-500' :
            'bg-blue-500'
          }`}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Footer: time + progress counts */}
      <div className="flex items-center justify-between text-xs text-muted">
        <span>Started {relativeTime(run.started_at)}</span>
        <span className="font-mono tabular-nums">
          {passed}/{total} passed{failed > 0 ? ` · ${failed} failed` : ''}
        </span>
      </div>
    </button>
  );
}

// ─── Pending Reviews Section ────────────────────────────────────────────────

function PendingReviewCard({ spec, workspaceId, onNavigate, onAction }: {
  spec: SpecSummary;
  workspaceId: string;
  onNavigate: (panel: PanelId) => void;
  onAction: (specId: string, action: 'approve' | 'reject') => void;
}) {
  const [actionLoading, setActionLoading] = useState<'approve' | 'reject' | null>(null);

  const handleAction = async (e: React.MouseEvent, action: 'approve' | 'reject') => {
    e.stopPropagation();
    setActionLoading(action);
    try {
      await apiFetch(`/api/specs/${spec.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      });
      onAction(spec.id, action);
    } catch {
      // silently fail — next poll will reflect state
    }
    setActionLoading(null);
  };

  return (
    <button
      onClick={() => onNavigate('queue')}
      className="w-full text-left p-4 bg-panel border border-border rounded-lg hover:border-accent/50 transition-colors group flex flex-col gap-2"
    >
      {/* Title + chevron */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-[var(--text)] truncate flex-1">{spec.specName}</p>
        <ChevronRight size={16} className="text-muted group-hover:text-accent transition-colors shrink-0 mt-0.5" />
      </div>

      {/* Meta: story count + timestamp */}
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}</span>
        <span>·</span>
        <span>{relativeTime(spec.generatedAt)}</span>
      </div>

      {/* Story title previews */}
      {spec.storyTitles && spec.storyTitles.length > 0 && (
        <ul className="text-xs text-muted space-y-0.5 pl-2 border-l-2 border-border">
          {spec.storyTitles.map((title, i) => (
            <li key={i} className="truncate">{title}</li>
          ))}
          {spec.storyCount > 2 && (
            <li className="text-muted/60">+{spec.storyCount - 2} more</li>
          )}
        </ul>
      )}

      {/* Approve / Reject actions */}
      <div className="flex items-center gap-2 pt-1">
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => handleAction(e, 'approve')}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAction(e as unknown as React.MouseEvent, 'approve'); }}
          className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors ${actionLoading === 'approve' ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <CheckCircle size={12} />
          Approve
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => handleAction(e, 'reject')}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAction(e as unknown as React.MouseEvent, 'reject'); }}
          className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors ${actionLoading === 'reject' ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <XCircle size={12} />
          Reject
        </span>
      </div>
    </button>
  );
}

// ─── Recent Runs Section ────────────────────────────────────────────────────

function RecentRunRow({ run, onNavigate }: {
  run: PipelineRun;
  onNavigate: (panel: PanelId) => void;
}) {
  return (
    <button
      onClick={() => onNavigate('pipeline')}
      className="w-full text-left px-3 py-2.5 hover:bg-bg transition-colors group"
    >
      <div className="flex items-center justify-between gap-3">
        {/* Left: spec name + run ID */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOTS[run.status] || 'bg-gray-500'}`} />
          <span className="text-sm text-[var(--text)] truncate capitalize">
            {specLabel(run.spec_path)}
          </span>
          <span className="text-[11px] text-muted font-mono shrink-0">#{run.id}</span>
        </div>

        {/* Right: status badge + timestamp + duration */}
        <div className="flex items-center gap-2 shrink-0">
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded ${STATUS_BADGE_STYLES[run.status] || 'bg-gray-500/10 text-gray-400'}`}>
            {STATUS_BADGE_LABELS[run.status] || run.status}
          </span>
          <span className="text-xs text-muted whitespace-nowrap">
            {formatTimestamp(run.started_at)}
          </span>
          <span className="text-xs text-muted font-mono tabular-nums whitespace-nowrap">
            {formatDuration(run.started_at, run.finished_at)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── HubPanel ───────────────────────────────────────────────────────────────

export default function HubPanel({ onNavigate }: { onNavigate: (panel: PanelId) => void }) {
  const { workspaceId, workspaces, addWorkspace } = useWorkspace();
  const [showAddWorkspace, setShowAddWorkspace] = useState(false);
  const [activeRun, setActiveRun] = useState<PipelineRun | null>(null);
  const [totalStories, setTotalStories] = useState(0);
  const [pendingSpecs, setPendingSpecs] = useState<SpecSummary[]>([]);
  const [recentRuns, setRecentRuns] = useState<PipelineRun[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchData = useCallback(async () => {
    if (!workspaceId) return;

    const [runsRes, specsRes] = await Promise.all([
      apiFetch<{ items: PipelineRun[] }>(
        `/api/pipeline/runs?workspaceId=${workspaceId}&limit=20`,
      ).catch(() => ({ items: [] as PipelineRun[] })),
      apiFetch<{ items: SpecSummary[] }>(
        `/api/specs?workspaceId=${workspaceId}&status=pending`,
      ).catch(() => ({ items: [] as SpecSummary[] })),
    ]);

    const runs = runsRes.items;
    const active = runs.find((r) => r.status === 'running' || r.status === 'paused') ?? null;
    setActiveRun(active);
    setPendingSpecs(specsRes.items);
    // Recent = completed runs (not active), most recent first
    setRecentRuns(runs.filter((r) => r.status !== 'running' && r.status !== 'paused').slice(0, 10));

    // Fetch total story count from spec for the active run
    if (active) {
      const slug = specSlug(active.spec_path);
      if (slug) {
        try {
          const spec = await apiFetch<{ userStories?: { id: string }[]; storyCount?: number }>(
            `/api/specs/${slug}?workspaceId=${workspaceId}`,
          );
          setTotalStories(spec.userStories?.length ?? spec.storyCount ?? 0);
        } catch {
          // Fallback: count story_results from run detail
          try {
            const detail = await apiFetch<{ stories: StoryResult[] }>(
              `/api/pipeline/runs/${active.id}`,
            );
            setTotalStories(detail.stories?.length ?? 0);
          } catch {
            setTotalStories(0);
          }
        }
      }
    } else {
      setTotalStories(0);
    }

    setLoaded(true);
  }, [workspaceId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // SSE: re-fetch immediately when a run completes, fails, or is cancelled
  const fetchRef = useRef(fetchData);
  fetchRef.current = fetchData;
  useEffect(() => {
    const es = new EventSource(`${BASE_URL}/api/pipeline/stream`);
    const RUN_TERMINAL_EVENTS = new Set([
      'run_finished', 'run_failed', 'run_cancelled',
      'run_started', 'run_paused', 'run_resumed',
    ]);
    es.addEventListener('wal_event', (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (RUN_TERMINAL_EVENTS.has(evt.event_type)) {
          fetchRef.current();
        }
      } catch { /* ignore malformed events */ }
    });
    return () => es.close();
  }, []);

  // ── Empty state: No workspace registered ──
  if (workspaces.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="flex flex-col items-center text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
            <FolderGit2 size={28} className="text-accent" />
          </div>
          <h2 className="text-lg font-semibold text-[var(--text)] mb-2">Connect your first repository</h2>
          <p className="text-sm text-muted mb-6">
            Rorca turns plain-English briefs into structured specs and ships them autonomously — story by story.
          </p>
          <button
            onClick={() => setShowAddWorkspace(true)}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
          >
            Add Workspace
          </button>
        </div>
        {showAddWorkspace && (
          <AddWorkspaceModal
            onClose={() => setShowAddWorkspace(false)}
            onSuccess={(ws) => {
              addWorkspace(ws);
              setShowAddWorkspace(false);
            }}
          />
        )}
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="text-sm text-muted">Loading...</span>
      </div>
    );
  }

  const hasActiveRun = !!activeRun;
  const hasPending = pendingSpecs.length > 0;
  const hasRecent = recentRuns.length > 0;
  const isEmpty = !hasActiveRun && !hasPending && !hasRecent;

  // ── Empty state: Workspace exists but no specs or runs ──
  if (isEmpty) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="flex flex-col items-center text-center max-w-sm">
          <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-4">
            <Compass size={28} className="text-emerald-500" />
          </div>
          <h2 className="text-lg font-semibold text-[var(--text)] mb-2">Ready to build</h2>
          <p className="text-sm text-muted mb-6">
            Write a brief to generate your first spec, or set direction to guide how stories are written.
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onNavigate('forge')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              <PenLine size={16} />
              Write a brief
            </button>
            <button
              onClick={() => onNavigate('settings')}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-border text-[var(--text)] hover:bg-bg transition-colors"
            >
              <Settings size={16} />
              Set direction
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-8">
        {/* Active Run */}
        {hasActiveRun && (
          <section>
            <SectionHeader icon={Play} label="Active Run" />
            <ActiveRunCard
              run={activeRun}
              totalStories={totalStories}
              onNavigate={onNavigate}
            />
          </section>
        )}

        {/* Pending Reviews */}
        {hasPending && (
          <section>
            <SectionHeader icon={ListChecks} label="Pending Reviews" badge={pendingSpecs.length} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {pendingSpecs.map((spec) => (
                <PendingReviewCard
                  key={spec.id}
                  spec={spec}
                  workspaceId={workspaceId!}
                  onNavigate={onNavigate}
                  onAction={(specId) => {
                    setPendingSpecs((prev) => prev.filter((s) => s.id !== specId));
                  }}
                />
              ))}
            </div>
          </section>
        )}

        {/* Recent Runs */}
        {hasRecent && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <SectionHeader icon={Clock} label="Recent Runs" noMargin />
              <button
                onClick={() => onNavigate('archive')}
                className="flex items-center gap-1 text-xs text-accent hover:underline"
              >
                View all <ArrowRight size={12} />
              </button>
            </div>
            <div className="bg-panel border border-border rounded-lg divide-y divide-border">
              {recentRuns.map((run) => (
                <RecentRunRow key={run.id} run={run} onNavigate={onNavigate} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
