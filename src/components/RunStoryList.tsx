import { useState, useEffect, useCallback, useMemo } from 'react';
import { CheckCircle2, XCircle, Circle, SkipForward, Loader2 } from 'lucide-react';
import { apiFetch } from '../lib/apiFetch';
import type { WalEvent } from '../hooks/usePipelineSSE';

interface StoryResult {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  retries: number | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
}

interface SpecStory {
  id: string;
  title: string;
  dependsOn?: string[];
  passes?: boolean;
}

interface RunStoryListProps {
  runId: number;
  walEvents: WalEvent[];
  onStoryClick?: (storyId: string) => void;
}

type DerivedStatus = 'pending' | 'running' | 'pass' | 'fail' | 'excluded' | 'skip' | 'retry';

const STATUS_CONFIG: Record<DerivedStatus, { icon: typeof CheckCircle2; color: string; label: string; rowClass?: string }> = {
  pending:  { icon: Circle,       color: 'text-gray-400',    label: 'Pending' },
  running:  { icon: Loader2,      color: 'text-blue-500',    label: 'Running',  rowClass: 'border-l-2 border-l-blue-500 bg-blue-500/5' },
  pass:     { icon: CheckCircle2, color: 'text-emerald-500', label: 'Passed' },
  fail:     { icon: XCircle,      color: 'text-red-500',     label: 'Failed' },
  excluded: { icon: SkipForward,  color: 'text-gray-400',    label: 'Excluded' },
  skip:     { icon: SkipForward,  color: 'text-gray-400',    label: 'Skipped' },
  retry:    { icon: Loader2,      color: 'text-yellow-500',  label: 'Retrying', rowClass: 'border-l-2 border-l-yellow-500 bg-yellow-500/5' },
};

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export default function RunStoryList({ runId, walEvents, onStoryClick }: RunStoryListProps) {
  const [storyResults, setStoryResults] = useState<StoryResult[]>([]);
  const [specStories, setSpecStories] = useState<SpecStory[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const data = await apiFetch<{
        run: unknown;
        stories: StoryResult[];
        specStories?: SpecStory[];
      }>(`/api/pipeline/runs/${runId}`);
      setStoryResults(data.stories);
      if (data.specStories && data.specStories.length > 0) {
        setSpecStories(data.specStories);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [runId]);

  // Initial fetch
  useEffect(() => { fetchData(); }, [fetchData]);

  // Re-fetch when story-level WAL events arrive
  useEffect(() => {
    const storyEvents = walEvents.filter(e =>
      e.event_type === 'story_started' ||
      e.event_type === 'story_passed' ||
      e.event_type === 'story_failed' ||
      e.event_type === 'story_skipped'
    );
    if (storyEvents.length > 0) fetchData();
  }, [walEvents, fetchData]);

  // Build result lookup: story_id -> StoryResult
  const resultMap = useMemo(() => {
    const map = new Map<string, StoryResult>();
    for (const r of storyResults) map.set(r.story_id, r);
    return map;
  }, [storyResults]);

  // Build SSE-derived running state (story_started without a subsequent pass/fail)
  const runningStoryId = useMemo(() => {
    let current: string | null = null;
    for (const evt of walEvents) {
      if (evt.event_type === 'story_started') current = evt.story_id;
      else if (
        (evt.event_type === 'story_passed' || evt.event_type === 'story_failed' || evt.event_type === 'story_skipped') &&
        evt.story_id === current
      ) {
        current = null;
      }
    }
    return current;
  }, [walEvents]);

  // Merge spec stories with results to derive status
  const mergedStories = useMemo(() => {
    // If we have spec stories, use them as the canonical list
    const source: SpecStory[] = specStories.length > 0
      ? specStories
      : storyResults.map(r => ({ id: r.story_id, title: r.story_id }));

    return source.map((spec) => {
      const result = resultMap.get(spec.id);
      let status: DerivedStatus = 'pending';

      if (spec.passes === true && (!result || result.status === 'skip')) {
        // Already passed before this run (excluded from execution)
        // result.status === 'skip' covers the backfill inserted on re-trigger
        status = 'excluded';
      } else if (result) {
        if (result.status === 'pass') status = 'pass';
        else if (result.status === 'fail') status = 'fail';
        else if (result.status === 'skip') status = 'skip';
        else if (result.status === 'retry') status = 'retry';
        else status = result.status as DerivedStatus;
      }

      // SSE override: if this story is currently running (started but no result yet)
      if (runningStoryId === spec.id && (!result || result.status === 'retry')) {
        status = 'running';
      }

      return {
        storyId: spec.id,
        title: spec.title,
        status,
        elapsed: result?.elapsed_seconds ?? null,
        retries: result?.retries ?? null,
      };
    });
  }, [specStories, storyResults, resultMap, runningStoryId]);

  // Counts
  const counts = useMemo(() => {
    let passed = 0, failed = 0, total = mergedStories.length;
    for (const s of mergedStories) {
      if (s.status === 'pass') passed++;
      else if (s.status === 'fail') failed++;
    }
    return { passed, failed, total };
  }, [mergedStories]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted" />
      </div>
    );
  }

  if (mergedStories.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted px-4 text-center">
        No stories recorded yet. Stories appear as the run progresses.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-border bg-panel">
        <span className="text-xs font-semibold text-muted uppercase tracking-wider">
          Stories ({counts.total})
        </span>
      </div>

      {/* Story list */}
      <div className="flex-1 overflow-y-auto">
        {mergedStories.map((story) => {
          const cfg = STATUS_CONFIG[story.status] || STATUS_CONFIG.pending;
          const Icon = cfg.icon;
          const isAnimated = story.status === 'running' || story.status === 'retry';
          const isExcluded = story.status === 'excluded';
          const isClickable = !!onStoryClick;

          return (
            <div
              key={story.storyId}
              onClick={isClickable ? () => onStoryClick!(story.storyId) : undefined}
              className={`flex items-center gap-2 px-3 py-2 border-b border-border/50 transition-colors ${
                cfg.rowClass || ''
              } ${isClickable ? 'cursor-pointer hover:bg-bg/50' : ''}`}
            >
              <Icon
                size={14}
                className={`shrink-0 ${cfg.color} ${isAnimated ? 'animate-spin' : ''}`}
              />
              <span className={`text-[11px] font-mono font-semibold shrink-0 px-1 py-0.5 rounded ${
                story.status === 'running' ? 'bg-blue-500/10 text-blue-500' :
                story.status === 'pass' ? 'bg-emerald-500/10 text-emerald-500' :
                story.status === 'fail' ? 'bg-red-500/10 text-red-500' :
                'bg-bg text-muted'
              }`}>
                {story.storyId}
              </span>
              <span className={`text-xs truncate flex-1 ${
                isExcluded ? 'line-through text-muted' : 'text-[var(--text)]'
              }`}>
                {story.title}
              </span>
              {story.elapsed != null && (
                <span className="text-[10px] text-muted shrink-0">
                  {formatElapsed(story.elapsed)}
                </span>
              )}
              {story.retries != null && story.retries > 0 && (
                <span className="text-[10px] text-yellow-500 shrink-0">
                  R{story.retries}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Summary footer */}
      <div className="shrink-0 px-3 py-2 border-t border-border bg-panel flex items-center gap-3">
        <span className="text-[11px] font-medium text-emerald-500">
          {counts.passed} passed
        </span>
        <span className="text-[11px] font-medium text-red-500">
          {counts.failed} failed
        </span>
        <span className="text-[11px] text-muted ml-auto">
          {counts.passed + counts.failed} / {counts.total}
        </span>
      </div>
    </div>
  );
}
