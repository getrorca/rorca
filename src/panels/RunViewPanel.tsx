import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Terminal as TerminalIcon, List, GitBranch, ArrowLeftRight, FolderGit2, GitCommitHorizontal, RefreshCw, Loader2, Pause, Play, Square, Send, AlertTriangle, Layers, DollarSign, Smartphone, XCircle, ExternalLink, RotateCcw, X } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { useIsMobile } from '../hooks/useIsMobile';
import { apiFetch } from '../lib/apiFetch';
import { pauseRun, resumeRun, cancelRun, injectContext, retryRun } from '../api/pipeline';
import RunTerminal from '../components/RunTerminal';
import type { RunTerminalHandle } from '../components/RunTerminal';
import MultiPaneTerminal from '../components/MultiPaneTerminal';

import SplitPane from '../components/SplitPane';
import RunStoryList from '../components/RunStoryList';
import RunMetadataPanel from '../components/RunMetadataPanel';
import InteractiveDependencyGraph from '../components/InteractiveDependencyGraph';
import type { DerivedStatus } from '../components/InteractiveDependencyGraph';
import CompareRunsPanel from './CompareRunsPanel';
import WorktreesPanel from './WorktreesPanel';
import FinOpsTab from '../components/FinOpsTab';
import type { PanelId } from '../components/Sidebar';
import { RunViewTerminalSkeleton } from '../components/Skeleton';
import AppHeader from '../components/AppHeader';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'blocked' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
  pid: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  started_at: string;
  finished_at: string | null;
  parallelism?: number;
  agentType?: string;
  agentModel?: string | null;
}

interface StoryResultSeed {
  story_id: string;
  status: string; // 'pass' | 'fail' | 'skip' from DB
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
}

interface RunApiResponse {
  run: PipelineRun;
  stories: StoryResultSeed[];
  specStories: { id: string; title: string }[];
  specModel?: string | null;
  agentType?: string;
  agentModel?: string | null;
  tokenSummary?: { inputTokens: number; outputTokens: number };
}

interface CommitEntry {
  sha: string;
  message: string;
  date: string;
  author: string;
}

type RunViewTab = 'terminal' | 'stories' | 'graph' | 'finops' | 'compare' | 'worktrees' | 'commits';

const TABS: { id: RunViewTab; label: string; icon: typeof TerminalIcon }[] = [
  { id: 'terminal', label: 'Terminal', icon: TerminalIcon },
  { id: 'stories', label: 'Stories', icon: List },
  { id: 'graph', label: 'Graph', icon: GitBranch },
  { id: 'finops', label: 'FinOps', icon: DollarSign },
  { id: 'compare', label: 'Compare', icon: ArrowLeftRight },
  { id: 'worktrees', label: 'Worktrees', icon: FolderGit2 },
  { id: 'commits', label: 'Commits', icon: GitCommitHorizontal },
];

const VALID_TABS = new Set<string>(TABS.map((t) => t.id));

function getTabFromHash(): RunViewTab {
  const hash = window.location.hash.replace('#', '');
  return VALID_TABS.has(hash) ? (hash as RunViewTab) : 'terminal';
}

// ─── Status styling ─────────────────────────────────────────────────────────

const STATUS_BADGE_STYLES: Record<string, string> = {
  running: 'bg-blue-500/10 text-blue-500',
  paused: 'bg-yellow-500/10 text-yellow-500',
  blocked: 'bg-amber-500/10 text-amber-500',
  done: 'bg-emerald-500/10 text-emerald-500',
  failed: 'bg-red-500/10 text-red-500',
  partial_failure: 'bg-orange-500/10 text-orange-500',
  cancelled: 'bg-gray-500/10 text-gray-400',
};

const STATUS_BADGE_LABELS: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  blocked: 'Blocked',
  done: 'Passed',
  failed: '\u2717 Failed',
  partial_failure: 'Partial',
  cancelled: 'Cancelled',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function specLabel(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '').replace(/-/g, ' ');
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

