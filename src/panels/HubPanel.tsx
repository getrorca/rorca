import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Play, Clock, ListChecks, ChevronRight, ChevronDown, Pause, Square, CheckCircle, XCircle, ArrowRight, FolderGit2, Compass, PenLine, Settings, Rocket, Loader2, ListPlus, AlertCircle, Search, HeartPulse, RefreshCw, Wand2, FileText, Save, X, Eye } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import AddWorkspaceModal from '../components/AddWorkspaceModal';
// TriggerPopover removed — Ready-to-Run cards now trigger directly
import { ToastContainer, useToast } from '../components/Toast';
import { HubSkeleton } from '../components/Skeleton';
import { apiFetch, BASE_URL } from '../lib/apiFetch';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { useGlobalToast } from '../contexts/ToastContext';
import type { PanelId } from '../components/Sidebar';
import AgentBadge from '../components/AgentBadge';
import AppHeader from '../components/AppHeader';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  agent_type?: string;
  agent_model?: string | null;
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

interface HealthReport {
  stack: { name: string; version?: string; source: string }[];
  missing: string[];
  score: number;
  suggestions: string[];
  monorepo: { detected: boolean; packages: string[] };
  scannedAt: string;
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
  failed: '\u2717 Failed',
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

// ─── Section Footer (Updated timestamp) ─────────────────────────────────────

function UpdatedFooter({ lastUpdated }: { lastUpdated: Date | null }) {
  const [, tick] = useState(0);

  // Re-render every 15s so relative time stays fresh
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  if (!lastUpdated) return null;

  const secsAgo = Math.floor((Date.now() - lastUpdated.getTime()) / 1000);
  const label =
    secsAgo < 10 ? 'Updated just now' :
      secsAgo < 60 ? `Updated ${secsAgo}s ago` :
        `Updated ${Math.floor(secsAgo / 60)}m ago`;

  return (
    <p className="mt-2 text-[11px] text-muted/60 text-right select-none">{label}</p>
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

function ActiveRunCard({ run, totalStories, onNavigateToRun, onRunCompleted }: {
  run: PipelineRun;
  totalStories: number;
  onNavigateToRun?: (runId: number) => void;
  onRunCompleted?: (status: 'done' | 'failed') => void;
}) {
  const walEvents = usePipelineSSE(String(run.id));
  const [actionLoading, setActionLoading] = useState<'pause' | 'kill' | null>(null);
  const [completionBorder, setCompletionBorder] = useState<'none' | 'success' | 'failure'>('none');
  const completionFired = useRef(false);

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

  // Detect run completion and trigger border transition
  useEffect(() => {
    if (completionFired.current) return;
    if (currentRunStatus === 'done' || currentRunStatus === 'failed' || currentRunStatus === 'cancelled') {
      completionFired.current = true;
      setCompletionBorder(currentRunStatus === 'done' ? 'success' : 'failure');
      onRunCompleted?.(currentRunStatus === 'done' ? 'done' : 'failed');
    }
  }, [currentRunStatus, onRunCompleted]);

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

  const borderTransitionClass = completionBorder === 'success'
    ? 'border-emerald-500 border-l-emerald-500'
    : completionBorder === 'failure'
      ? 'border-red-500 border-l-red-500'
      : `border-border ${BORDER_LEFT[effectiveStatus] || 'border-l-gray-500'}`;

  return (
    <button
      onClick={() => onNavigateToRun?.(run.id)}
      className={`w-full text-left p-4 hover:bg-surface-200 transition-colors duration-200 group animate-slide-down-in border-l-[3px] ${borderTransitionClass}`}
    >
      {/* Header row: status + run ID + actions */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2" aria-live="polite">
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
                className={`w-11 h-11 sm:w-8 sm:h-8 flex items-center justify-center rounded hover:bg-bg transition-colors ${actionLoading === 'pause' ? 'opacity-50' : ''}`}
                title={effectiveStatus === 'paused' ? 'Resume' : 'Pause'}
                aria-label={effectiveStatus === 'paused' ? 'Resume run' : 'Pause run'}
              >
                {effectiveStatus === 'paused' ? (
                  <Play size={16} className="text-yellow-500" />
                ) : (
                  <Pause size={16} className="text-yellow-500" />
                )}
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={handleKill}
                onKeyDown={(e) => { if (e.key === 'Enter') handleKill(e as unknown as React.MouseEvent); }}
                className={`w-11 h-11 sm:w-8 sm:h-8 flex items-center justify-center rounded hover:bg-bg transition-colors ${actionLoading === 'kill' ? 'opacity-50' : ''}`}
                title="Kill"
                aria-label="Kill run"
              >
                <Square size={16} className="text-red-500" />
              </span>
            </>
          )}
          <ChevronRight size={16} className="text-muted group-hover:text-accent transition-colors" />
        </div>
      </div>

      {/* Spec name + agent badge */}
      <div className="flex items-center gap-2 mb-1">
        <p className="text-sm font-medium text-[var(--text)] truncate capitalize">
          {specLabel(run.spec_path)}
        </p>
        <AgentBadge agentType={run.agent_type} agentModel={run.agent_model} />
      </div>

      {/* Current story */}
      {currentStoryTitle && (
        <p className="text-xs text-muted truncate mb-2">
          Running: <span className="text-[var(--text)]">{currentStoryTitle}</span>
        </p>
      )}

      {/* Progress bar */}
      <div
        className="w-full h-1.5 bg-border rounded-full overflow-hidden mb-2"
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Run progress: ${passed} of ${total} stories passed`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${effectiveStatus === 'failed' ? 'bg-red-500' :
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

function PendingReviewCard({ spec, workspaceId, onNavigate, onAction, onNavigateToSpecReview }: {
  spec: SpecSummary;
  workspaceId: string;
  onNavigate: (panel: PanelId) => void;
  onAction: (specId: string, action: 'approve' | 'reject') => void;
  onNavigateToSpecReview?: (specId: string) => void;
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
      onClick={() => onNavigateToSpecReview ? onNavigateToSpecReview(spec.id) : onNavigate('queue')}
      className="w-full text-left py-4 hover:bg-surface-200 transition-colors group flex flex-col gap-2 px-2"
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
          className={`inline-flex items-center gap-1 px-3 py-2 min-h-[44px] text-xs font-medium rounded-md bg-emerald-500/10 text-emerald-500 hover:bg-emerald-500/20 transition-colors ${actionLoading === 'approve' ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <CheckCircle size={14} />
          Approve
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => handleAction(e, 'reject')}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAction(e as unknown as React.MouseEvent, 'reject'); }}
          className={`inline-flex items-center gap-1 px-3 py-2 min-h-[44px] text-xs font-medium rounded-md bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors ${actionLoading === 'reject' ? 'opacity-50 pointer-events-none' : ''}`}
        >
          <XCircle size={14} />
          Reject
        </span>
      </div>
    </button>
  );
}

