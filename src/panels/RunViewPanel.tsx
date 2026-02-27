import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Terminal as TerminalIcon, List, GitBranch, ArrowLeftRight, FolderGit2, GitCommitHorizontal, RefreshCw, Loader2, Pause, Play, Square, Send, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { apiFetch } from '../lib/apiFetch';
import { pauseRun, resumeRun, cancelRun, injectContext } from '../api/pipeline';
import RunTerminal from '../components/RunTerminal';
import type { RunTerminalHandle } from '../components/RunTerminal';
import SplitPane from '../components/SplitPane';
import RunStoryList from '../components/RunStoryList';
import RunMetadataPanel from '../components/RunMetadataPanel';
import InteractiveDependencyGraph from '../components/InteractiveDependencyGraph';
import type { DerivedStatus } from '../components/InteractiveDependencyGraph';
import CompareRunsPanel from './CompareRunsPanel';
import WorktreesPanel from './WorktreesPanel';
import type { PanelId } from '../components/Sidebar';

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
}

interface RunApiResponse {
  run: PipelineRun;
  stories: unknown[];
  specStories: { id: string; title: string }[];
  specModel?: string | null;
  tokenSummary?: { inputTokens: number; outputTokens: number };
}

interface CommitEntry {
  sha: string;
  message: string;
  date: string;
  author: string;
}

type RunViewTab = 'terminal' | 'stories' | 'graph' | 'compare' | 'worktrees' | 'commits';

const TABS: { id: RunViewTab; label: string; icon: typeof TerminalIcon }[] = [
  { id: 'terminal',  label: 'Terminal',  icon: TerminalIcon },
  { id: 'stories',   label: 'Stories',   icon: List },
  { id: 'graph',     label: 'Graph',     icon: GitBranch },
  { id: 'compare',   label: 'Compare',   icon: ArrowLeftRight },
  { id: 'worktrees', label: 'Worktrees', icon: FolderGit2 },
  { id: 'commits',   label: 'Commits',   icon: GitCommitHorizontal },
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
  failed: 'Failed',
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
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<RunViewTab>(getTabFromHash);
  const terminalRef = useRef<RunTerminalHandle>(null);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [hitlContext, setHitlContext] = useState('');
  const [hitlSending, setHitlSending] = useState(false);
  const [specModel, setSpecModel] = useState<string | null>(null);
  const [tokenSummary, setTokenSummary] = useState({ inputTokens: 0, outputTokens: 0 });
  const [totalStories, setTotalStories] = useState(0);

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

  // Derive per-story live statuses from SSE events for the graph
  const liveStatuses = useMemo(() => {
    const map = new Map<string, DerivedStatus>();
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
  }, [walEvents]);

  const fetchRun = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<RunApiResponse>(`/api/pipeline/runs/${runId}`);
      setRun(data.run);
      if (data.specModel !== undefined) setSpecModel(data.specModel);
      if (data.tokenSummary) setTokenSummary(data.tokenSummary);
      if (data.specStories) setTotalStories(data.specStories.length);
    } catch {
      // run not found
    }
    setLoading(false);
  }, [runId, workspaceId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  const isActive = effectiveStatus === 'running' || effectiveStatus === 'paused' || effectiveStatus === 'blocked';

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

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <span className="text-sm text-muted">Loading run #{runId}...</span>
      </div>
    );
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
            left={<RunTerminal ref={terminalRef} runId={run.id} />}
            right={
              <div className="h-full flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <RunStoryList
                    runId={run.id}
                    walEvents={walEvents}
                    onStoryClick={(storyId) => terminalRef.current?.scrollToStory(storyId)}
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
        return (
          <InteractiveDependencyGraph
            specId={extractSpecId(run.spec_path)}
            workspaceId={run.workspace_id}
            runId={run.id}
            liveStatuses={liveStatuses}
          />
        );
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
      {/* Header bar */}
      <div className="shrink-0 px-4 py-3 border-b border-border bg-panel flex items-center gap-3">
        <button
          onClick={onBack}
          className="p-1.5 rounded-lg hover:bg-bg transition-colors text-muted hover:text-[var(--text)]"
          title="Back to Hub"
        >
          <ArrowLeft size={18} />
        </button>

        <div className="flex items-center gap-2 min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-[var(--text)] truncate capitalize">
            {specLabel(run.spec_path)}
          </h1>
          <span className="text-xs text-muted font-mono shrink-0">#{run.id}</span>
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 ${STATUS_BADGE_STYLES[effectiveStatus] || 'bg-gray-500/10 text-gray-400'}`}>
            {STATUS_BADGE_LABELS[effectiveStatus] || effectiveStatus}
          </span>
        </div>

        {/* Pipeline controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Pause / Resume */}
          <button
            onClick={handlePauseResume}
            disabled={!isActive || pauseLoading}
            title={effectiveStatus === 'paused' ? 'Resume run' : 'Pause run'}
            className={`p-1.5 rounded-lg transition-colors ${
              isActive && !pauseLoading
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
            className={`p-1.5 rounded-lg transition-colors ${
              isActive && !killLoading
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
        </div>
      </div>

      {/* Kill confirmation dialog */}
      {showKillConfirm && (
        <KillConfirmDialog
          onConfirm={handleKill}
          onCancel={() => setShowKillConfirm(false)}
        />
      )}

      {/* Tab bar */}
      <div className="shrink-0 px-4 border-b border-border bg-panel flex items-center gap-0.5 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
                isActive
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
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10">
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
              className="flex-1 min-h-[60px] max-h-[120px] px-3 py-2 text-sm rounded-lg border border-amber-500/30 bg-bg text-[var(--text)] placeholder:text-muted resize-y focus:outline-none focus:ring-1 focus:ring-amber-500/50"
              disabled={hitlSending}
            />
            <button
              onClick={handleSendContext}
              disabled={!hitlContext.trim() || hitlSending}
              title="Send context and resume"
              className={`self-end px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-colors ${
                hitlContext.trim() && !hitlSending
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

      {/* Tab content — fills remaining space */}
      {renderTabContent()}
    </div>
  );
}
