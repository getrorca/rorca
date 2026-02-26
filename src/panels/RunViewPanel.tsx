import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Terminal as TerminalIcon, List, GitBranch, ArrowLeftRight, FolderGit2, GitCommitHorizontal, RefreshCw, Loader2 } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { apiFetch } from '../lib/apiFetch';
import RunTerminal from '../components/RunTerminal';
import type { RunTerminalHandle } from '../components/RunTerminal';
import SplitPane from '../components/SplitPane';
import RunStoryList from '../components/RunStoryList';
import CompareRunsPanel from './CompareRunsPanel';
import WorktreesPanel from './WorktreesPanel';
import type { PanelId } from '../components/Sidebar';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
  pid: number | null;
  branch_name: string | null;
  worktree_path: string | null;
  started_at: string;
  finished_at: string | null;
}

interface RunApiResponse {
  run: PipelineRun;
  stories: unknown[];
  specStories: unknown[];
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
      else if (evt.event_type === 'run_resumed') status = 'running';
      else if (evt.event_type === 'run_cancelled') status = 'cancelled';
    }
    return status;
  }, [run, walEvents]);

  const fetchRun = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<RunApiResponse>(`/api/pipeline/runs/${runId}`);
      setRun(data.run);
    } catch {
      // run not found
    }
    setLoading(false);
  }, [runId, workspaceId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

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
              <RunStoryList
                runId={run.id}
                walEvents={walEvents}
                onStoryClick={(storyId) => terminalRef.current?.scrollToStory(storyId)}
              />
            }
          />
        );
      case 'stories':
        return <TabPlaceholder label="Stories" />;
      case 'graph':
        return <TabPlaceholder label="Graph" />;
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
      </div>

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

      {/* Tab content — fills remaining space */}
      {renderTabContent()}
    </div>
  );
}
