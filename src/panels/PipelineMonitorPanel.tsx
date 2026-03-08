import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Play, Pause, Terminal, ChevronDown, ChevronRight, Copy, Check, List, GripVertical, GitBranch, AlertTriangle, BarChart3, RotateCcw, Download, XCircle, DollarSign, GitCommitHorizontal, RefreshCw, Loader2, Info } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE, WalEvent } from '../hooks/usePipelineSSE';
import { apiFetch, BASE_URL } from '../lib/apiFetch';
import RunTerminal from '../components/RunTerminal';
import MultiPaneTerminal from '../components/MultiPaneTerminal';
import InteractiveDependencyGraph from '../components/InteractiveDependencyGraph';
import { HelpTooltip } from '../components/HelpTooltip';
import RunQueueSection, { QueueEntry } from '../components/RunQueueSection';
import SpecPickerModal from '../components/SpecPickerModal';
import AgentBadge from '../components/AgentBadge';
import FinOpsTab from '../components/FinOpsTab';
import AppHeader from '../components/AppHeader';
import RunMetadataPanel from '../components/RunMetadataPanel';

type DetailTab = 'stories' | 'terminal' | 'graph' | 'tokens' | 'finops' | 'run-info' | 'commits';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed' | 'partial_failure' | 'cancelled';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
  retried_from_run_id: number | null;
  agent_type?: string;
  agent_model?: string | null;
  parallelism?: number;
  branch_name?: string | null;
  worktree_path?: string | null;
}

interface CommitEntry {
  sha: string;
  message: string;
  author: string;
  date: string;
  storyId?: string;
}

type RunStatus = PipelineRun['status'];