// ─── Ready-to-Run Card ──────────────────────────────────────────────────────

function ReadyToRunCard({ spec, workspaceId, workspaceBusy, workspaceName, onTriggered, onNavigate, onQueueRefresh }: {
  spec: SpecSummary;
  workspaceId: string;
  workspaceBusy: boolean;
  workspaceName: string;
  onTriggered: (specId: string) => void;
  onNavigate: (panel: PanelId) => void;
  onQueueRefresh?: () => void;
}) {
  const specPath = `forge/specs/approved/${spec.id}.json`;
  const [triggerState, setTriggerState] = useState<'idle' | 'triggering' | 'success' | 'error'>('idle');
  const [showPopover, setShowPopover] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const { show: showToast } = useGlobalToast();

  const handleTrigger = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (workspaceBusy || triggerState === 'triggering') return;
    setTriggerState('triggering');
    try {
      const result = await apiFetch<{ conflict?: boolean }>('/api/pipeline/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ specPath, workspaceId }),
      });
      if (result.conflict) {
        setTriggerState('error');
        return;
      }
      setTriggerState('success');
      onTriggered(spec.id);
    } catch {
      setTriggerState('error');
      setTimeout(() => setTriggerState('idle'), 3000);
    }
  };

  const handleAddToQueue = async () => {
    setQueueLoading(true);
    try {
      await apiFetch('/api/run-queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspaceId: Number(workspaceId),
          specId: spec.id,
          specPath: `forge/specs/approved/${spec.id}.json`,
        }),
      });
      setShowPopover(false);
      showToast('Added to queue \u2014 will run after current spec completes', 'success');
      onQueueRefresh?.();
    } catch {
      showToast('Failed to add to queue', 'error');
    } finally {
      setQueueLoading(false);
    }
  };

  return (
    <div className="py-4 px-2 space-y-3 hover:bg-surface-200 transition-colors group">
      {/* Title + story count badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text)] truncate">{spec.specName}</p>
          <p className="text-xs text-muted mt-0.5">{spec.storyCount} {spec.storyCount === 1 ? 'story' : 'stories'}</p>
        </div>
      </div>
      <div className="relative">
        {triggerState === 'success' ? (
          <div className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
            <CheckCircle size={12} />
            Launching...
          </div>
        ) : null}
        {/* Workspace badge */}
        <span className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-bg text-muted border border-border">
          <FolderGit2 size={10} />
          {workspaceName}
        </span>
      </div>

      {/* Trigger button */}
      {triggerState === 'success' ? (
        <div className="flex items-center justify-center gap-1.5 w-full min-h-[44px] py-2 rounded text-xs font-medium bg-emerald-500/15 text-emerald-500 border border-emerald-500/30">
          <CheckCircle size={14} />
          Launching...
        </div>
      ) : (
        <button
          onClick={handleTrigger}
          disabled={workspaceBusy || triggerState === 'triggering'}
          title={workspaceBusy ? 'A run is already active for this workspace' : specPath}
          className={`flex items-center justify-center gap-1.5 w-full min-h-[44px] py-2 rounded text-xs font-medium transition-opacity ${workspaceBusy
            ? 'bg-yellow-500/10 text-yellow-600 border border-yellow-500/30 cursor-not-allowed'
            : 'bg-accent text-white hover:opacity-90 disabled:opacity-60'
            }`}
        >
          {workspaceBusy ? (
            <><AlertCircle size={14} /> Workspace busy</>
          ) : triggerState === 'triggering' ? (
            <><Loader2 size={14} className="animate-spin" /> Starting...</>
          ) : triggerState === 'error' ? (
            <><XCircle size={14} /> Failed — retry</>
          ) : (
            <>Trigger <ArrowRight size={14} /></>
          )}
        </button>
      )}
    </div>
  );
}

