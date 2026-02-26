import { useState, useEffect, useCallback, useMemo } from 'react';
import { Play, Clock, ListChecks, ChevronRight, Pause, Square } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
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

// ─── Section Header ─────────────────────────────────────────────────────────

function SectionHeader({ icon: Icon, label }: { icon: typeof Play; label: string }) {
  return (
    <h2 className="flex items-center gap-2 text-sm font-bold text-[var(--text)] mb-3">
      <Icon size={16} className="text-muted" />
      {label}
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

function PendingReviewCard({ spec, onNavigate }: {
  spec: SpecSummary;
  onNavigate: (panel: PanelId) => void;
}) {
  return (
    <button
      onClick={() => onNavigate('queue')}
      className="w-full text-left p-3 bg-panel border border-border rounded-lg hover:border-accent/50 transition-colors group"
    >
      <div className="flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[var(--text)] truncate">{spec.specName}</p>
          <div className="flex items-center gap-2 text-xs text-muted mt-0.5">
            <span>{spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}</span>
            <span>·</span>
            <span>{relativeTime(spec.generatedAt)}</span>
          </div>
        </div>
        <ChevronRight size={16} className="text-muted group-hover:text-accent transition-colors shrink-0" />
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
      className="w-full text-left px-3 py-2.5 hover:bg-bg rounded-lg transition-colors group"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOTS[run.status] || 'bg-gray-500'}`} />
          <span className="text-sm text-[var(--text)] truncate capitalize">
            {specLabel(run.spec_path)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs capitalize ${STATUS_COLORS[run.status] || 'text-muted'}`}>
            {run.status === 'partial_failure' ? 'partial' : run.status}
          </span>
          <span className="text-xs text-muted">
            {relativeTime(run.finished_at || run.started_at)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ─── HubPanel ───────────────────────────────────────────────────────────────

export default function HubPanel({ onNavigate }: { onNavigate: (panel: PanelId) => void }) {
  const { workspaceId } = useWorkspace();
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

  if (isEmpty) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
        <div className="w-12 h-12 rounded-full bg-accent/10 flex items-center justify-center">
          <Play size={20} className="text-accent" />
        </div>
        <p className="text-sm text-muted">No activity yet. Create a spec to get started.</p>
        <button
          onClick={() => onNavigate('forge')}
          className="text-sm text-accent hover:underline"
        >
          Go to Forge
        </button>
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
            <SectionHeader icon={ListChecks} label="Pending Reviews" />
            <div className="space-y-2">
              {pendingSpecs.map((spec) => (
                <PendingReviewCard key={spec.id} spec={spec} onNavigate={onNavigate} />
              ))}
            </div>
          </section>
        )}

        {/* Recent Runs */}
        {hasRecent && (
          <section>
            <SectionHeader icon={Clock} label="Recent Runs" />
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