/** Extract spec slug from spec_path like "forge/specs/approved/my-spec.json" → "my-spec" */
function extractSpecId(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '');
}

/** Extract story ID from commit message patterns like feat(US-001): or test(US-003): */
function extractStoryId(message: string): string | null {
  const match = message.match(/(?:feat|fix|test|chore|refactor|journey)\(([A-Z]+-\d+)\)/i);
  return match ? match[1].toUpperCase() : null;
}

// ─── Tab content placeholders ───────────────────────────────────────────────

function TabPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-muted text-sm">
      {label} tab — coming in a future story
    </div>
  );
}

// ─── Commits Tab ────────────────────────────────────────────────────────────

function CommitsTab({ runId }: { runId: number }) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [branchName, setBranchName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCommits = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ commits: CommitEntry[]; branchName: string | null }>(
        `/api/pipeline/runs/${runId}/commits`,
      );
      setCommits(data.commits);
      setBranchName(data.branchName);
    } catch (err: any) {
      setError(err.message || 'Failed to load commits');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    fetchCommits();
  }, [fetchCommits]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm gap-2">
        <Loader2 size={16} className="animate-spin" />
        Loading commits...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <span className="text-sm text-red-400">{error}</span>
        <button
          onClick={fetchCommits}
          className="text-xs text-accent hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with branch name + refresh */}
      <div className="shrink-0 px-4 py-2.5 border-b border-border bg-panel flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-muted">
          <GitBranch size={13} />
          <span className="font-mono">{branchName || 'default branch'}</span>
          <span className="text-[var(--text-muted)]">
            {commits.length} commit{commits.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={fetchCommits}
          className="p-1 rounded hover:bg-bg transition-colors text-muted hover:text-[var(--text)]"
          title="Refresh commits"
          aria-label="Refresh commits"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {/* Commit list or empty state */}
      {commits.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted">
          <GitCommitHorizontal size={32} className="opacity-30" />
          <span className="text-sm">No commits yet</span>
          <span className="text-xs opacity-70">
            Commits will appear here as stories complete.
          </span>
          <button
            onClick={fetchCommits}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-border hover:bg-panel transition-colors"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {commits.map((commit) => {
            const storyId = extractStoryId(commit.message);
            return (
              <div
                key={commit.sha}
                className="px-4 py-2.5 border-b border-border hover:bg-panel/50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  {/* SHA */}
                  <code className="text-xs font-mono text-accent shrink-0 mt-0.5">
                    {commit.sha.slice(0, 7)}
                  </code>

                  {/* Message + meta */}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[var(--text)] leading-snug">
                      {truncate(commit.message, 72)}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[10px] text-muted">{commit.author}</span>
                      <span className="text-[10px] text-muted">{relativeTime(commit.date)}</span>
                    </div>
                  </div>

                  {/* Story ID badge */}
                  {storyId && (
                    <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-mono font-semibold rounded bg-blue-500/10 text-blue-400">
                      {storyId}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Kill Confirmation Dialog ────────────────────────────────────────────────

function KillConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-panel border border-border rounded-lg shadow-xl p-5 max-w-sm w-full mx-4">
        <div className="flex items-center gap-2 mb-3">
          <Square size={16} className="text-red-400" />
          <h3 className="text-sm font-semibold text-[var(--text)]">Kill this run?</h3>
        </div>
        <p className="text-sm text-muted mb-5">This cannot be undone.</p>
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium rounded border border-border text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            Kill
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── RunViewPanel ───────────────────────────────────────────────────────────

interface RunViewPanelProps {
  runId: number;
  onBack: () => void;
  onNavigate: (panel: PanelId) => void;
}

export default function RunViewPanel({ runId, onBack, onNavigate }: RunViewPanelProps) {
  const { workspaceId } = useWorkspace();
  const isMobile = useIsMobile();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<RunViewTab>(getTabFromHash);
  const terminalRef = useRef<RunTerminalHandle>(null);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [hitlContext, setHitlContext] = useState('');
  const [hitlSending, setHitlSending] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);

  const [specModel, setSpecModel] = useState<string | null>(null);
  const [tokenSummary, setTokenSummary] = useState({ inputTokens: 0, outputTokens: 0 });
  const [totalStories, setTotalStories] = useState(0);
  // Seed from story_results on initial load so graph colors are correct for in-progress/historical runs
  const [seedStatuses, setSeedStatuses] = useState<Map<string, DerivedStatus>>(new Map());

  // Filter tabs for mobile — hide Graph (too complex for small screens)
  const visibleTabs = useMemo(() => {
    if (isMobile) return TABS.filter((t) => t.id !== 'graph');
    return TABS;
  }, [isMobile]);

  // Sync tab selection to URL hash
  const handleTabChange = useCallback((tab: RunViewTab) => {
    setActiveTab(tab);
    window.location.hash = tab;
  }, []);

  // Listen for hash changes (back/forward navigation)
  useEffect(() => {
    const onHashChange = () => {
      const tab = getTabFromHash();
      setActiveTab(tab);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // SSE for live status updates
  const walEvents = usePipelineSSE(String(runId));

  // Derive effective status from SSE events
  const effectiveStatus = useMemo(() => {
    if (!run) return 'running';
    let status = run.status;
    for (const evt of walEvents) {
      if (evt.event_type === 'run_finished') status = 'done';
      else if (evt.event_type === 'run_failed') status = 'failed';
      else if (evt.event_type === 'run_paused') status = 'paused';
      else if (evt.event_type === 'run_blocked') status = 'blocked';
      else if (evt.event_type === 'run_resumed') status = 'running';
      else if (evt.event_type === 'run_cancelled') status = 'cancelled';
    }
    return status;
  }, [run, walEvents]);

  // Derive per-story live statuses: seed from DB results, then overlay live SSE events
  const liveStatuses = useMemo(() => {
    // Start with DB-seeded statuses (covers stories that ran before we subscribed to SSE)
    const map = new Map<string, DerivedStatus>(seedStatuses);
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      const id = evt.story_id;
      if (evt.event_type === 'story_started') {
        map.set(id, { storyId: id, status: 'running', startedAt: evt.ts, elapsed: '' });
      } else if (evt.event_type === 'story_passed') {
        const prev = map.get(id);
        const elapsed = prev?.startedAt
          ? `${Math.round((new Date(evt.ts).getTime() - new Date(prev.startedAt).getTime()) / 1000)}s`
          : '';
        map.set(id, { storyId: id, status: 'passed', startedAt: prev?.startedAt ?? null, elapsed });
      } else if (evt.event_type === 'story_failed') {
        const prev = map.get(id);
        const elapsed = prev?.startedAt
          ? `${Math.round((new Date(evt.ts).getTime() - new Date(prev.startedAt).getTime()) / 1000)}s`
          : '';
        map.set(id, { storyId: id, status: 'failed', startedAt: prev?.startedAt ?? null, elapsed });
      } else if (evt.event_type === 'story_skipped') {
        map.set(id, { storyId: id, status: 'skipped', startedAt: null, elapsed: '' });
      }
    }
    return map;
  }, [walEvents, seedStatuses]);

  const fetchRun = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<RunApiResponse>(`/api/pipeline/runs/${runId}`);
      setRun(data.run);
      if (data.specModel !== undefined) setSpecModel(data.specModel);
      if (data.tokenSummary) setTokenSummary(data.tokenSummary);
      if (data.specStories) setTotalStories(data.specStories.length);
      // Seed graph colors from DB story results so nodes aren't all grey on load
      if (data.stories?.length) {
        const seed = new Map<string, DerivedStatus>();
        const DB_STATUS: Record<string, DerivedStatus['status']> = {
          pass: 'passed', fail: 'failed', skip: 'skipped',
        };
        for (const s of data.stories) {
          const status = DB_STATUS[s.status] ?? 'running';
          const elapsed = s.elapsed_seconds != null ? `${s.elapsed_seconds}s` : '';
          seed.set(s.story_id, { storyId: s.story_id, status, startedAt: s.started_at, elapsed });
        }
        setSeedStatuses(seed);
      }
    } catch {
      // run not found
    }
    setLoading(false);
  }, [runId, workspaceId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  const isActive = effectiveStatus === 'running' || effectiveStatus === 'paused' || effectiveStatus === 'blocked';

  // Detect if we should show multi-pane terminal (parallelism > 1 with 2+ concurrent stories)
  const useMultiPane = useMemo(() => {
    if (!run || (run.parallelism ?? 1) <= 1) return false;
    // Count stories that have started but not finished
    const started = new Set<string>();
    const finished = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started') started.add(evt.story_id);
      if (evt.event_type === 'story_passed' || evt.event_type === 'story_failed' || evt.event_type === 'story_skipped') {
        finished.add(evt.story_id);
      }
    }
    // Check if at any point 2+ stories were concurrently running
    // (once we detect multi-pane mode, we stay in it for the duration of the run)
    return started.size >= 2;
  }, [run, walEvents]);

  const handlePauseResume = useCallback(async () => {
    if (!isActive) return;
    setPauseLoading(true);
    try {
      if (effectiveStatus === 'paused') {
        await resumeRun(runId);
      } else {
        await pauseRun(runId);
      }
      await fetchRun();
    } catch (err) {
      console.error('[RunView] Pause/Resume failed:', err);
    } finally {
      setPauseLoading(false);
    }
  }, [runId, effectiveStatus, isActive, fetchRun]);

  const handleKill = useCallback(async () => {
    setShowKillConfirm(false);
    setKillLoading(true);
    try {
      await cancelRun(runId);
      await fetchRun();
    } catch (err) {
      console.error('[RunView] Kill failed:', err);
    } finally {
      setKillLoading(false);
    }
  }, [runId, fetchRun]);

  const handleSendContext = useCallback(async () => {
    if (!hitlContext.trim()) return;
    setHitlSending(true);
    try {
      await injectContext(runId, hitlContext.trim());
      setHitlContext('');
      await fetchRun();
    } catch (err) {
      console.error('[RunView] Context injection failed:', err);
    } finally {
      setHitlSending(false);
    }
  }, [runId, hitlContext, fetchRun]);

  // Derive failed story IDs from WAL events
  const failedStoryIds = useMemo(() => {
    const failed = new Set<string>();
    const passed = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_failed') {
        failed.add(evt.story_id);
        passed.delete(evt.story_id);
      } else if (evt.event_type === 'story_passed') {
        passed.add(evt.story_id);
        failed.delete(evt.story_id);
      }
    }
    return failed;
  }, [walEvents]);

  const failedStoryCount = failedStoryIds.size;

  const handleRetryFailed = useCallback(async () => {
    if (failedStoryCount === 0) return;
    setRetryLoading(true);
    try {
      const result = await retryRun(runId, {
        storyIds: [...failedStoryIds],
        workspaceId: workspaceId ?? undefined,
      });
      // Navigate to the new retry run
      if (result.runId) {
        window.location.hash = 'terminal';
        window.location.reload();
      }
    } catch (err) {
      console.error('[RunView] Retry failed:', err);
    } finally {
      setRetryLoading(false);
    }
  }, [runId, failedStoryIds, failedStoryCount, workspaceId]);

  const handleViewErrorDetail = useCallback(() => {
    // Switch to terminal tab and scroll to the last failed story
    handleTabChange('terminal');
    // Find last failed story ID from WAL events
    let lastFailedId: string | null = null;
    for (const evt of walEvents) {
      if (evt.event_type === 'story_failed' && evt.story_id) {
        lastFailedId = evt.story_id;
      }
    }
    if (lastFailedId && terminalRef.current) {
      setTimeout(() => terminalRef.current?.scrollToStory(lastFailedId!), 100);
    }
  }, [walEvents, handleTabChange]);

  if (loading) {
    return <RunViewTerminalSkeleton />;
  }

  if (!run) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <span className="text-sm text-muted">Run #{runId} not found</span>
        <button
          onClick={onBack}
          className="text-sm text-accent hover:underline"
        >
          Back to Hub
        </button>
      </div>
    );
  }

  const renderTabContent = () => {
    switch (activeTab) {
      case 'terminal':
        return (
          <SplitPane
            left={
              useMultiPane
                ? <MultiPaneTerminal runId={run.id} walEvents={walEvents} />
                : <RunTerminal ref={terminalRef} runId={run.id} />
            }
            right={
              <div className="h-full flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <RunStoryList
                    runId={run.id}
                    walEvents={walEvents}
                    onStoryClick={useMultiPane ? undefined : (storyId) => terminalRef.current?.scrollToStory(storyId)}
                    parallelism={run.parallelism}
                  />
                </div>
                <RunMetadataPanel
                  run={run}
                  tokenSummary={tokenSummary}
                  specModel={specModel}
                  totalStories={totalStories}
                  walEvents={walEvents}
                  onKill={() => setShowKillConfirm(true)}
                />
              </div>
            }
          />
        );
      case 'stories':
        return <TabPlaceholder label="Stories" />;
      case 'graph':
        if (isMobile) {
          return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <Smartphone size={32} className="text-muted opacity-40" />
              <span className="text-sm font-medium text-muted">Graph view unavailable on mobile</span>
              <span className="text-xs text-muted/70">
                The dependency graph requires a larger screen to display interactive node connections. Open Rorca on a desktop browser to use this view.
              </span>
              <button
                onClick={() => handleTabChange('terminal')}
                className="mt-2 px-3 py-1.5 text-xs font-medium rounded border border-border text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
              >
                Switch to Terminal
              </button>
            </div>
          );
        }
        return (
          <InteractiveDependencyGraph
            specId={extractSpecId(run.spec_path)}
            workspaceId={run.workspace_id}
            runId={run.id}
            liveStatuses={liveStatuses}
          />
        );
      case 'finops':
        return <FinOpsTab runId={run.id} />;
      case 'compare':
        return <CompareRunsPanel onBack={() => handleTabChange('terminal')} />;
      case 'worktrees':
        return <WorktreesPanel />;
      case 'commits':
        return <CommitsTab runId={run.id} />;
      default:
        return null;
    }
  };

  return (
    <div className="h-full flex flex-col">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-1.5 md:gap-2 min-w-0">
            <h1 className="text-xs md:text-sm font-semibold text-[var(--text)] truncate capitalize">
              {specLabel(run.spec_path)}
            </h1>
            <span className="text-[10px] md:text-xs text-muted font-mono shrink-0">#{run.id}</span>
            <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 ${STATUS_BADGE_STYLES[effectiveStatus] || 'bg-gray-500/10 text-gray-400'}`} aria-live="polite">
              {STATUS_BADGE_LABELS[effectiveStatus] || effectiveStatus}
            </span>
            {run.parallelism != null && run.parallelism > 1 && !isMobile && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 bg-purple-500/10 text-purple-500">
                <Layers size={10} />
                Parallelism: {run.parallelism}
              </span>
            )}
            {/* Agent badge */}
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 ${run.agentType === 'opencode' ? 'bg-cyan-500/10 text-cyan-500' : 'bg-orange-500/10 text-orange-500'
              }`}>
              {run.agentType === 'opencode'
                ? run.agentModel?.split('/').pop() || 'OpenCode'
                : 'Claude'}
            </span>
          </div>
        }
        actions={
          <div className="flex items-center gap-1 md:gap-1.5 shrink-0 justify-end flex-wrap pb-1 pt-1 pr-2">
            {/* Pause / Resume */}
            <button
              onClick={handlePauseResume}
              disabled={!isActive || pauseLoading}
              title={effectiveStatus === 'paused' ? 'Resume run' : 'Pause run'}
              aria-label={effectiveStatus === 'paused' ? 'Resume run' : 'Pause run'}
              className={`p-1.5 rounded-lg transition-colors min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center ${isActive && !pauseLoading
                ? 'hover:bg-bg text-muted hover:text-[var(--text)]'
                : 'text-muted/30 cursor-not-allowed'
                }`}
            >
              {pauseLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : effectiveStatus === 'paused' ? (
                <Play size={16} />
              ) : (
                <Pause size={16} />
              )}
            </button>

            {/* Kill */}
            <button
              onClick={() => setShowKillConfirm(true)}
              disabled={!isActive || killLoading}
              title="Kill run"
              aria-label="Kill run"
              className={`p-1.5 rounded-lg transition-colors min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center ${isActive && !killLoading
                ? 'hover:bg-red-500/10 text-muted hover:text-red-400'
                : 'text-muted/30 cursor-not-allowed'
                }`}
            >
              {killLoading ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Square size={16} />
              )}
            </button>
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={onBack}
              className="p-1.5 rounded-lg hover:bg-bg transition-colors text-muted hover:text-[var(--text)] min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center"
              title="Close details"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        }
      />

      {/* Kill confirmation dialog */}
      {showKillConfirm && (
        <KillConfirmDialog
          onConfirm={handleKill}
          onCancel={() => setShowKillConfirm(false)}
        />
      )}

      {/* Tab bar — scrollable horizontal strip on mobile */}
      <div className="shrink-0 px-2 md:px-4 border-b border-border bg-panel flex items-center gap-0.5 overflow-x-auto scrollbar-none [-webkit-overflow-scrolling:touch]">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActiveTab = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              aria-current={isActiveTab ? 'page' : undefined}
              className={`flex items-center gap-1.5 px-3 py-2.5 md:py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 ${isActiveTab
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-[var(--text)]'
                }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* HITL blocked banner */}
      {effectiveStatus === 'blocked' && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10" role="alert" aria-live="assertive">
          <div className="px-4 py-2.5 flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber-500 shrink-0" />
            <span className="text-sm font-medium text-amber-500">
              Run paused — agent is waiting for input
            </span>
          </div>
          <div className="px-4 pb-3 flex gap-2">
            <textarea
              value={hitlContext}
              onChange={(e) => setHitlContext(e.target.value)}
              placeholder="Type instructions or context for the agent..."
              aria-label="Instructions or context for the agent"
              className="flex-1 min-h-[60px] max-h-[120px] px-3 py-2 text-sm rounded-lg border border-amber-500/30 bg-bg text-[var(--text)] placeholder:text-muted resize-y focus:outline-none focus:ring-1 focus:ring-amber-500/50"
              disabled={hitlSending}
            />
            <button
              onClick={handleSendContext}
              disabled={!hitlContext.trim() || hitlSending}
              title="Send context and resume"
              aria-label="Send context and resume"
              className={`self-end px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-colors ${hitlContext.trim() && !hitlSending
                ? 'bg-amber-500 text-white hover:bg-amber-600'
                : 'bg-amber-500/20 text-amber-500/40 cursor-not-allowed'
                }`}
            >
              {hitlSending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              Send
            </button>
          </div>
        </div>
      )}

      {/* Run failed banner */}
      {(effectiveStatus === 'failed' || effectiveStatus === 'partial_failure') && failedStoryCount > 0 && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10" role="alert" aria-live="assertive">
          <div className="px-3 md:px-4 py-2.5 md:py-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <XCircle size={18} className="text-red-500 shrink-0" />
              <span className="text-xs md:text-sm font-medium text-red-400">
                Run failed — {failedStoryCount} {failedStoryCount === 1 ? 'story' : 'stories'} did not complete
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleViewErrorDetail}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <ExternalLink size={12} />
                View error detail
              </button>
              <button
                onClick={handleRetryFailed}
                disabled={retryLoading}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${retryLoading
                  ? 'bg-red-500/20 text-red-500/40 cursor-not-allowed'
                  : 'bg-red-500 text-white hover:bg-red-600'
                  }`}
              >
                {retryLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                Retry failed stories
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab content — fills remaining space */}
      {renderTabContent()}
    </div>
  );
}