// ─── Recent Runs Section ────────────────────────────────────────────────────

function RecentRunRow({ run, onNavigateToRun, justCompleted }: {
  run: PipelineRun;
  onNavigateToRun?: (runId: number) => void;
  justCompleted?: boolean;
}) {
  return (
    <button
      onClick={() => onNavigateToRun?.(run.id)}
      className={`w-full text-left px-3 py-2.5 min-h-[44px] hover:bg-bg transition-colors group${justCompleted ? ' animate-slide-to-recent' : ''}`}
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
          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded ${STATUS_BADGE_STYLES[run.status] || 'bg-gray-500/10 text-gray-400'}`} aria-live="polite">
            {STATUS_BADGE_LABELS[run.status] || run.status}
          </span>
          <AgentBadge agentType={run.agent_type} agentModel={run.agent_model} />
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

// ─── Scaffold Types ──────────────────────────────────────────────────────────

interface ScaffoldFile {
  relativePath: string;
  content: string;
  alreadyExists: boolean;
}

interface ScaffoldPreview {
  files: ScaffoldFile[];
  stackSummary: string;
  generatedAt: string;
}

// ─── Scaffold File Editor ────────────────────────────────────────────────────

function ScaffoldFileEditor({ file, onChange }: {
  file: ScaffoldFile;
  onChange: (content: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lineCount = file.content.split('\n').length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left px-3 py-2 flex items-center justify-between hover:bg-surface-200 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-muted shrink-0" />
          <span className="text-xs font-mono text-[var(--text)] truncate">{file.relativePath}</span>
          {file.alreadyExists && (
            <span className="px-1 py-0.5 text-[9px] font-medium rounded bg-yellow-500/10 text-yellow-600 shrink-0">
              overwrites
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-muted">{lineCount} lines</span>
          {expanded ? <ChevronDown size={12} className="text-muted" /> : <ChevronRight size={12} className="text-muted" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border">
          <textarea
            value={file.content}
            onChange={(e) => onChange(e.target.value)}
            className="w-full min-h-[200px] max-h-[500px] px-3 py-2 text-xs font-mono bg-bg text-[var(--text)] resize-y focus:outline-none"
            spellCheck={false}
            rows={Math.min(lineCount + 2, 25)}
          />
        </div>
      )}
    </div>
  );
}

// ─── Workspace Health Card ───────────────────────────────────────────────────

function scoreColor(score: number): string {
  if (score >= 70) return 'text-emerald-500';
  if (score >= 40) return 'text-yellow-500';
  return 'text-red-500';
}

function scoreBg(score: number): string {
  if (score >= 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-yellow-500';
  return 'bg-red-500';
}

function WorkspaceHealthCard({ workspaceId }: { workspaceId: string }) {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // Scaffold generation state
  const [scaffoldState, setScaffoldState] = useState<'idle' | 'generating' | 'preview' | 'writing' | 'done' | 'error'>('idle');
  const [scaffoldFiles, setScaffoldFiles] = useState<ScaffoldFile[]>([]);
  const [scaffoldSummary, setScaffoldSummary] = useState('');
  const [scaffoldError, setScaffoldError] = useState<string | null>(null);
  const { show: showToast } = useGlobalToast();

  const fetchHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<HealthReport>(`/api/workspaces/${workspaceId}/echolocate`, {
        method: 'POST',
      });
      setReport(data);
    } catch (err: any) {
      setError(err.message || 'Failed to scan workspace');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  const handleGenerateScaffold = async () => {
    setScaffoldState('generating');
    setScaffoldError(null);
    try {
      const preview = await apiFetch<ScaffoldPreview>(`/api/workspaces/${workspaceId}/scaffold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'preview' }),
      });
      setScaffoldFiles(preview.files);
      setScaffoldSummary(preview.stackSummary);
      setScaffoldState('preview');
      setExpanded(true);
    } catch (err: any) {
      setScaffoldError(err.message || 'Scaffold generation failed');
      setScaffoldState('error');
    }
  };

  const handleWriteScaffold = async () => {
    setScaffoldState('writing');
    try {
      const result = await apiFetch<{ filesWritten: string[]; filesSkipped: string[] }>(`/api/workspaces/${workspaceId}/scaffold`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'write',
          files: scaffoldFiles.map(f => ({ relativePath: f.relativePath, content: f.content })),
        }),
      });
      setScaffoldState('done');
      showToast(
        `Scaffolding written: ${result.filesWritten.length} files committed`,
        'success',
      );
      // Re-scan to update health score
      fetchHealth();
    } catch (err: any) {
      setScaffoldError(err.message || 'Failed to write scaffold files');
      setScaffoldState('error');
    }
  };

  const handleUpdateFile = (index: number, content: string) => {
    setScaffoldFiles(prev => prev.map((f, i) => i === index ? { ...f, content } : f));
  };

  const hasMissingContextFiles = report && report.missing.length > 0;
  const showScaffoldPrompt = hasMissingContextFiles && report.stack.length > 0 && scaffoldState === 'idle';

  if (loading) {
    return (
      <div className="p-4 border border-border rounded-lg animate-pulse">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-4 h-4 rounded bg-border" />
          <div className="h-4 w-32 rounded bg-border" />
        </div>
        <div className="h-2 w-full rounded bg-border" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 border border-border rounded-lg">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted">
            <HeartPulse size={16} />
            <span>Workspace Health</span>
          </div>
          <button onClick={fetchHealth} className="text-xs text-accent hover:underline flex items-center gap-1">
            <RefreshCw size={12} /> Retry
          </button>
        </div>
        <p className="text-xs text-red-500 mt-2">{error}</p>
      </div>
    );
  }

  if (!report) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {/* Header with score */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-4 hover:bg-surface-200 transition-colors"
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <HeartPulse size={16} className="text-muted" />
            <span className="text-sm font-semibold text-[var(--text)]">Workspace Health</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); fetchHealth(); }}
              className="p-1 rounded hover:bg-bg transition-colors"
              title="Re-scan"
            >
              <RefreshCw size={12} className="text-muted" />
            </button>
            <span className={`text-lg font-bold tabular-nums ${scoreColor(report.score)}`}>
              {report.score}
            </span>
            <span className="text-xs text-muted">/100</span>
            <ChevronRight size={14} className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </div>
        </div>

        {/* Progress bar */}
        <div className="w-full h-1.5 bg-border rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${scoreBg(report.score)}`}
            style={{ width: `${report.score}%` }}
          />
        </div>

        {/* Stack pills */}
        {report.stack.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {report.stack.slice(0, 8).map((s) => (
              <span key={s.name} className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-accent/10 text-accent">
                {s.name}{s.version ? ` ${s.version}` : ''}
              </span>
            ))}
            {report.stack.length > 8 && (
              <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-bg text-muted">
                +{report.stack.length - 8}
              </span>
            )}
          </div>
        )}

        {/* Monorepo badge */}
        {report.monorepo.detected && (
          <div className="flex items-center gap-1 mt-2 text-[10px] text-muted">
            <FolderGit2 size={10} />
            <span>Monorepo · {report.monorepo.packages.length} packages</span>
          </div>
        )}
      </button>

      {/* Scaffold generation prompt — shown when missing context files + stack detected */}
      {showScaffoldPrompt && (
        <div className="border-t border-border px-4 py-3 bg-accent/5">
          <div className="flex items-start gap-3">
            <Wand2 size={16} className="text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--text)]">
                I detected {report.stack.slice(0, 3).map(s => s.name).join(' + ')}{report.stack.length > 3 ? ` + ${report.stack.length - 3} more` : ''}. Generate context scaffolding?
              </p>
              <p className="text-xs text-muted mt-1">
                Creates bespoke CLAUDE.md, AGENTS.md, .rorca/config.json, and skill files tailored to your codebase.
              </p>
              <div className="flex flex-wrap gap-1 mt-2">
                {['CLAUDE.md', 'AGENTS.md', '.rorca/config.json', '.rorca/skills/'].map(f => (
                  <span key={f} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-emerald-500/10 text-emerald-600">
                    {f}
                  </span>
                ))}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); handleGenerateScaffold(); }}
                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
              >
                <Wand2 size={12} />
                Generate scaffolding
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scaffold generating spinner */}
      {scaffoldState === 'generating' && (
        <div className="border-t border-border px-4 py-6 flex flex-col items-center gap-2">
          <Loader2 size={20} className="text-accent animate-spin" />
          <p className="text-xs text-muted">Analyzing codebase and generating scaffolding...</p>
          <p className="text-[10px] text-muted/60">This may take 30-60 seconds</p>
        </div>
      )}

      {/* Scaffold preview — inline file editors */}
      {scaffoldState === 'preview' && expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Eye size={14} className="text-accent" />
              <p className="text-xs font-medium text-[var(--text)]">
                Preview — {scaffoldFiles.length} files for {scaffoldSummary}
              </p>
            </div>
            <button
              onClick={() => { setScaffoldState('idle'); setScaffoldFiles([]); }}
              className="p-1 rounded hover:bg-bg transition-colors"
              title="Cancel"
            >
              <X size={12} className="text-muted" />
            </button>
          </div>

          <p className="text-[10px] text-muted">
            Review and edit files below. Click &quot;Write to disk&quot; to save all files and commit.
          </p>

          <div className="space-y-2">
            {scaffoldFiles.map((file, i) => (
              <ScaffoldFileEditor
                key={file.relativePath}
                file={file}
                onChange={(content) => handleUpdateFile(i, content)}
              />
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleWriteScaffold}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
            >
              <Save size={12} />
              Write to disk
            </button>
            <button
              onClick={() => { setScaffoldState('idle'); setScaffoldFiles([]); }}
              className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[36px] text-xs font-medium rounded-md border border-border text-muted hover:bg-bg transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Scaffold writing spinner */}
      {scaffoldState === 'writing' && (
        <div className="border-t border-border px-4 py-4 flex items-center gap-2">
          <Loader2 size={14} className="text-accent animate-spin" />
          <p className="text-xs text-muted">Writing files and committing...</p>
        </div>
      )}

      {/* Scaffold done */}
      {scaffoldState === 'done' && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-emerald-500" />
            <p className="text-xs text-emerald-600 font-medium">
              Scaffolding written and committed successfully
            </p>
          </div>
        </div>
      )}

      {/* Scaffold error */}
      {scaffoldState === 'error' && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <XCircle size={14} className="text-red-500" />
              <p className="text-xs text-red-500">{scaffoldError}</p>
            </div>
            <button
              onClick={() => { setScaffoldState('idle'); setScaffoldError(null); }}
              className="text-xs text-accent hover:underline"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Expanded details (original health report details) */}
      {expanded && scaffoldState !== 'preview' && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {/* Missing files */}
          {report.missing.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted mb-1.5">Missing context files</p>
              <div className="flex flex-wrap gap-1">
                {report.missing.map((m) => (
                  <span key={m} className="px-1.5 py-0.5 text-[10px] font-mono rounded bg-red-500/10 text-red-500">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Suggestions */}
          {report.suggestions.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted mb-1.5">Suggestions</p>
              <ul className="space-y-1">
                {report.suggestions.map((s, i) => (
                  <li key={i} className="text-xs text-[var(--text)] flex gap-1.5">
                    <span className="text-accent shrink-0 mt-0.5">-</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Scanned timestamp */}
          <p className="text-[10px] text-muted text-right">
            Scanned {relativeTime(report.scannedAt)}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── HubPanel ───────────────────────────────────────────────────────────────

interface CompletionToast {
  id: number;
  message: string;
  type: 'success' | 'error';
}

export default function HubPanel({ onNavigate, onNavigateToRun, onNavigateToSpecReview }: { onNavigate: (panel: PanelId) => void; onNavigateToRun?: (runId: number) => void; onNavigateToSpecReview?: (specId: string) => void }) {
  const { workspaceId, workspaces, selectedWorkspace, addWorkspace } = useWorkspace();
  const [showAddWorkspace, setShowAddWorkspace] = useState(false);
  const [activeRun, setActiveRun] = useState<PipelineRun | null>(null);
  const [totalStories, setTotalStories] = useState(0);
  const [pendingSpecs, setPendingSpecs] = useState<SpecSummary[]>([]);
  const [pendingSearchQuery, setPendingSearchQuery] = useState('');
  const [approvedSpecs, setApprovedSpecs] = useState<SpecSummary[]>([]);
  const [recentRuns, setRecentRuns] = useState<PipelineRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [queueLength, setQueueLength] = useState(0);
  const [nextQueueSpecName, setNextQueueSpecName] = useState<string | null>(null);
  const [justCompletedRunIds, setJustCompletedRunIds] = useState<Set<number>>(new Set());
  const { toasts: completionToasts, show: showCompletionToastRaw, dismiss: dismissCompletionToast } = useToast();
  const showCompletionToast = useCallback((status: string, label: string) => {
    showCompletionToastRaw(
      status === 'completed' ? `✓ ${label} completed` : `✗ ${label} failed`,
      status === 'completed' ? 'success' : 'error',
    );
  }, [showCompletionToastRaw]);

  const fetchData = useCallback(async () => {
    if (!workspaceId) return;

    const [runsRes, specsRes, approvedRes] = await Promise.all([
      apiFetch<{ items: PipelineRun[] }>(
        `/api/pipeline/runs?workspaceId=${workspaceId}&limit=20`,
        { silent: true },
      ).catch(() => ({ items: [] as PipelineRun[] })),
      apiFetch<{ items: SpecSummary[] }>(
        `/api/specs?workspaceId=${workspaceId}&status=pending`,
        { silent: true },
      ).catch(() => ({ items: [] as SpecSummary[] })),
      apiFetch<{ items: SpecSummary[] }>(
        `/api/specs?workspaceId=${workspaceId}&status=approved`,
        { silent: true },
      ).catch(() => ({ items: [] as SpecSummary[] })),
    ]);

    const runs = runsRes.items;
    const active = runs.find((r) => r.status === 'running' || r.status === 'paused') ?? null;
    setActiveRun(active);
    setPendingSpecs(specsRes.items);
    // Recent = completed runs (not active), most recent first
    setRecentRuns(runs.filter((r) => r.status !== 'running' && r.status !== 'paused').slice(0, 10));

    // Filter approved specs: exclude any that have an active or completed run
    const runSpecSlugs = new Set(runs.map((r) => specSlug(r.spec_path)));
    setApprovedSpecs(approvedRes.items.filter((s) => !runSpecSlugs.has(s.id)));

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

    setLastUpdated(new Date());
    setLoaded(true);
  }, [workspaceId]);

  const fetchQueueStatus = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<{ queueLength: number; nextSpec: { spec_id: string } | null }>(
        `/api/run-queue/status?workspaceId=${workspaceId}`,
      );
      setQueueLength(data.queueLength);
      setNextQueueSpecName(
        data.nextSpec ? data.nextSpec.spec_id.replace(/-/g, ' ') : null,
      );
    } catch {
      setQueueLength(0);
      setNextQueueSpecName(null);
    }
  }, [workspaceId]);

  // Poll every 30s, pause when tab is backgrounded
  useEffect(() => {
    fetchData();
    fetchQueueStatus();

    const fetchAll = () => { fetchData(); fetchQueueStatus(); };
    let interval = setInterval(fetchAll, 30_000);

    const onVisibilityChange = () => {
      if (document.hidden) {
        clearInterval(interval);
      } else {
        fetchAll();
        interval = setInterval(fetchAll, 30_000);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchData, fetchQueueStatus]);

  // SSE: re-fetch immediately when a run completes, fails, or is cancelled
  const fetchRef = useRef(fetchData);
  fetchRef.current = fetchData;
  const queueRef = useRef(fetchQueueStatus);
  queueRef.current = fetchQueueStatus;
  useEffect(() => {
    const es = new EventSource(`${BASE_URL}/api/pipeline/stream`);
    const RUN_TERMINAL_EVENTS = new Set([
      'run_finished', 'run_failed', 'run_cancelled',
      'run_started', 'run_paused', 'run_resumed',
    ]);
    const QUEUE_EVENTS = new Set([
      'run_queued_trigger', 'run_finished',
    ]);
    es.addEventListener('wal_event', (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (RUN_TERMINAL_EVENTS.has(evt.event_type)) {
          fetchRef.current();
        }
        if (QUEUE_EVENTS.has(evt.event_type)) {
          queueRef.current();
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
    return <HubSkeleton />;
  }

  const hasActiveRun = !!activeRun;
  const hasPending = pendingSpecs.length > 0;
  const hasApproved = approvedSpecs.length > 0;
  const hasRecent = recentRuns.length > 0;
  const isEmpty = !hasActiveRun && !hasPending && !hasApproved && !hasRecent;

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
    <div className="h-full flex flex-col overflow-hidden bg-bg">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">
              {selectedWorkspace?.name ?? 'Hub'}
            </span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-sm text-muted">Overview</span>
          </div>
        }
      />
      <div className="h-full overflow-y-auto">
        {/* Completion toast — top-right slide-in */}
        <ToastContainer toasts={completionToasts} onDismiss={dismissCompletionToast} position="top-right" />

        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-8">
          {/* Workspace Health */}
          {workspaceId && (
            <section>
              <WorkspaceHealthCard workspaceId={workspaceId} />
            </section>
          )}

          {/* Active Run */}
          {hasActiveRun && (
            <section>
              <SectionHeader icon={Play} label="Active Run" />
              <ActiveRunCard
                run={activeRun}
                totalStories={totalStories}
                onNavigateToRun={onNavigateToRun}
                onRunCompleted={(status) => {
                  showCompletionToast(status, specLabel(activeRun.spec_path));
                  setJustCompletedRunIds(prev => new Set(prev).add(activeRun.id));
                }}
              />
            </section>
          )}

          {/* Queue Status */}
          {queueLength > 0 && (
            <section>
              <div className="flex items-center justify-between">
                <SectionHeader icon={ListPlus} label="Queue" badge={queueLength} noMargin />
                <button
                  onClick={() => onNavigate('pipeline')}
                  className="flex items-center gap-1 text-xs text-accent hover:underline"
                >
                  View Queue <ArrowRight size={12} />
                </button>
              </div>
              <p className="text-sm text-muted mt-2">
                {queueLength} {queueLength === 1 ? 'spec' : 'specs'} queued
                {nextQueueSpecName && (
                  <> &mdash; next: <span className="text-[var(--text)] font-medium capitalize">{nextQueueSpecName}</span></>
                )}
              </p>
            </section>
          )}

          {/* Pending Reviews */}
          {hasPending && (
            <section>
              <div className="flex items-center justify-between mb-3">
                <SectionHeader icon={ListChecks} label="Pending Reviews" badge={pendingSpecs.length} noMargin />
                <div className="relative group w-48 transition-all focus-within:w-64">
                  <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
                    <Search size={14} className="text-muted group-focus-within:text-[var(--text)] transition-colors" />
                  </div>
                  <input
                    type="text"
                    placeholder="Filter missing specs..."
                    value={pendingSearchQuery}
                    onChange={(e) => setPendingSearchQuery(e.target.value)}
                    className="block w-full pl-8 pr-3 py-1.5 text-xs bg-bg border border-border rounded-md text-[var(--text)] placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent transition-all duration-200"
                  />
                </div>
              </div>
              {(() => {
                const filtered = pendingSpecs.filter(spec =>
                  spec.specName.toLowerCase().includes(pendingSearchQuery.toLowerCase()) ||
                  spec.id.toLowerCase().includes(pendingSearchQuery.toLowerCase())
                );

                return filtered.length > 0 ? (
                  <ul className="flex flex-col divide-y divide-border border-y border-border m-0 p-0 list-none">
                    {filtered.map((spec, i) => (
                      <li key={spec.id} className={`animate-stagger-item stagger-${Math.min(i + 1, 8)}`}>
                        <PendingReviewCard
                          spec={spec}
                          workspaceId={workspaceId!}
                          onNavigate={onNavigate}
                          onNavigateToSpecReview={onNavigateToSpecReview}
                          onAction={(specId) => {
                            setPendingSpecs((prev) => prev.filter((s) => s.id !== specId));
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="py-8 text-center border-y border-border">
                    <p className="text-sm text-muted">No pending specs match your search.</p>
                  </div>
                );
              })()}
              <UpdatedFooter lastUpdated={lastUpdated} />
            </section>
          )}

          {/* Ready to Run */}
          {hasApproved && (
            <section>
              <SectionHeader icon={Rocket} label="Ready to Run" badge={approvedSpecs.length} />
              <ul className="flex flex-col divide-y divide-border border-y border-border m-0 p-0 list-none">
                {approvedSpecs.map((spec, i) => (
                  <li key={spec.id} className={`animate-stagger-item stagger-${Math.min(i + 1 + pendingSpecs.length, 8)}`}>
                    <ReadyToRunCard
                      spec={spec}
                      workspaceId={workspaceId!}
                      workspaceBusy={hasActiveRun}
                      workspaceName={selectedWorkspace?.name ?? ''}
                      onTriggered={() => fetchData()}
                      onNavigate={onNavigate}
                      onQueueRefresh={fetchQueueStatus}
                    />
                  </li>
                ))}
              </ul>
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
              <ul className="flex flex-col divide-y divide-border border-y border-border m-0 p-0 list-none">
                {recentRuns.map((run, i) => (
                  <li key={run.id} className={`animate-stagger-item stagger-${Math.min(i + 1, 8)}`}>
                    <RecentRunRow run={run} onNavigateToRun={onNavigateToRun} justCompleted={justCompletedRunIds.has(run.id)} />
                  </li>
                ))}
              </ul>
              <UpdatedFooter lastUpdated={lastUpdated} />
            </section>
          )}

        </div>
      </div>
    </div>
  );
}
