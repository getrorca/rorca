import { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, XCircle, Clock, SkipForward, Loader2 } from 'lucide-react';
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

interface RunStoryListProps {
  runId: number;
  walEvents: WalEvent[];
}

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; label: string }> = {
  pass:     { icon: CheckCircle2, color: 'text-emerald-500', label: 'Passed' },
  fail:     { icon: XCircle,     color: 'text-red-500',     label: 'Failed' },
  skip:     { icon: SkipForward, color: 'text-gray-400',    label: 'Skipped' },
  excluded: { icon: SkipForward, color: 'text-gray-400',    label: 'Excluded' },
  running:  { icon: Loader2,     color: 'text-blue-500',    label: 'Running' },
  pending:  { icon: Clock,       color: 'text-muted',       label: 'Pending' },
  retry:    { icon: Loader2,     color: 'text-yellow-500',  label: 'Retrying' },
};

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export default function RunStoryList({ runId, walEvents }: RunStoryListProps) {
  const [stories, setStories] = useState<StoryResult[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchStories = useCallback(async () => {
    try {
      const data = await apiFetch<{ run: unknown; stories: StoryResult[] }>(`/api/pipeline/runs/${runId}`);
      setStories(data.stories);
    } catch { /* ignore */ }
    setLoading(false);
  }, [runId]);

  // Initial fetch
  useEffect(() => { fetchStories(); }, [fetchStories]);

  // Re-fetch when story-level WAL events arrive
  useEffect(() => {
    const storyEvents = walEvents.filter(e =>
      e.event_type === 'story_started' ||
      e.event_type === 'story_passed' ||
      e.event_type === 'story_failed' ||
      e.event_type === 'story_skipped'
    );
    if (storyEvents.length > 0) fetchStories();
  }, [walEvents, fetchStories]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 size={16} className="animate-spin text-muted" />
      </div>
    );
  }

  if (stories.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted px-4 text-center">
        No stories recorded yet. Stories appear as the run progresses.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-3 py-2 border-b border-border bg-panel">
        <span className="text-xs font-semibold text-muted uppercase tracking-wider">
          Stories ({stories.length})
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {stories.map((story) => {
          const cfg = STATUS_CONFIG[story.status] || STATUS_CONFIG.pending;
          const Icon = cfg.icon;
          const isAnimated = story.status === 'running' || story.status === 'retry';
          return (
            <div
              key={story.id}
              className="flex items-center gap-2 px-3 py-2 border-b border-border/50 hover:bg-bg/50 transition-colors"
            >
              <Icon
                size={14}
                className={`shrink-0 ${cfg.color} ${isAnimated ? 'animate-spin' : ''}`}
              />
              <span className="text-xs font-mono text-[var(--text)] truncate flex-1">
                {story.story_id}
              </span>
              {story.elapsed_seconds != null && (
                <span className="text-[10px] text-muted shrink-0">
                  {formatElapsed(story.elapsed_seconds)}
                </span>
              )}
              {story.retries != null && story.retries > 0 && (
                <span className="text-[10px] text-yellow-500 shrink-0">
                  R{story.retries}
                </span>
              )}
              <span className={`text-[10px] font-medium shrink-0 ${cfg.color}`}>
                {cfg.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
