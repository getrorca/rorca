import { useState, useEffect, useCallback } from 'react';
import { Play, Clock, ListChecks, ChevronRight } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
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

// ─── Active Run Section ─────────────────────────────────────────────────────

function ActiveRunCard({ run, storyResults, onNavigate }: {
  run: PipelineRun;
  storyResults: StoryResult[];
  onNavigate: (panel: PanelId) => void;
}) {
  const passed = storyResults.filter((s) => s.status === 'pass').length;
  const failed = storyResults.filter((s) => s.status === 'fail').length;
  const total = storyResults.length;

  return (
    <button
      onClick={() => onNavigate('pipeline')}
      className="w-full text-left p-4 bg-panel border border-border rounded-lg hover:border-accent/50 transition-colors group"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${STATUS_DOTS[run.status] || 'bg-gray-500'}`} />
          <span className="text-sm font-semibold text-[var(--text)] capitalize">{run.status}</span>
        </div>
        <ChevronRight size={16} className="text-muted group-hover:text-accent transition-colors" />
      </div>
      <p className="text-sm text-[var(--text)] truncate capitalize mb-1">
        {specLabel(run.spec_path)}
      </p>
      <div className="flex items-center gap-3 text-xs text-muted">
        <span>Started {relativeTime(run.started_at)}</span>
        {total > 0 && (
          <span className="font-mono tabular-nums">
            {passed}/{total} passed{failed > 0 ? ` · ${failed} failed` : ''}
          </span>
        )}
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
  const [activeRunStories, setActiveRunStories] = useState<StoryResult[]>([]);
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
    const active = runs.find((r) => r.status === 'running') ?? null;
    setActiveRun(active);
    setPendingSpecs(specsRes.items);
    // Recent = completed runs (not running), most recent first
    setRecentRuns(runs.filter((r) => r.status !== 'running').slice(0, 10));

    // Fetch story results for active run
    if (active) {
      try {
        const detail = await apiFetch<{ storyResults: StoryResult[] }>(
          `/api/pipeline/runs/${active.id}`,
        );
        setActiveRunStories(detail.storyResults ?? []);
      } catch {
        setActiveRunStories([]);
      }
    } else {
      setActiveRunStories([]);
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
              storyResults={activeRunStories}
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
