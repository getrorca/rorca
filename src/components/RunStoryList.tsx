import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CheckCircle2, XCircle, Circle, SkipForward, Loader2, ChevronDown, ChevronRight, GitMerge, Layers, Clock } from 'lucide-react';
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
  parallelism?: number;
}

type DerivedStatus = 'pending' | 'running' | 'pass' | 'fail' | 'excluded' | 'skip' | 'retry' | 'rate_limited';

const STATUS_CONFIG: Record<DerivedStatus, { icon: typeof CheckCircle2; color: string; label: string; rowClass?: string }> = {
  pending:      { icon: Circle,       color: 'text-gray-400',    label: 'Pending' },
  running:      { icon: Loader2,      color: 'text-blue-500',    label: 'Running',      rowClass: 'border-l-2 border-l-blue-500 bg-blue-500/5' },
  pass:         { icon: CheckCircle2, color: 'text-emerald-500', label: 'Passed' },
  fail:         { icon: XCircle,      color: 'text-red-500',     label: 'Failed',       rowClass: 'border-l-2 border-l-red-500 bg-red-500/5' },
  excluded:     { icon: SkipForward,  color: 'text-gray-400',    label: 'Excluded' },
  skip:         { icon: SkipForward,  color: 'text-gray-400',    label: 'Skipped' },
  retry:        { icon: Loader2,      color: 'text-yellow-500',  label: 'Retrying',     rowClass: 'border-l-2 border-l-yellow-500 bg-yellow-500/5' },
  rate_limited: { icon: Clock,        color: 'text-amber-500',   label: 'Rate limited', rowClass: 'border-l-2 border-l-amber-500 bg-amber-500/5' },
};

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

// ─── Wave compilation (Kahn's topological sort) ──────────────────────────────

interface CompiledWave {
  index: number;
  storyIds: string[];
}

function compileWavesFromStories(stories: SpecStory[]): CompiledWave[] {
  const passedIds = new Set(stories.filter(s => s.passes).map(s => s.id));
  const pending = stories.filter(s => !s.passes);
  if (pending.length === 0) return [];

  const pendingIds = new Set(pending.map(s => s.id));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const s of pending) {
    inDegree.set(s.id, 0);
    dependents.set(s.id, []);
  }

  for (const s of pending) {
    let count = 0;
    for (const dep of s.dependsOn ?? []) {
      if (pendingIds.has(dep) && !passedIds.has(dep)) {
        count++;
        dependents.get(dep)!.push(s.id);
      }
    }
    inDegree.set(s.id, count);
  }

  const waves: CompiledWave[] = [];
  let queue = pending.filter(s => inDegree.get(s.id) === 0).map(s => s.id);

  while (queue.length > 0) {
    waves.push({ index: waves.length, storyIds: queue });
    const nextQueue: string[] = [];
    for (const id of queue) {
      for (const depId of dependents.get(id) ?? []) {
        const newDeg = inDegree.get(depId)! - 1;
        inDegree.set(depId, newDeg);
        if (newDeg === 0) nextQueue.push(depId);
      }
    }
    queue = nextQueue;
  }

  return waves;
}

// ─── Wave status types ───────────────────────────────────────────────────────

type WaveStatus = 'waiting' | 'running' | 'merging' | 'done' | 'partial-fail';

const WAVE_STATUS_STYLES: Record<WaveStatus, { bg: string; text: string; label: string }> = {
  waiting:        { bg: 'bg-gray-500/10',    text: 'text-gray-400',    label: 'Waiting' },
  running:        { bg: 'bg-blue-500/10',    text: 'text-blue-500',    label: 'Running' },
  merging:        { bg: 'bg-purple-500/10',  text: 'text-purple-500',  label: 'Merging...' },
  done:           { bg: 'bg-emerald-500/10', text: 'text-emerald-500', label: 'Done' },
  'partial-fail': { bg: 'bg-orange-500/10',  text: 'text-orange-500',  label: 'Partial fail' },
};

// ─── Merged story type ───────────────────────────────────────────────────────