interface StoryResult {
  id: number;
  run_id: number;
  story_id: string;
  status: 'pass' | 'fail' | 'skip' | 'retry';
  retries: number;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

type StoryStatus = 'pending' | 'running' | 'pass' | 'fail' | 'retry' | 'skipped';

interface EscalationInfo {
  fromTier: string;
  toTier: string;
  attemptNumber: number;
}

interface RerouteInfo {
  fromEngine: string;
  toEngine: string;
  reason: string;
}

interface DerivedStory {
  storyId: string;
  status: StoryStatus;
  title: string;
  elapsed: string;
  startedAt: string | null;
  priority: number;  // 1=urgent, 2=high, 3=normal, 4=low
  inputTokens: number | null;
  outputTokens: number | null;
  escalation: EscalationInfo | null;
  agent?: string;
  reroute?: RerouteInfo | null;
}

const CONTEXT_WINDOW = 200_000; // 200k token context window
const CONTEXT_WARNING_THRESHOLD = 0.8; // 80% warning

interface SpecStory {
  id: string;
  title: string;
  priority?: number;
  passes?: boolean;
  dependsOn?: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_DOTS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  partial_failure: 'bg-orange-500',
  paused: 'bg-yellow-500',
  cancelled: 'bg-gray-500',
};

const STORY_ICONS: Record<StoryStatus, string> = {
  pass: '✅',
  fail: '❌',
  running: '🔄',
  pending: '⏳',
  retry: '🔁',
  skipped: '⏭️',
};

const PRIORITY_CONFIG: Record<number, { label: string; className: string }> = {
  1: { label: 'Urgent', className: 'bg-red-500/20 text-red-400 border-red-500/30' },
  2: { label: 'High', className: 'bg-orange-500/20 text-orange-400 border-orange-500/30' },
  3: { label: 'Normal', className: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30' },
  4: { label: 'Low', className: 'bg-zinc-500/10 text-zinc-500 border-zinc-500/20' },
};

function specName(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '').replace(/-/g, ' ');
}

// SQLite returns timestamps without timezone (UTC but no 'Z') — append 'Z' to parse correctly
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ContextBudgetBar({ inputTokens, outputTokens }: { inputTokens: number; outputTokens: number }) {
  const total = inputTokens + outputTokens;
  const pct = Math.min((total / CONTEXT_WINDOW) * 100, 100);
  const isWarning = total / CONTEXT_WINDOW >= CONTEXT_WARNING_THRESHOLD;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 h-1.5 bg-[var(--border)] rounded-full overflow-hidden min-w-[60px]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${isWarning ? 'bg-amber-500' : 'bg-[var(--accent)]'
            }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[10px] font-mono whitespace-nowrap ${isWarning ? 'text-amber-400' : 'text-[var(--text-muted)]'}`}>
        {formatTokens(total)}/{formatTokens(CONTEXT_WINDOW)}
      </span>
      {isWarning && <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />}
      <HelpTooltip helpKey="context-budget" size={10} />
    </div>
  );
}

function deriveStoriesFromEvents(events: WalEvent[]): DerivedStory[] {
  const storyMap = new Map<string, DerivedStory>();

  for (const e of events) {
    if (!e.story_id) continue;
    const existing = storyMap.get(e.story_id);
    const payload = e.payload ? JSON.parse(e.payload) : {};

    switch (e.event_type) {
      case 'story_started':
        storyMap.set(e.story_id, {
          storyId: e.story_id,
          status: 'running',
          title: payload.title || e.story_id,
          elapsed: '',
          startedAt: e.ts,
          priority: existing?.priority ?? 3,
          inputTokens: existing?.inputTokens ?? null,
          outputTokens: existing?.outputTokens ?? null,
          escalation: existing?.escalation ?? null,
        });
        break;
      case 'story_passed':
        if (existing) {
          existing.status = 'pass';
          existing.elapsed = payload.elapsed || elapsedTime(existing.startedAt || e.ts, e.ts);
          if (payload.input_tokens != null) existing.inputTokens = payload.input_tokens;
          if (payload.output_tokens != null) existing.outputTokens = payload.output_tokens;
        } else {
          storyMap.set(e.story_id, {
            storyId: e.story_id,
            status: 'pass',
            title: payload.title || e.story_id,
            elapsed: payload.elapsed || '',
            startedAt: e.ts,
            priority: 3,
            inputTokens: payload.input_tokens ?? null,
            outputTokens: payload.output_tokens ?? null,
            escalation: null,
          });
        }
        break;
      case 'story_failed':
        if (existing) {
          existing.status = 'fail';
          existing.elapsed = payload.elapsed || elapsedTime(existing.startedAt || e.ts, e.ts);
          if (payload.input_tokens != null) existing.inputTokens = payload.input_tokens;
          if (payload.output_tokens != null) existing.outputTokens = payload.output_tokens;
        } else {
          storyMap.set(e.story_id, {
            storyId: e.story_id,
            status: 'fail',
            title: payload.title || e.story_id,
            elapsed: payload.elapsed || '',
            startedAt: e.ts,
            priority: 3,
            inputTokens: payload.input_tokens ?? null,
            outputTokens: payload.output_tokens ?? null,
            escalation: null,
          });
        }
        break;
      case 'story_retry':
        if (existing) {
          existing.status = 'retry';
        }
        break;
      case 'story_escalated':
        if (existing) {
          existing.escalation = {
            fromTier: payload.fromTier || '?',
            toTier: payload.toTier || '?',
            attemptNumber: payload.attemptNumber ?? 0,
          };
          // Story restarts on the new tier — mark as running again
          existing.status = 'running';
        }
        break;
      case 'story_token_update':
        if (existing) {
          existing.inputTokens = payload.cumulative_input ?? existing.inputTokens;
          existing.outputTokens = payload.cumulative_output ?? existing.outputTokens;
        }
        break;
      case 'story_rerouted':
        if (existing) {
          existing.reroute = {
            fromEngine: payload.fromEngine || '?',
            toEngine: payload.toEngine || '?',
            reason: payload.reason || 'rate_limit',
          };
          // Story restarts on the fallback engine — mark as running
          existing.status = 'running';
        }
        break;
      case 'story_skipped':
        storyMap.set(e.story_id, {
          storyId: e.story_id,
          status: 'skipped',
          title: payload.title || e.story_id,
          elapsed: '',
          startedAt: null,
          priority: existing?.priority ?? 3,
          inputTokens: null,
          outputTokens: null,
          escalation: null,
        });
        break;
    }
  }

  return Array.from(storyMap.values());
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function PipelineMonitorPanel() {
  const { workspaceId } = useWorkspace();
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<{
    run: PipelineRun;
    stories: StoryResult[];
    specStories?: Array<{ id: string; title: string; agent?: string; reroute?: RerouteInfo }>;
    runState?: { resumedFromStory?: string | null; currentStory?: string | null; completedStories?: Array<{ storyId: string }>; failedStories?: Array<{ storyId: string }>; skippedStories?: Array<{ storyId: string }> } | null;
  } | null>(null);
  const [expandedStory, setExpandedStory] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [showStartHelp, setShowStartHelp] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('terminal');
  const [specStories, setSpecStories] = useState<SpecStory[]>([]);
  const [specModel, setSpecModel] = useState<string | null>(null);
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [commitsLoading, setCommitsLoading] = useState(false);
  const [commitsBranch, setCommitsBranch] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSrcId = useRef<string | null>(null);
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [specPickerOpen, setSpecPickerOpen] = useState(false);

  // SSE for live updates — scoped to workspace
  const sseEvents = usePipelineSSE(selectedRunId ? String(selectedRunId) : null, workspaceId);

  // Reset all state when workspace changes to prevent cross-contamination
  useEffect(() => {
    setSelectedRunId(null);
    setSelectedRunDetail(null);
    setExpandedStory(null);
    setLogLines([]);
    setDetailTab('terminal');
    setSpecStories([]);
    setSpecModel(null);
    setCommits([]);
    setCommitsBranch(null);
  }, [workspaceId]);

  // Fetch run list
  const fetchRuns = useCallback(() => {
    if (!workspaceId) return;
    apiFetch<{ items: PipelineRun[]; total: number; hasMore: boolean; cursor?: string }>(`/api/pipeline/runs?workspaceId=${workspaceId}`)
      .then((data) => {
        setRuns(data.items);
        // Auto-select first run only if nothing is selected
        if (data.items.length > 0 && !selectedRunId) {
          setSelectedRunId(data.items[0].id);
        }
      })
      .catch(console.error);
  }, [workspaceId, selectedRunId]);

  // Fetch on mount / workspace change
  useEffect(() => { fetchRuns(); }, [fetchRuns]);

  // Poll runs every 15s + re-fetch on network reconnect
  useEffect(() => {
    const interval = setInterval(fetchRuns, 15_000);
    const onOnline = () => { fetchRuns(); };
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', onOnline);
    };
  }, [fetchRuns]);

  // ─── Queue data ────────────────────────────────────────────────
  const fetchQueue = useCallback(() => {
    if (!workspaceId) return;
    apiFetch<{ items: QueueEntry[] }>(`/api/run-queue?workspaceId=${workspaceId}`)
      .then((data) => setQueueEntries(data.items))
      .catch(() => setQueueEntries([]));
  }, [workspaceId]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  // Refresh queue when SSE delivers a queue-related event
  useEffect(() => {
    const queueEvents = sseEvents.filter(
      (e) => e.event_type === 'run_queued_trigger' || e.event_type === 'run_finished'
    );
    if (queueEvents.length > 0) {
      fetchQueue();
    }
  }, [sseEvents, fetchQueue]);

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

  // Fetch run detail when selection changes
  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      setSpecStories([]);
      return;
    }
    apiFetch<{ run: PipelineRun; stories: StoryResult[]; specStories?: Array<{ id: string; title: string; priority?: number; agent?: string; reroute?: RerouteInfo; passes?: boolean }>; specModel?: string }>(`/api/pipeline/runs/${selectedRunId}`)
      .then((data) => {
        setSelectedRunDetail(data);
        if (data.specModel) setSpecModel(data.specModel);
        // Seed specStories immediately from run detail to avoid empty-state flash.
        // The spec poll below will refine with live passes data.
        if (data.specStories?.length) {
          setSpecStories(data.specStories.map(s => ({
            id: s.id,
            title: s.title,
            priority: s.priority ?? 3,
            passes: s.passes ?? false,
          })) as SpecStory[]);
        }
      })
      .catch(console.error);
  }, [selectedRunId]);

  // Fetch spec stories (with priority + passes data) for the selected run.
  // Polls every 10s while run is active so story pass/fail status updates live.
  useEffect(() => {
    if (!selectedRunDetail || !workspaceId) {
      return;
    }

    const specPath = selectedRunDetail.run.spec_path;
    const filename = specPath.split('/').pop() || '';
    const specId = filename.replace(/\.json$/, '');
    if (!specId) return;

    const fetchSpec = () => {
      apiFetch<{ userStories?: SpecStory[] }>(`/api/specs/${specId}?workspaceId=${workspaceId}`)
        .then((data) => setSpecStories(data.userStories ?? []))
        .catch(() => { /* keep existing specStories on error */ });
    };

    fetchSpec();

    // Poll while the run is active
    const isActive = selectedRunDetail.run.status === 'running' || selectedRunDetail.run.status === 'paused';
    if (isActive) {
      const interval = setInterval(fetchSpec, 10_000);
      return () => clearInterval(interval);
    }
  }, [selectedRunDetail, workspaceId]);

  // Fetch commits for selected run
  const fetchCommits = useCallback(async () => {
    if (!selectedRunId) return;
    setCommitsLoading(true);
    try {
      const data = await apiFetch<{ commits: CommitEntry[]; branchName: string | null }>(
        `/api/pipeline/runs/${selectedRunId}/commits`,
      );
      setCommits(data.commits);
      setCommitsBranch(data.branchName);
    } catch {
      setCommits([]);
    } finally {
      setCommitsLoading(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    setCommits([]);
    setCommitsBranch(null);
    fetchCommits();
  }, [fetchCommits]);

  // Re-fetch commits each time a story passes so the Commits tab stays live during a run
  const passedCount = useMemo(
    () => sseEvents.filter(e => e.event_type === 'story_passed').length,
    [sseEvents]
  );
  useEffect(() => {
    if (passedCount > 0) fetchCommits();
  }, [passedCount, fetchCommits]);

  // Build priority lookup from spec stories
  const priorityMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of specStories) {
      map.set(s.id, s.priority ?? 3);
    }
    return map;
  }, [specStories]);

  // Build reroute + agent lookup from run detail's specStories
  const rerouteMap = useMemo(() => {
    const map = new Map<string, { agent?: string; reroute?: RerouteInfo }>();
    for (const s of selectedRunDetail?.specStories ?? []) {
      if (s.agent || s.reroute) {
        map.set(s.id, { agent: s.agent, reroute: s.reroute });
      }
    }
    return map;
  }, [selectedRunDetail]);

  // Derive live stories from SSE events, merged with DB story results
  const derivedStories = useMemo(() => {
    const fromDB: DerivedStory[] = (selectedRunDetail?.stories || []).map((s) => {
      const extra = rerouteMap.get(s.story_id);
      return {
        storyId: s.story_id,
        status: s.status === 'pass' ? 'pass' : s.status === 'fail' ? 'fail' : s.status === 'retry' ? 'retry' : s.status === 'skip' ? 'skipped' : 'pending' as StoryStatus,
        title: s.story_id,
        elapsed: elapsedTime(s.started_at, s.finished_at),
        startedAt: s.started_at,
        priority: priorityMap.get(s.story_id) ?? 3,
        inputTokens: s.input_tokens,
        outputTokens: s.output_tokens,
        escalation: null,
        agent: extra?.agent,
        reroute: extra?.reroute ?? null,
      };
    });

    const fromSSE = deriveStoriesFromEvents(sseEvents);

    // Merge layers: spec (base) → DB → SSE (highest priority)
    const merged = new Map<string, DerivedStory>();

    // Layer 1: Seed from spec stories — uses `passes` field for real-time status
    for (const s of specStories) {
      merged.set(s.id, {
        storyId: s.id,
        status: s.passes ? 'pass' : 'pending',
        title: s.title,
        elapsed: '',
        startedAt: null,
        priority: s.priority ?? 3,
        inputTokens: null,
        outputTokens: null,
        escalation: null,
      });
    }

    // Layer 2: DB results override spec
    for (const s of fromDB) merged.set(s.storyId, s);
    // Layer 3: SSE events override DB
    for (const s of fromSSE) merged.set(s.storyId, s);

    // Merge priority from spec into all entries
    for (const [id, story] of merged) {
      story.priority = priorityMap.get(id) ?? story.priority;
      // Also use spec title if we only have the storyId
      const specStory = specStories.find(s => s.id === id);
      if (specStory && story.title === story.storyId) {
        story.title = specStory.title;
      }
    }

    // Sort by priority (ascending: 1=urgent first), then by storyId for stability
    return Array.from(merged.values()).sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.storyId.localeCompare(b.storyId)
    );
  }, [selectedRunDetail, sseEvents, specStories, priorityMap]);

  const completedCount = derivedStories.filter((s) => s.status === 'pass' || s.status === 'fail' || s.status === 'skipped').length;
  const totalCount = derivedStories.length;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Token usage stats
  const tokenStats = useMemo(() => {
    const storiesWithTokens = derivedStories.filter(s => s.inputTokens != null || s.outputTokens != null);
    const totalInput = storiesWithTokens.reduce((sum, s) => sum + (s.inputTokens ?? 0), 0);
    const totalOutput = storiesWithTokens.reduce((sum, s) => sum + (s.outputTokens ?? 0), 0);
    const warningStories = storiesWithTokens.filter(s => {
      const total = (s.inputTokens ?? 0) + (s.outputTokens ?? 0);
      return total / CONTEXT_WINDOW >= CONTEXT_WARNING_THRESHOLD;
    });
    return { storiesWithTokens, totalInput, totalOutput, warningStories, hasData: storiesWithTokens.length > 0 };
  }, [derivedStories]);

  // Update selected run status from SSE (handles finish, pause, resume events)
  const liveRun = useMemo(() => {
    if (!selectedRunDetail) return null;
    let run = selectedRunDetail.run;

    // Check lifecycle events in order — last one wins
    const lifecycleEvents = sseEvents.filter(
      (e) => e.event_type === 'run_finished' || e.event_type === 'run_paused' || e.event_type === 'run_resumed' || e.event_type === 'run_cancelled'
    );

    if (lifecycleEvents.length > 0) {
      const last = lifecycleEvents[lifecycleEvents.length - 1];
      if (last.event_type === 'run_finished') {
        const payload = JSON.parse(last.payload || '{}');
        run = { ...run, status: (payload.status || 'done') as RunStatus, finished_at: last.ts };
      } else if (last.event_type === 'run_paused') {
        run = { ...run, status: 'paused' };
      } else if (last.event_type === 'run_resumed') {
        run = { ...run, status: 'running' };
      } else if (last.event_type === 'run_cancelled') {
        run = { ...run, status: 'cancelled', finished_at: last.ts };
      }
    }

    return run;
  }, [selectedRunDetail, sseEvents]);

  // Detect if we should show multi-pane terminal (parallelism > 1 with 2+ concurrent stories)
  const useMultiPane = useMemo(() => {
    if (!selectedRunDetail || (selectedRunDetail.run.parallelism ?? 1) <= 1) return false;
    const started = new Set<string>();
    for (const evt of sseEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started') started.add(evt.story_id);
    }
    return started.size >= 2;
  }, [selectedRunDetail, sseEvents]);

  // Derive specId from selected run for graph tab
  const selectedSpecId = useMemo(() => {
    if (!selectedRunDetail) return '';
    const filename = selectedRunDetail.run.spec_path.split('/').pop() || '';
    return filename.replace(/\.json$/, '');
  }, [selectedRunDetail]);

  // Build live status map for the interactive graph (maps DerivedStory status to graph status)
  const graphLiveStatuses = useMemo(() => {
    const statusMap = new Map<string, { storyId: string; status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped'; startedAt: string | null; elapsed: string }>();
    for (const s of derivedStories) {
      const graphStatus = s.status === 'pass' ? 'passed' as const
        : s.status === 'fail' ? 'failed' as const
          : s.status === 'running' ? 'running' as const
            : s.status === 'retry' ? 'running' as const
              : 'pending' as const;
      statusMap.set(s.storyId, {
        storyId: s.storyId,
        status: graphStatus,
        startedAt: s.startedAt,
        elapsed: s.elapsed,
      });
    }
    return statusMap;
  }, [derivedStories]);

  // Load log tail when expanding a story
  const handleStoryExpand = (storyId: string) => {
    if (expandedStory === storyId) {
      setExpandedStory(null);
      setLogLines([]);
      return;
    }
    setExpandedStory(storyId);
    // Find log path from story results
    const story = selectedRunDetail?.stories.find((s) => s.story_id === storyId);
    if (story?.log_path) {
      apiFetch<{ lines: string[] }>(`/api/pipeline/logs?path=${encodeURIComponent(story.log_path)}`)
        .then((data) => setLogLines(data.lines))
        .catch(() => setLogLines(['(Unable to load log file)']));
    } else {
      // Build log from SSE events for this story
      const storyEvents = sseEvents
        .filter((e) => e.story_id === storyId)
        .map((e) => `[${e.ts}] ${e.event_type}: ${e.payload || ''}`);
      setLogLines(storyEvents.length > 0 ? storyEvents.slice(-50) : ['(No log data available yet)']);
    }
  };

  // ─── Pause / Resume handler ──────────────────────────────────────────
  const [pauseLoading, setPauseLoading] = useState(false);

  const handlePauseResume = useCallback(async () => {
    if (!selectedRunId || !liveRun) return;
    const action = liveRun.status === 'paused' ? 'resume' : 'pause';
    setPauseLoading(true);
    try {
      await apiFetch(`/api/pipeline/runs/${selectedRunId}/${action}`, { method: 'POST' });
      // Re-fetch run detail and run list to pick up status change immediately
      const [detail, runList] = await Promise.all([
        apiFetch<{ run: PipelineRun; stories: StoryResult[] }>(`/api/pipeline/runs/${selectedRunId}`),
        apiFetch<{ items: PipelineRun[]; total: number; hasMore: boolean; cursor?: string }>(`/api/pipeline/runs?workspaceId=${workspaceId}`),
      ]);
      setSelectedRunDetail(detail);
      setRuns(runList.items);
    } catch (err) {
      console.error(`[Pipeline] ${action} failed:`, err);
    } finally {
      setPauseLoading(false);
    }
  }, [selectedRunId, liveRun, workspaceId]);

  // ─── Cancel handler ────────────────────────────────────────────────
  const [cancelLoading, setCancelLoading] = useState(false);

  const handleCancel = useCallback(async () => {
    if (!selectedRunId || !liveRun) return;
    setCancelLoading(true);
    try {
      await apiFetch(`/api/pipeline/runs/${selectedRunId}/cancel`, { method: 'POST' });
      const [detail, runList] = await Promise.all([
        apiFetch<{ run: PipelineRun; stories: StoryResult[] }>(`/api/pipeline/runs/${selectedRunId}`),
        apiFetch<{ items: PipelineRun[]; total: number; hasMore: boolean; cursor?: string }>(`/api/pipeline/runs?workspaceId=${workspaceId}`),
      ]);
      setSelectedRunDetail(detail);
      setRuns(runList.items);
    } catch (err) {
      console.error('[Pipeline] Cancel failed:', err);
    } finally {
      setCancelLoading(false);
    }
  }, [selectedRunId, liveRun, workspaceId]);

  // ─── Retry Failed handler ──────────────────────────────────────────
  const [retryLoading, setRetryLoading] = useState(false);

  const handleRetryFailed = useCallback(async () => {
    if (!selectedRunId || !liveRun) return;
    setRetryLoading(true);
    try {
      const result = await apiFetch<{ ok: boolean; runId: number }>(`/api/pipeline/runs/${selectedRunId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (result.ok && result.runId) {
        // Refresh run list and switch to the new retry run
        const runList = await apiFetch<{ items: PipelineRun[]; total: number; hasMore: boolean; cursor?: string }>(`/api/pipeline/runs?workspaceId=${workspaceId}`);
        setRuns(runList.items);
        setSelectedRunId(result.runId);
      }
    } catch (err) {
      console.error('[Pipeline] Retry failed:', err);
    } finally {
      setRetryLoading(false);
    }
  }, [selectedRunId, liveRun, workspaceId]);

  const handleCopyCommand = () => {
    const cmd = `./forge/run-loop.sh --json forge/specs/approved/<spec>.json`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ─── Priority update via API ────────────────────────────────────────────

  const getSpecId = useCallback(() => {
    if (!selectedRunDetail) return null;
    const specPath = selectedRunDetail.run.spec_path;
    const filename = specPath.split('/').pop() || '';
    return filename.replace(/\.json$/, '') || null;
  }, [selectedRunDetail]);

  const updateStoryPriority = useCallback(async (storyId: string, newPriority: number) => {
    const specId = getSpecId();
    if (!specId || !workspaceId) return;
    try {
      await apiFetch(`/api/specs/${specId}/stories/${storyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, priority: newPriority }),
      });
      // Refresh spec stories to pick up the change
      const data = await apiFetch<{ userStories?: SpecStory[] }>(`/api/specs/${specId}?workspaceId=${workspaceId}`);
      setSpecStories(data.userStories ?? []);
    } catch (err) {
      console.error('[Priority] Update failed:', err);
    }
  }, [getSpecId, workspaceId]);

  // ─── Drag-to-reorder handlers ──────────────────────────────────────────

  const handleDragStart = useCallback((storyId: string) => {
    dragSrcId.current = storyId;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, storyId: string) => {
    e.preventDefault();
    setDragOverId(storyId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback((targetStoryId: string) => {
    setDragOverId(null);
    const srcId = dragSrcId.current;
    dragSrcId.current = null;
    if (!srcId || srcId === targetStoryId) return;

    // Assign the dragged story the same priority as the drop target
    const targetStory = derivedStories.find(s => s.storyId === targetStoryId);
    if (!targetStory) return;
    updateStoryPriority(srcId, targetStory.priority);
  }, [derivedStories, updateStoryPriority]);

  // ─── Empty State ─────────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        Select a workspace to view pipeline runs.
      </div>
    );
  }

  if (runs.length === 0 && !selectedRunId) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-center max-w-md space-y-3">
          <Terminal className="w-10 h-10 mx-auto text-[var(--text-muted)]" />
          <p className="text-[var(--text-muted)] text-sm leading-relaxed">
            No pipeline runs yet. Approve a spec in Forge, then run it from the Pipeline.
          </p>
          <button
            onClick={() => setShowStartHelp(!showStartHelp)}
            className="px-3 py-1.5 text-xs font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded transition-colors"
          >
            <Play className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
            Start New Run
          </button>
          {showStartHelp && (
            <div className="mt-3 p-3 rounded bg-[var(--surface)] border border-[var(--border)] text-left">
              <p className="text-xs text-[var(--text-muted)] mb-2">
                Copy this command and paste it in your terminal:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-[var(--bg)] px-2 py-1 rounded text-[var(--text)]">
                  ./forge/run-loop.sh
                </code>
                <button
                  onClick={handleCopyCommand}
                  className="p-1 rounded hover:bg-[var(--border)] transition-colors"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
                </button>
              </div>
            </div>
          )}
        </div>

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
          <RunQueueSection
            entries={queueEntries}
            onRefresh={fetchQueue}
            onAddClick={() => setSpecPickerOpen(true)}
          />
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

  // ─── Main Layout ─────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full bg-bg">
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-2">
            <span className="font-medium text-[var(--text)] text-sm tracking-tight">
              Pipeline
            </span>
            <ChevronRight size={14} className="text-muted" />
            <span className="text-sm text-muted">Queue & Runs</span>
          </div>
        }
      />
      <div className="flex flex-1 min-h-0">
        {/* Left sidebar — Run history list */}
        <div className="w-60 border-r border-[var(--border)] flex flex-col">
          <div className="p-3 border-b border-[var(--border)] flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Runs
            </span>
            <button
              onClick={() => setShowStartHelp(!showStartHelp)}
              className="p-1 rounded hover:bg-[var(--border)] transition-colors"
              title="Start New Run"
            >
              <Play className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
          </div>

          {showStartHelp && (
            <div className="p-3 border-b border-[var(--border)] bg-[var(--surface)]">
              <p className="text-xs text-[var(--text-muted)] mb-2">
                Paste in terminal:
              </p>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 text-[10px] font-mono bg-[var(--bg)] px-1.5 py-1 rounded text-[var(--text)] truncate">
                  ./scripts/ralph/run-loop.sh
                </code>
                <button
                  onClick={handleCopyCommand}
                  className="p-0.5 rounded hover:bg-[var(--border)]"
                >
                  {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 text-[var(--text-muted)]" />}
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto min-h-0">
            {runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`w-full text-left px-3 py-2.5 border-b border-[var(--border)] transition-colors ${selectedRunId === run.id
                  ? 'bg-[var(--accent)]/10'
                  : 'hover:bg-[var(--surface)]'
                  }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOTS[run.status] || 'bg-zinc-500'}`} />
                  <span className="text-sm truncate capitalize">{specName(run.spec_path)}</span>
                  {run.retried_from_run_id != null && (
                    <span className="px-1 py-0.5 text-[9px] font-medium rounded bg-purple-500/20 text-purple-400 flex-shrink-0">
                      retry
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 pl-4">
                  <span className="text-xs text-[var(--text-muted)]">
                    {elapsedTime(run.started_at, run.finished_at)}
                  </span>
                  <AgentBadge agentType={run.agent_type} agentModel={run.agent_model} />
                </div>
              </button>
            ))}
          </div>

          {/* Queue section */}
          {(queueEntries.length > 0 || !runs.some((r) => r.status === 'running')) && (
            <div className="border-t border-[var(--border)] shrink-0">
              <div className="p-3 flex items-center justify-between">
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
                  className="p-1 rounded hover:bg-[var(--border)] transition-colors"
                  title="Add to Queue"
                >
                  <List className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                </button>
              </div>
              <RunQueueSection
                entries={queueEntries}
                onRefresh={fetchQueue}
                onAddClick={() => setSpecPickerOpen(true)}
              />
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

        {/* Main area — Selected run detail */}
        <div className="flex-1 flex flex-col min-w-0">
          {!liveRun ? (
            <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
              Select a run to view details
            </div>
          ) : (
            <>
              {/* Run header */}
              <div className="p-4 border-b border-[var(--border)]">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-medium capitalize">{specName(liveRun.spec_path)}</h2>
                  <span
                    className={`px-2 py-0.5 text-xs font-medium rounded-full ${liveRun.status === 'running'
                      ? 'bg-blue-500/20 text-blue-400'
                      : liveRun.status === 'done'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : liveRun.status === 'cancelled'
                          ? 'bg-gray-500/20 text-gray-400'
                          : liveRun.status === 'failed' || liveRun.status === 'partial_failure'
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-yellow-500/20 text-yellow-400'
                      }`}
                  >
                    {liveRun.status === 'partial_failure' ? 'partial failure' : liveRun.status}
                  </span>
                  <AgentBadge agentType={liveRun.agent_type} agentModel={liveRun.agent_model} size="md" />
                  {liveRun.retried_from_run_id != null && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-500/20 text-purple-400 flex items-center gap-1">
                      <RotateCcw className="w-3 h-3" />
                      retry of #{liveRun.retried_from_run_id}
                    </span>
                  )}
                  {selectedRunDetail?.runState?.resumedFromStory && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-500/20 text-amber-400 flex items-center gap-1">
                      <RefreshCw className="w-3 h-3" />
                      Resumed from {selectedRunDetail.runState.resumedFromStory}
                    </span>
                  )}
                  {(liveRun.status === 'failed' || liveRun.status === 'partial_failure') && (
                    <button
                      onClick={handleRetryFailed}
                      disabled={retryLoading}
                      className="ml-2 px-2.5 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 disabled:opacity-50"
                      title="Retry failed stories in a new run"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {retryLoading ? 'Retrying...' : 'Retry Failed'}
                    </button>
                  )}
                  {(liveRun.status === 'running' || liveRun.status === 'paused') && (
                    <button
                      onClick={handlePauseResume}
                      disabled={pauseLoading}
                      className={`ml-2 px-2.5 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 ${liveRun.status === 'paused'
                        ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                        : 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                        } disabled:opacity-50`}
                      title={liveRun.status === 'paused' ? 'Resume pipeline' : 'Pause pipeline'}
                    >
                      {liveRun.status === 'paused' ? (
                        <>
                          <Play className="w-3 h-3" />
                          Resume
                        </>
                      ) : (
                        <>
                          <Pause className="w-3 h-3" />
                          Pause
                        </>
                      )}
                    </button>
                  )}
                  {(liveRun.status === 'running' || liveRun.status === 'paused') && (
                    <button
                      onClick={handleCancel}
                      disabled={cancelLoading}
                      className="ml-2 px-2.5 py-1 text-xs font-medium rounded transition-colors flex items-center gap-1.5 bg-red-500/20 text-red-400 hover:bg-red-500/30 disabled:opacity-50"
                      title="Cancel pipeline run"
                    >
                      <XCircle className="w-3 h-3" />
                      {cancelLoading ? 'Cancelling...' : 'Cancel'}
                    </button>
                  )}
                </div>
                <div className="mt-1 text-xs text-[var(--text-muted)]">
                  Started {formatDistanceToNow(parseUtc(liveRun.started_at), { addSuffix: true })}
                  {(liveRun.status === 'running' || liveRun.status === 'paused') && (
                    <span> &middot; {liveRun.status === 'paused' ? 'paused' : 'running'} for {elapsedTime(liveRun.started_at, null)}</span>
                  )}
                </div>
              </div>

              {/* Tab bar: Stories | Terminal */}
              <div className="flex border-b border-[var(--border)] shrink-0">
                <button
                  onClick={() => setDetailTab('terminal')}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'terminal'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <Terminal className="w-3.5 h-3.5" />
                  Terminal
                </button>
                <button
                  onClick={() => setDetailTab('stories')}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'stories'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <List className="w-3.5 h-3.5" />
                  Stories
                  {totalCount > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--accent)]/15 text-[var(--accent)] font-semibold">
                      {completedCount}/{totalCount}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setDetailTab('graph')}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'graph'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  Graph
                </button>
                <button
                  onClick={() => setDetailTab('tokens')}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'tokens'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  Tokens
                  {tokenStats.warningStories.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/15 text-amber-400 font-semibold">
                      {tokenStats.warningStories.length}
                    </span>
                  )}
                </button>
                <button
                  onClick={() => setDetailTab('finops')}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'finops'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <DollarSign className="w-3.5 h-3.5" />
                  FinOps
                </button>
                <button
                  onClick={() => setDetailTab('run-info')}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'run-info'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <Info className="w-3.5 h-3.5" />
                  Run Info
                </button>
                <button
                  onClick={() => { setDetailTab('commits'); fetchCommits(); }}
                  className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === 'commits'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                    }`}
                >
                  <GitCommitHorizontal className="w-3.5 h-3.5" />
                  Commits
                  {commits.length > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-[var(--accent)]/15 text-[var(--accent)] font-semibold">
                      {commits.length}
                    </span>
                  )}
                </button>
              </div>

              {/* Terminal tab — xterm.js live output */}
              {detailTab === 'terminal' && (
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                  {selectedRunId && (
                    <div className="flex justify-end px-2 py-1 border-b border-[var(--border)] shrink-0">
                      <a
                        href={`${BASE_URL}/api/pipeline/runs/${selectedRunId}/log`}
                        download={`run-${selectedRunId}.log`}
                        className="flex items-center gap-1 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] rounded transition-colors hover:bg-[var(--surface-hover)]"
                        title="Download log file"
                      >
                        <Download className="w-3 h-3" />
                        Download Log
                      </a>
                    </div>
                  )}
                  <div className="flex-1 min-h-0 overflow-hidden">
                    {selectedRunId ? (
                      useMultiPane ? (
                        <MultiPaneTerminal key={selectedRunId} runId={selectedRunId} walEvents={sseEvents} />
                      ) : (
                        <RunTerminal key={selectedRunId} runId={selectedRunId} workspaceId={workspaceId} />
                      )
                    ) : (
                      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                        Select a run to view output
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Stories tab */}
              {detailTab === 'stories' && (
                <>
                  {/* Progress bar */}
                  {totalCount > 0 && (
                    <div className="px-4 py-2 border-b border-[var(--border)] shrink-0">
                      <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
                        <span className="inline-flex items-center gap-1">
                          {completedCount}/{totalCount} stories complete
                          <HelpTooltip helpKey="pipeline-parallelism" size={10} />
                        </span>
                        <span>{progressPct}%</span>
                      </div>
                      <div className="h-1.5 bg-[var(--border)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent)] rounded-full transition-all duration-300"
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex-1 overflow-y-auto">
                    {derivedStories.length === 0 ? (
                      <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                        Waiting for stories...
                      </div>
                    ) : (
                      derivedStories.map((story) => {
                        const pConfig = PRIORITY_CONFIG[story.priority] || PRIORITY_CONFIG[3];
                        const canDrag = story.status === 'pending';
                        return (
                          <div
                            key={story.storyId}
                            draggable={canDrag}
                            onDragStart={() => canDrag && handleDragStart(story.storyId)}
                            onDragOver={(e) => canDrag && handleDragOver(e, story.storyId)}
                            onDragLeave={handleDragLeave}
                            onDrop={() => handleDrop(story.storyId)}
                            onDragEnd={() => { dragSrcId.current = null; setDragOverId(null); }}
                            className={dragOverId === story.storyId ? 'border-t-2 border-[var(--accent)]' : ''}
                          >
                            <button
                              onClick={() => handleStoryExpand(story.storyId)}
                              className="w-full text-left px-4 py-2 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors flex items-center gap-2"
                            >
                              {canDrag && (
                                <GripVertical className="w-3 h-3 text-[var(--text-muted)] flex-shrink-0 cursor-grab opacity-40 hover:opacity-100" />
                              )}
                              <span className="w-4 text-center flex-shrink-0">
                                {expandedStory === story.storyId ? (
                                  <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                                ) : (
                                  <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                                )}
                              </span>
                              <span className="font-mono text-xs text-[var(--text-muted)] w-16 flex-shrink-0">
                                {story.storyId}
                              </span>
                              <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded border flex-shrink-0 ${pConfig.className}`}>
                                {pConfig.label}
                                <HelpTooltip helpKey="story-priority" size={9} />
                              </span>
                              <span className="w-5 text-center flex-shrink-0">{STORY_ICONS[story.status]}</span>
                              <span className="text-xs text-[var(--text-muted)] w-14 flex-shrink-0">
                                {story.status === 'skipped' ? 'pass' : story.status}
                              </span>
                              {story.escalation && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/15 text-amber-400 border border-amber-500/30 flex-shrink-0"
                                  title={`Escalated from ${story.escalation.fromTier} to ${story.escalation.toTier} (attempt ${story.escalation.attemptNumber})`}
                                >
                                  Escalated: {story.escalation.fromTier.charAt(0).toUpperCase() + story.escalation.fromTier.slice(1)}&rarr;{story.escalation.toTier.charAt(0).toUpperCase() + story.escalation.toTier.slice(1)}
                                </span>
                              )}
                              {story.reroute && (
                                <span
                                  className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 flex-shrink-0"
                                  title={`Rerouted from ${story.reroute.fromEngine} to ${story.reroute.toEngine} (${story.reroute.reason})`}
                                >
                                  Rerouted: {story.reroute.fromEngine.charAt(0).toUpperCase() + story.reroute.fromEngine.slice(1)}&rarr;{story.reroute.toEngine.charAt(0).toUpperCase() + story.reroute.toEngine.slice(1)} ({story.reroute.reason.replace('_', ' ')})
                                </span>
                              )}
                              <span className="text-xs font-mono text-[var(--text-muted)] w-16 flex-shrink-0 text-right">
                                {story.elapsed && `(${story.elapsed})`}
                              </span>
                              <span className="text-sm truncate min-w-0 flex-1">{story.title}</span>
                              {(story.inputTokens != null || story.outputTokens != null) && (
                                <span className="flex-shrink-0 w-36">
                                  <ContextBudgetBar
                                    inputTokens={story.inputTokens ?? 0}
                                    outputTokens={story.outputTokens ?? 0}
                                  />
                                </span>
                              )}
                            </button>

                            {/* Expanded log tail + token details */}
                            {expandedStory === story.storyId && (
                              <div className="border-b border-[var(--border)] bg-[var(--bg)]">
                                {(story.inputTokens != null || story.outputTokens != null) && (
                                  <div className="px-3 pt-3 pb-1 flex items-center gap-4 text-xs">
                                    <span className="text-[var(--text-muted)]">
                                      Input: <span className="font-mono text-[var(--text)]">{formatTokens(story.inputTokens ?? 0)}</span>
                                    </span>
                                    <span className="text-[var(--text-muted)]">
                                      Output: <span className="font-mono text-[var(--text)]">{formatTokens(story.outputTokens ?? 0)}</span>
                                    </span>
                                    <span className="text-[var(--text-muted)]">
                                      Total: <span className="font-mono text-[var(--text)]">{formatTokens((story.inputTokens ?? 0) + (story.outputTokens ?? 0))}</span>
                                    </span>
                                    <span className="text-[var(--text-muted)]">
                                      Context used: <span className={`font-mono ${((story.inputTokens ?? 0) + (story.outputTokens ?? 0)) / CONTEXT_WINDOW >= CONTEXT_WARNING_THRESHOLD
                                        ? 'text-amber-400' : 'text-[var(--text)]'
                                        }`}>
                                        {Math.round(((story.inputTokens ?? 0) + (story.outputTokens ?? 0)) / CONTEXT_WINDOW * 100)}%
                                      </span>
                                    </span>
                                    {((story.inputTokens ?? 0) + (story.outputTokens ?? 0)) / CONTEXT_WINDOW >= CONTEXT_WARNING_THRESHOLD && (
                                      <span className="flex items-center gap-1 text-amber-400">
                                        <AlertTriangle className="w-3 h-3" /> Near context limit
                                      </span>
                                    )}
                                  </div>
                                )}
                                <div className="max-h-64 overflow-y-auto p-3">
                                  <pre className="text-xs font-mono text-[var(--text-muted)] whitespace-pre-wrap break-all leading-relaxed">
                                    {logLines.length > 0 ? logLines.join('\n') : '(Loading...)'}
                                  </pre>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}

              {/* Graph tab — interactive DAG */}
              {detailTab === 'graph' && (
                <div className="flex-1 min-h-0 overflow-hidden">
                  {selectedSpecId && workspaceId ? (
                    <InteractiveDependencyGraph
                      specId={selectedSpecId}
                      workspaceId={workspaceId}
                      runId={selectedRunId ?? undefined}
                      liveStatuses={graphLiveStatuses}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                      Select a run to view its dependency graph
                    </div>
                  )}
                </div>
              )}

              {/* Tokens tab — token consumption summary */}
              {detailTab === 'tokens' && (
                <div className="flex-1 overflow-y-auto">
                  {!tokenStats.hasData ? (
                    <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                      No token usage data available for this run.
                    </div>
                  ) : (
                    <div className="p-4 space-y-4">
                      {/* Summary cards */}
                      <div className="grid grid-cols-4 gap-3">
                        <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
                          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Total Input</div>
                          <div className="text-lg font-mono font-medium">{formatTokens(tokenStats.totalInput)}</div>
                        </div>
                        <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
                          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Total Output</div>
                          <div className="text-lg font-mono font-medium">{formatTokens(tokenStats.totalOutput)}</div>
                        </div>
                        <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
                          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Combined</div>
                          <div className="text-lg font-mono font-medium">{formatTokens(tokenStats.totalInput + tokenStats.totalOutput)}</div>
                        </div>
                        <div className={`p-3 rounded-lg border ${tokenStats.warningStories.length > 0
                          ? 'bg-amber-500/10 border-amber-500/30'
                          : 'bg-[var(--surface)] border-[var(--border)]'
                          }`}>
                          <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Warnings</div>
                          <div className={`text-lg font-mono font-medium ${tokenStats.warningStories.length > 0 ? 'text-amber-400' : ''}`}>
                            {tokenStats.warningStories.length}
                          </div>
                        </div>
                      </div>

                      {/* Per-story token chart */}
                      <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
                        <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                          Token Consumption by Story
                        </div>
                        <div className="divide-y divide-[var(--border)]">
                          {tokenStats.storiesWithTokens
                            .sort((a, b) => ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0)))
                            .map((story) => {
                              const input = story.inputTokens ?? 0;
                              const output = story.outputTokens ?? 0;
                              const total = input + output;
                              const pct = (total / CONTEXT_WINDOW) * 100;
                              const isWarning = total / CONTEXT_WINDOW >= CONTEXT_WARNING_THRESHOLD;
                              const inputPct = total > 0 ? (input / CONTEXT_WINDOW) * 100 : 0;
                              const outputPct = total > 0 ? (output / CONTEXT_WINDOW) * 100 : 0;

                              return (
                                <div key={story.storyId} className="px-3 py-2.5">
                                  <div className="flex items-center justify-between mb-1.5">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="font-mono text-xs text-[var(--text-muted)]">{story.storyId}</span>
                                      <span className="text-xs truncate text-[var(--text)]">{story.title !== story.storyId ? story.title : ''}</span>
                                      {isWarning && <AlertTriangle className="w-3 h-3 text-amber-400 flex-shrink-0" />}
                                    </div>
                                    <div className="flex items-center gap-3 text-[10px] font-mono text-[var(--text-muted)] flex-shrink-0">
                                      <span>In: {formatTokens(input)}</span>
                                      <span>Out: {formatTokens(output)}</span>
                                      <span className={isWarning ? 'text-amber-400 font-semibold' : ''}>{Math.round(pct)}%</span>
                                    </div>
                                  </div>
                                  {/* Stacked bar: input (blue) + output (cyan) */}
                                  <div className="h-2 bg-[var(--border)] rounded-full overflow-hidden flex">
                                    <div
                                      className="h-full bg-blue-500 transition-all duration-300"
                                      style={{ width: `${Math.min(inputPct, 100)}%` }}
                                    />
                                    <div
                                      className={`h-full transition-all duration-300 ${isWarning ? 'bg-amber-500' : 'bg-cyan-500'}`}
                                      style={{ width: `${Math.min(outputPct, 100 - Math.min(inputPct, 100))}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                        </div>
                        {/* Legend */}
                        <div className="px-3 py-2 border-t border-[var(--border)] flex items-center gap-4 text-[10px] text-[var(--text-muted)]">
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-sm bg-blue-500" /> Input tokens
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-sm bg-cyan-500" /> Output tokens
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="w-2 h-2 rounded-sm bg-amber-500" /> Warning (&ge;80%)
                          </span>
                          <span className="ml-auto">Context window: {formatTokens(CONTEXT_WINDOW)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {/* FinOps tab — cost breakdown and savings */}
              {detailTab === 'finops' && (
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                  {selectedRunId ? (
                    <FinOpsTab runId={selectedRunId} />
                  ) : (
                    <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                      Select a run to view FinOps data
                    </div>
                  )}
                </div>
              )}

              {/* Run Info tab */}
              {detailTab === 'run-info' && (
                <div className="flex-1 min-h-0 overflow-y-auto">
                  {liveRun ? (
                    <RunMetadataPanel
                      run={{ ...liveRun, branch_name: liveRun.branch_name ?? null, worktree_path: liveRun.worktree_path ?? null }}
                      tokenSummary={{ inputTokens: tokenStats.totalInput, outputTokens: tokenStats.totalOutput }}
                      specModel={specModel}
                      totalStories={totalCount}
                      walEvents={sseEvents}
                    />
                  ) : (
                    <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                      Select a run to view run info
                    </div>
                  )}
                </div>
              )}

              {/* Commits tab */}
              {detailTab === 'commits' && (
                <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
                  {/* Header */}
                  <div className="shrink-0 px-4 py-2.5 border-b border-[var(--border)] bg-panel flex items-center justify-between">
                    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                      <GitBranch size={13} />
                      <span className="font-mono">{commitsBranch || 'default branch'}</span>
                      <span>{commits.length} commit{commits.length !== 1 ? 's' : ''}</span>
                    </div>
                    <button
                      onClick={fetchCommits}
                      className="p-1 rounded hover:bg-bg transition-colors text-[var(--text-muted)] hover:text-[var(--text)]"
                      title="Refresh commits"
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>
                  {/* Body */}
                  {commitsLoading ? (
                    <div className="flex-1 flex items-center justify-center gap-2 text-[var(--text-muted)] text-sm">
                      <Loader2 size={16} className="animate-spin" />
                      Loading commits...
                    </div>
                  ) : commits.length === 0 ? (
                    <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[var(--text-muted)]">
                      <GitCommitHorizontal size={32} className="opacity-30" />
                      <span className="text-sm">No commits yet</span>
                      <span className="text-xs opacity-70">Commits will appear here as stories complete.</span>
                      <button
                        onClick={fetchCommits}
                        className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-[var(--border)] hover:bg-panel transition-colors"
                      >
                        <RefreshCw size={12} />
                        Refresh
                      </button>
                    </div>
                  ) : (
                    <div className="flex-1 overflow-y-auto">
                      {commits.map((commit) => (
                        <div key={commit.sha} className="px-4 py-2.5 border-b border-[var(--border)] hover:bg-panel/50 transition-colors">
                          <div className="flex items-start gap-3">
                            <code className="text-xs font-mono text-[var(--accent)] shrink-0 mt-0.5">
                              {commit.sha.slice(0, 7)}
                            </code>
                            <div className="min-w-0 flex-1">
                              <p className="text-xs text-[var(--text)] truncate">{commit.message}</p>
                              <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                                {commit.author} · {commit.date}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
