import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ArrowLeft, Terminal as TerminalIcon, List, GitBranch, ArrowLeftRight, FolderGit2, GitCommitHorizontal } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { apiFetch } from '../lib/apiFetch';
import RunTerminal from '../components/RunTerminal';
import type { RunTerminalHandle } from '../components/RunTerminal';
import SplitPane from '../components/SplitPane';
import RunStoryList from '../components/RunStoryList';
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

type RunViewTab = 'terminal' | 'stories' | 'graph' | 'compare' | 'worktrees' | 'commits';

const TABS: { id: RunViewTab; label: string; icon: typeof TerminalIcon }[] = [
  { id: 'terminal',  label: 'Terminal',  icon: TerminalIcon },
  { id: 'stories',   label: 'Stories',   icon: List },
  { id: 'graph',     label: 'Graph',     icon: GitBranch },
  { id: 'compare',   label: 'Compare',   icon: ArrowLeftRight },
  { id: 'worktrees', label: 'Worktrees', icon: FolderGit2 },
  { id: 'commits',   label: 'Commits',   icon: GitCommitHorizontal },
];

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

// ─── Tab content placeholders ───────────────────────────────────────────────

function TabPlaceholder({ label }: { label: string }) {
  return (
    <div className="flex-1 flex items-center justify-center text-muted text-sm">
      {label} tab — coming in a future story
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
  const [activeTab, setActiveTab] = useState<RunViewTab>('terminal');
  const terminalRef = useRef<RunTerminalHandle>(null);

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
      const data = await apiFetch<PipelineRun>(`/api/pipeline/runs/${runId}`);
      setRun(data);
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
        return <TabPlaceholder label="Compare" />;
      case 'worktrees':
        return <TabPlaceholder label="Worktrees" />;
      case 'commits':
        return <TabPlaceholder label="Commits" />;
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
              onClick={() => setActiveTab(tab.id)}
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
