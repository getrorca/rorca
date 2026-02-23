import { useState, useEffect, useMemo } from 'react';
import { Play, Terminal, ChevronDown, ChevronRight, Copy, Check, List } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE, WalEvent } from '../hooks/usePipelineSSE';
import { apiFetch } from '../lib/apiFetch';
import RunTerminal from '../components/RunTerminal';

type DetailTab = 'stories' | 'terminal';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: 'running' | 'paused' | 'done' | 'failed';
  pid: number | null;
  started_at: string;
  finished_at: string | null;
}

interface StoryResult {
  id: number;
  run_id: number;
  story_id: string;
  status: 'pass' | 'fail' | 'skip' | 'retry';
  retries: number;
  log_path: string | null;
  started_at: string;
  finished_at: string | null;
}

type StoryStatus = 'pending' | 'running' | 'pass' | 'fail' | 'retry';

interface DerivedStory {
  storyId: string;
  status: StoryStatus;
  title: string;
  elapsed: string;
  startedAt: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_DOTS: Record<string, string> = {
  running: 'bg-blue-500 animate-pulse',
  done: 'bg-emerald-500',
  failed: 'bg-red-500',
  paused: 'bg-yellow-500',
};

const STORY_ICONS: Record<StoryStatus, string> = {
  pass: '✅',
  fail: '❌',
  running: '🔄',
  pending: '⏳',
  retry: '🔁',
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
        });
        break;
      case 'story_passed':
        if (existing) {
          existing.status = 'pass';
          existing.elapsed = payload.elapsed || elapsedTime(existing.startedAt || e.ts, e.ts);
        } else {
          storyMap.set(e.story_id, {
            storyId: e.story_id,
            status: 'pass',
            title: payload.title || e.story_id,
            elapsed: payload.elapsed || '',
            startedAt: e.ts,
          });
        }
        break;
      case 'story_failed':
        if (existing) {
          existing.status = 'fail';
          existing.elapsed = payload.elapsed || elapsedTime(existing.startedAt || e.ts, e.ts);
        } else {
          storyMap.set(e.story_id, {
            storyId: e.story_id,
            status: 'fail',
            title: payload.title || e.story_id,
            elapsed: payload.elapsed || '',
            startedAt: e.ts,
          });
        }
        break;
      case 'story_retry':
        if (existing) {
          existing.status = 'retry';
        }
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
  } | null>(null);
  const [expandedStory, setExpandedStory] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [showStartHelp, setShowStartHelp] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('terminal');

  // SSE for live updates
  const sseEvents = usePipelineSSE(selectedRunId ? String(selectedRunId) : null);

  // Fetch run list on mount / workspace change
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ runs: PipelineRun[] }>(`/api/pipeline/runs?workspaceId=${workspaceId}`)
      .then((data) => {
        setRuns(data.runs);
        if (data.runs.length > 0 && !selectedRunId) {
          setSelectedRunId(data.runs[0].id);
        }
      })
      .catch(console.error);
  }, [workspaceId]);

  // Fetch run detail when selection changes
  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      return;
    }
    apiFetch<{ run: PipelineRun; stories: StoryResult[] }>(`/api/pipeline/runs/${selectedRunId}`)
      .then(setSelectedRunDetail)
      .catch(console.error);
  }, [selectedRunId]);

  // Derive live stories from SSE events, merged with DB story results
  const derivedStories = useMemo(() => {
    const fromDB: DerivedStory[] = (selectedRunDetail?.stories || []).map((s) => ({
      storyId: s.story_id,
      status: s.status === 'pass' ? 'pass' : s.status === 'fail' ? 'fail' : s.status === 'retry' ? 'retry' : 'pending' as StoryStatus,
      title: s.story_id,
      elapsed: elapsedTime(s.started_at, s.finished_at),
      startedAt: s.started_at,
    }));

    const fromSSE = deriveStoriesFromEvents(sseEvents);

    // Merge: SSE overrides DB for same storyId
    const merged = new Map<string, DerivedStory>();
    for (const s of fromDB) merged.set(s.storyId, s);
    for (const s of fromSSE) merged.set(s.storyId, s);

    return Array.from(merged.values());
  }, [selectedRunDetail, sseEvents]);

  const completedCount = derivedStories.filter((s) => s.status === 'pass' || s.status === 'fail').length;
  const totalCount = derivedStories.length;
  const progressPct = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  // Update selected run status from SSE
  const liveRun = useMemo(() => {
    if (!selectedRunDetail) return null;
    const runEvents = sseEvents.filter((e) => e.event_type === 'run_finished');
    if (runEvents.length > 0) {
      const payload = JSON.parse(runEvents[runEvents.length - 1].payload || '{}');
      return { ...selectedRunDetail.run, status: payload.status || 'done' as const, finished_at: runEvents[runEvents.length - 1].ts };
    }
    return selectedRunDetail.run;
  }, [selectedRunDetail, sseEvents]);

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

  const handleCopyCommand = () => {
    const cmd = `./scripts/ralph/run-loop.sh --json specs/approved/<spec>.json`;
    navigator.clipboard.writeText(cmd);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
      <div className="flex items-center justify-center h-full">
        <div className="text-center max-w-md space-y-3">
          <Terminal className="w-10 h-10 mx-auto text-[var(--text-muted)]" />
          <p className="text-[var(--text-muted)] text-sm leading-relaxed">
            No pipeline runs yet. Approve a spec in the Review Queue, then run it with the Ralph Loop.
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
                  ./scripts/ralph/run-loop.sh
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
      </div>
    );
  }

  // ─── Main Layout ─────────────────────────────────────────────────────────

  return (
    <div className="flex h-full">
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

        <div className="flex-1 overflow-y-auto">
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
              className={`w-full text-left px-3 py-2.5 border-b border-[var(--border)] transition-colors ${
                selectedRunId === run.id
                  ? 'bg-[var(--accent)]/10'
                  : 'hover:bg-[var(--surface)]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOTS[run.status] || 'bg-zinc-500'}`} />
                <span className="text-sm truncate capitalize">{specName(run.spec_path)}</span>
              </div>
              <div className="mt-1 text-xs text-[var(--text-muted)] pl-4">
                {elapsedTime(run.started_at, run.finished_at)}
              </div>
            </button>
          ))}
        </div>
      </div>

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
                  className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                    liveRun.status === 'running'
                      ? 'bg-blue-500/20 text-blue-400'
                      : liveRun.status === 'done'
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : liveRun.status === 'failed'
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-yellow-500/20 text-yellow-400'
                  }`}
                >
                  {liveRun.status}
                </span>
              </div>
              <div className="mt-1 text-xs text-[var(--text-muted)]">
                Started {formatDistanceToNow(parseUtc(liveRun.started_at), { addSuffix: true })}
                {liveRun.status === 'running' && (
                  <span> &middot; running for {elapsedTime(liveRun.started_at, null)}</span>
                )}
              </div>
            </div>

            {/* Tab bar: Stories | Terminal */}
            <div className="flex border-b border-[var(--border)] shrink-0">
              <button
                onClick={() => setDetailTab('terminal')}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  detailTab === 'terminal'
                    ? 'text-[var(--text)] border-[var(--accent)]'
                    : 'text-[var(--text-muted)] border-transparent hover:text-[var(--text)]'
                }`}
              >
                <Terminal className="w-3.5 h-3.5" />
                Terminal
              </button>
              <button
                onClick={() => setDetailTab('stories')}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  detailTab === 'stories'
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
            </div>

            {/* Terminal tab — xterm.js live output */}
            {detailTab === 'terminal' && (
              <div className="flex-1 min-h-0 overflow-hidden">
                {selectedRunId ? (
                  <RunTerminal key={selectedRunId} runId={selectedRunId} />
                ) : (
                  <div className="flex items-center justify-center h-full text-[var(--text-muted)] text-sm">
                    Select a run to view output
                  </div>
                )}
              </div>
            )}

            {/* Stories tab */}
            {detailTab === 'stories' && (
              <>
                {/* Progress bar */}
                {totalCount > 0 && (
                  <div className="px-4 py-2 border-b border-[var(--border)] shrink-0">
                    <div className="flex items-center justify-between text-xs text-[var(--text-muted)] mb-1">
                      <span>{completedCount}/{totalCount} stories complete</span>
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
                    derivedStories.map((story) => (
                      <div key={story.storyId}>
                        <button
                          onClick={() => handleStoryExpand(story.storyId)}
                          className="w-full text-left px-4 py-2 border-b border-[var(--border)] hover:bg-[var(--surface)] transition-colors flex items-center gap-3"
                        >
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
                          <span className="w-5 text-center flex-shrink-0">{STORY_ICONS[story.status]}</span>
                          <span className="text-xs text-[var(--text-muted)] w-14 flex-shrink-0">
                            {story.status}
                          </span>
                          <span className="text-xs font-mono text-[var(--text-muted)] w-16 flex-shrink-0 text-right">
                            {story.elapsed && `(${story.elapsed})`}
                          </span>
                          <span className="text-sm truncate min-w-0">{story.title}</span>
                        </button>

                        {/* Expanded log tail */}
                        {expandedStory === story.storyId && (
                          <div className="border-b border-[var(--border)] bg-[var(--bg)]">
                            <div className="max-h-64 overflow-y-auto p-3">
                              <pre className="text-xs font-mono text-[var(--text-muted)] whitespace-pre-wrap break-all leading-relaxed">
                                {logLines.length > 0 ? logLines.join('\n') : '(Loading...)'}
                              </pre>
                            </div>
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