interface MergedStory {
  storyId: string;
  title: string;
  status: DerivedStatus;
  elapsed: number | null;
  retries: number | null;
  startedAt: number | null; // epoch ms for live timer
  rateLimitRetryAt: number | null; // epoch ms when rate limit backoff expires
  rateLimitAttempt: number | null;
}

// ─── Live elapsed timer ──────────────────────────────────────────────────────

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.round((now - startedAt) / 1000);
  return <span className="text-[10px] text-blue-400 shrink-0">{formatElapsed(seconds)}</span>;
}

// ─── Rate limit countdown timer ──────────────────────────────────────────────

function RateLimitCountdown({ retryAt }: { retryAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = Math.max(0, retryAt - now);
  const seconds = Math.ceil(remainingMs / 1000);
  return (
    <span className="text-[10px] text-amber-500 shrink-0">
      Rate limited — retry in {seconds}s
    </span>
  );
}

// ─── Story row component ─────────────────────────────────────────────────────

function StoryRow({ story, onStoryClick, indented }: {
  story: MergedStory;
  onStoryClick?: (storyId: string) => void;
  indented?: boolean;
}) {
  const cfg = STATUS_CONFIG[story.status] || STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  const isAnimated = story.status === 'running' || story.status === 'retry';
  const isExcluded = story.status === 'excluded';
  const isClickable = !!onStoryClick;

  // Track status transitions — animate only when status *changes* to pass
  const prevStatusRef = useRef<DerivedStatus>(story.status);
  const [justPassed, setJustPassed] = useState(false);

  useEffect(() => {
    if (story.status === 'pass' && prevStatusRef.current !== 'pass') {
      setJustPassed(true);
      const timer = setTimeout(() => setJustPassed(false), 600);
      return () => clearTimeout(timer);
    }
    prevStatusRef.current = story.status;
  }, [story.status]);

  return (
    <div
      onClick={isClickable ? () => onStoryClick!(story.storyId) : undefined}
      className={`flex items-center gap-2 ${indented ? 'pl-6 pr-3' : 'px-3'} py-2 border-b border-border/50 transition-colors ${
        cfg.rowClass || ''
      } ${isClickable ? 'cursor-pointer hover:bg-bg/50' : ''} ${justPassed ? 'animate-story-pass' : ''}`}
    >
      <Icon
        size={14}
        className={`shrink-0 ${cfg.color} ${isAnimated ? 'animate-spin' : ''} ${justPassed ? 'animate-checkmark-pop' : ''}`}
      />
      <span className={`text-[11px] font-mono font-semibold shrink-0 px-1 py-0.5 rounded ${
        story.status === 'running' ? 'bg-blue-500/10 text-blue-500' :
        story.status === 'pass' ? 'bg-emerald-500/10 text-emerald-500' :
        story.status === 'fail' ? 'bg-red-500/10 text-red-500' :
        story.status === 'rate_limited' ? 'bg-amber-500/10 text-amber-500' :
        'bg-bg text-muted'
      }`}>
        {story.storyId}
      </span>
      <span className={`text-xs truncate flex-1 ${
        isExcluded ? 'line-through text-muted' : 'text-[var(--text)]'
      }`}>
        {story.title}
      </span>
      {/* Rate limit countdown */}
      {story.status === 'rate_limited' && story.rateLimitRetryAt != null && (
        <RateLimitCountdown retryAt={story.rateLimitRetryAt} />
      )}
      {/* Live elapsed timer for running stories */}
      {story.status === 'running' && story.startedAt != null && (
        <LiveElapsed startedAt={story.startedAt} />
      )}
      {/* Static elapsed for completed stories */}
      {story.status !== 'running' && story.status !== 'rate_limited' && story.elapsed != null && (
        <span className="text-[10px] text-muted shrink-0">
          {formatElapsed(story.elapsed)}
        </span>
      )}
      {story.retries != null && story.retries > 0 && (
        <span className="text-[10px] text-yellow-500 shrink-0">
          R{story.retries}
        </span>
      )}
      {story.rateLimitAttempt != null && story.rateLimitAttempt > 0 && (
        <span className="text-[10px] text-amber-500 shrink-0">
          RL{story.rateLimitAttempt}
        </span>
      )}
    </div>
  );
}

// ─── Wave header component ───────────────────────────────────────────────────

function WaveHeader({ waveIndex, storyCount, waveStatus, expanded, onToggle, counts }: {
  waveIndex: number;
  storyCount: number;
  waveStatus: WaveStatus;
  expanded: boolean;
  onToggle: () => void;
  counts: { passed: number; failed: number };
}) {
  const style = WAVE_STATUS_STYLES[waveStatus];
  const isActive = waveStatus === 'running';
  const isMerging = waveStatus === 'merging';

  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center gap-2 px-3 py-2 border-b border-border bg-panel/80 hover:bg-panel transition-all ${
        isActive ? 'animate-[wave-pulse_2s_ease-in-out_1]' : ''
      }`}
    >
      {expanded ? (
        <ChevronDown size={12} className="text-muted shrink-0" />
      ) : (
        <ChevronRight size={12} className="text-muted shrink-0" />
      )}
      <Layers size={12} className="text-purple-400 shrink-0" />
      <span className="text-[11px] font-semibold text-[var(--text)]">
        Wave {waveIndex}
      </span>
      <span className="text-[10px] text-muted">
        {storyCount} {storyCount === 1 ? 'story' : 'stories'}
      </span>

      {/* Status chip */}
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded ${style.bg} ${style.text}`}>
        {isMerging && <GitMerge size={10} className="animate-spin" />}
        {isActive && <Loader2 size={10} className="animate-spin" />}
        {style.label}
      </span>

      {/* Story count breakdown for done/partial-fail */}
      {(waveStatus === 'done' || waveStatus === 'partial-fail') && (
        <span className="text-[10px] text-muted ml-auto">
          <span className="text-emerald-500">{counts.passed}</span>
          {counts.failed > 0 && (
            <> / <span className="text-red-500">{counts.failed}F</span></>
          )}
        </span>
      )}
    </button>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function RunStoryList({ runId, walEvents, onStoryClick, parallelism }: RunStoryListProps) {
  const [storyResults, setStoryResults] = useState<StoryResult[]>([]);
  const [specStories, setSpecStories] = useState<SpecStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedWaves, setCollapsedWaves] = useState<Set<number>>(new Set());

  const isWaveMode = (parallelism ?? 1) > 1;

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

  // Re-fetch when story-level or wave-level WAL events arrive
  useEffect(() => {
    const relevant = walEvents.filter(e =>
      e.event_type === 'story_started' ||
      e.event_type === 'story_passed' ||
      e.event_type === 'story_failed' ||
      e.event_type === 'story_skipped' ||
      e.event_type === 'story_rate_limited' ||
      e.event_type === 'wave_merged'
    );
    if (relevant.length > 0) fetchData();
  }, [walEvents, fetchData]);

  // Build result lookup: story_id -> StoryResult
  const resultMap = useMemo(() => {
    const map = new Map<string, StoryResult>();
    for (const r of storyResults) map.set(r.story_id, r);
    return map;
  }, [storyResults]);

  // Build SSE-derived running stories (all concurrently running in wave mode)
  const runningStoryIds = useMemo(() => {
    const running = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started') {
        running.add(evt.story_id);
      } else if (
        evt.event_type === 'story_passed' ||
        evt.event_type === 'story_failed' ||
        evt.event_type === 'story_skipped' ||
        evt.event_type === 'story_rate_limited'
      ) {
        running.delete(evt.story_id);
      }
    }
    return running;
  }, [walEvents]);

  // Build SSE-derived started-at timestamps for live elapsed
  const storyStartTimes = useMemo(() => {
    const map = new Map<string, number>();
    for (const evt of walEvents) {
      if (evt.event_type === 'story_started' && evt.story_id) {
        map.set(evt.story_id, new Date(evt.ts).getTime());
      }
    }
    return map;
  }, [walEvents]);

  // Track rate-limited stories: storyId -> { retryAt (epoch ms), attempt }
  const rateLimitedStories = useMemo(() => {
    const map = new Map<string, { retryAt: number; attempt: number }>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_rate_limited' && evt.payload) {
        try {
          const payload = JSON.parse(evt.payload);
          const retryAfterMs = typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : 30000;
          const attempt = typeof payload.attempt === 'number' ? payload.attempt : 1;
          const eventTime = new Date(evt.ts).getTime();
          map.set(evt.story_id, { retryAt: eventTime + retryAfterMs, attempt });
        } catch { /* ignore */ }
      } else if (evt.event_type === 'story_started') {
        // Story re-started after backoff — no longer rate limited
        map.delete(evt.story_id);
      } else if (evt.event_type === 'story_passed' || evt.event_type === 'story_failed') {
        map.delete(evt.story_id);
      }
    }
    return map;
  }, [walEvents]);

  // Track which waves have been merged (from wave_merged WAL events)
  const mergedWaveIndices = useMemo(() => {
    const set = new Set<number>();
    for (const evt of walEvents) {
      if (evt.event_type === 'wave_merged' && evt.payload) {
        try {
          const payload = JSON.parse(evt.payload);
          if (typeof payload.wave === 'number') set.add(payload.wave);
        } catch { /* ignore */ }
      }
    }
    return set;
  }, [walEvents]);

  // Merge spec stories with results to derive status
  const mergedStories = useMemo(() => {
    const source: SpecStory[] = specStories.length > 0
      ? specStories
      : storyResults.map(r => ({ id: r.story_id, title: r.story_id }));

    return source.map((spec): MergedStory => {
      const result = resultMap.get(spec.id);
      let status: DerivedStatus = 'pending';

      if (spec.passes === true && (!result || result.status === 'skip')) {
        status = 'excluded';
      } else if (result) {
        if (result.status === 'pass') status = 'pass';
        else if (result.status === 'fail') status = 'fail';
        else if (result.status === 'skip') status = 'skip';
        else if (result.status === 'retry') status = 'retry';
        else status = result.status as DerivedStatus;
      }

      // SSE override: if this story is currently rate limited
      const rlInfo = rateLimitedStories.get(spec.id);
      if (rlInfo) {
        status = 'rate_limited';
      }

      // SSE override: if this story is currently running
      if (runningStoryIds.has(spec.id) && (!result || result.status === 'retry')) {
        status = 'running';
      }

      return {
        storyId: spec.id,
        title: spec.title,
        status,
        elapsed: result?.elapsed_seconds ?? null,
        retries: result?.retries ?? null,
        startedAt: storyStartTimes.get(spec.id) ?? null,
        rateLimitRetryAt: rlInfo?.retryAt ?? null,
        rateLimitAttempt: rlInfo?.attempt ?? null,
      };
    });
  }, [specStories, storyResults, resultMap, runningStoryIds, storyStartTimes, rateLimitedStories]);

  // Build merged story lookup
  const mergedMap = useMemo(() => {
    const map = new Map<string, MergedStory>();
    for (const s of mergedStories) map.set(s.storyId, s);
    return map;
  }, [mergedStories]);

  // Compile waves from spec stories
  const waves = useMemo(() => {
    if (!isWaveMode || specStories.length === 0) return null;
    return compileWavesFromStories(specStories);
  }, [isWaveMode, specStories]);

  // Derive wave status for each wave
  const waveStatuses = useMemo(() => {
    if (!waves) return new Map<number, { status: WaveStatus; passed: number; failed: number }>();
    const map = new Map<number, { status: WaveStatus; passed: number; failed: number }>();

    for (const wave of waves) {
      const stories = wave.storyIds.map(id => mergedMap.get(id)).filter(Boolean) as MergedStory[];
      let passed = 0, failed = 0, running = 0, pending = 0;

      for (const s of stories) {
        if (s.status === 'pass' || s.status === 'excluded') passed++;
        else if (s.status === 'fail' || s.status === 'skip') failed++;
        else if (s.status === 'running' || s.status === 'retry' || s.status === 'rate_limited') running++;
        else pending++;
      }

      let waveStatus: WaveStatus = 'waiting';
      const isMerged = mergedWaveIndices.has(wave.index);

      if (isMerged) {
        // Wave has been merged
        waveStatus = failed > 0 ? 'partial-fail' : 'done';
      } else if (running > 0) {
        waveStatus = 'running';
      } else if (passed + failed === stories.length && stories.length > 0 && (passed > 0 || failed > 0)) {
        // All stories settled but not yet merged
        waveStatus = 'merging';
      } else if (passed > 0 || failed > 0) {
        // Some settled, some still pending/running
        waveStatus = 'running';
      }

      map.set(wave.index, { status: waveStatus, passed, failed });
    }

    return map;
  }, [waves, mergedMap, mergedWaveIndices]);

  // Auto-collapse completed waves, expand active
  useEffect(() => {
    if (!waves) return;
    const newCollapsed = new Set<number>();
    for (const wave of waves) {
      const ws = waveStatuses.get(wave.index);
      if (ws && (ws.status === 'done' || ws.status === 'partial-fail')) {
        newCollapsed.add(wave.index);
      }
    }
    setCollapsedWaves(newCollapsed);
  }, [waves, waveStatuses]);

  const toggleWave = useCallback((index: number) => {
    setCollapsedWaves(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

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

  // ─── Wave-grouped layout ────────────────────────────────────────────────────
  if (isWaveMode && waves && waves.length > 0) {
    // Collect excluded stories (pre-passed, not in any wave)
    const waveCoveredIds = new Set(waves.flatMap(w => w.storyIds));
    const excludedStories = mergedStories.filter(s => !waveCoveredIds.has(s.storyId));

    return (
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="shrink-0 px-3 py-2 border-b border-border bg-panel flex items-center gap-2">
          <Layers size={12} className="text-purple-400" />
          <span className="text-xs font-semibold text-muted uppercase tracking-wider">
            Stories ({counts.total})
          </span>
          <span className="text-[10px] text-muted ml-auto">
            {waves.length} {waves.length === 1 ? 'wave' : 'waves'}
          </span>
        </div>

        {/* Wave groups */}
        <div className="flex-1 overflow-y-auto">
          {/* Excluded stories (pre-passed) shown first if any */}
          {excludedStories.length > 0 && (
            <>
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-panel/50">
                <SkipForward size={10} className="text-gray-400" />
                <span className="text-[10px] font-medium text-muted">
                  {excludedStories.length} pre-passed
                </span>
              </div>
              {excludedStories.map(story => (
                <StoryRow key={story.storyId} story={story} onStoryClick={onStoryClick} indented />
              ))}
            </>
          )}

          {waves.map((wave) => {
            const ws = waveStatuses.get(wave.index) ?? { status: 'waiting' as WaveStatus, passed: 0, failed: 0 };
            const expanded = !collapsedWaves.has(wave.index);
            const waveStories = wave.storyIds
              .map(id => mergedMap.get(id))
              .filter(Boolean) as MergedStory[];

            return (
              <div key={wave.index}>
                <WaveHeader
                  waveIndex={wave.index}
                  storyCount={wave.storyIds.length}
                  waveStatus={ws.status}
                  expanded={expanded}
                  onToggle={() => toggleWave(wave.index)}
                  counts={{ passed: ws.passed, failed: ws.failed }}
                />
                {expanded && waveStories.map(story => (
                  <StoryRow
                    key={story.storyId}
                    story={story}
                    onStoryClick={onStoryClick}
                    indented
                  />
                ))}
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

  // ─── Sequential (flat) layout ──────────────────────────────────────────────
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
        {mergedStories.map((story) => (
          <StoryRow key={story.storyId} story={story} onStoryClick={onStoryClick} />
        ))}
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
