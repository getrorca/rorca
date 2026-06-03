/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CheckCircle2, XCircle, Circle, SkipForward, Loader2, ChevronDown, ChevronRight, GitMerge, Layers, Clock, RotateCcw, Ban, FileText, Share2, Globe, Sparkles, Files, Cpu } from 'lucide-react';
import { Github } from './icons/GithubIcon';
import { apiFetch } from '../lib/apiFetch';
import { fetchStoryOutput, retryRun } from '../api/pipeline';
import type { WalEvent } from '../hooks/usePipelineSSE';

/** Safely parse a WAL event payload string into an object. Returns null if unparseable. */
function parsePayload(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    return typeof payload === 'string' ? JSON.parse(payload) : (payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

interface StoryResult {
  id: number;
  run_id: number;
  story_id: string;
  status: string;
  retries: number | null;
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
  blocked_by: string | null; // JSON array of upstream story IDs
  log_path: string | null;
}

interface SpecStory {
  id: string;
  title: string;
  dependsOn?: string[];
  passes?: boolean;
}

/** CTM-004: Per-story context usage surfaced in the Stories accordion. */
export interface StoryContextSkill {
  name: string;
  relevance?: number | null;
  reason?: string | null;
}

export interface StoryContextInfo {
  skills: StoryContextSkill[];
  contextFiles: string[];
  inputTokens: number;
  outputTokens: number;
}

interface RunStateStoryEntry {
  storyId: string;
  title: string;
  status: 'passed' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string;
  agentType: string;
  model?: string;
  retries?: number;
  elapsedMs?: number;
  failReason?: string;
}

interface RunStateSnapshot {
  specId: string;
  runId: number;
  startedAt: string;
  lastUpdatedAt: string;
  completedStories: RunStateStoryEntry[];
  failedStories: RunStateStoryEntry[];
  skippedStories: RunStateStoryEntry[];
  currentStory: string | null;
  resumedFromStory?: string | null;
}

interface ResumeSummary {
  continueFromId: string | null;
  resumedAfterId: string | null;
  carriedForwardCount: number;
}

interface RunStoryListProps {
  runId: number;
  walEvents: WalEvent[];
  runState?: RunStateSnapshot | null;
  resumeSummary?: ResumeSummary | null;
  onStoryClick?: (storyId: string) => void;
  onRetryStory?: (storyId: string, newRunId: number) => void;
  parallelism?: number;
  includeGraph?: boolean;
  /**
   * CTM-004: Per-story context usage (skills, injected files, tokens), keyed by
   * story ID. Optional — older runs without this data simply omit the accordion.
   */
  storyContext?: Map<string, StoryContextInfo>;
}

type DerivedStatus = 'pending' | 'running' | 'pass' | 'fail' | 'blocked' | 'excluded' | 'skip' | 'retry' | 'rate_limited';

const STATUS_CONFIG: Record<DerivedStatus, { icon: typeof CheckCircle2; color: string; label: string; rowClass?: string }> = {
  pending:      { icon: Circle,       color: 'text-gray-400',    label: 'Pending' },
  running:      { icon: Loader2,      color: 'text-emerald-500', label: 'Running',      rowClass: 'border-l-2 border-l-emerald-500 bg-emerald-500/5' },
  pass:         { icon: CheckCircle2, color: 'text-emerald-500', label: 'Passed' },
  fail:         { icon: XCircle,      color: 'text-red-500',     label: 'Failed',       rowClass: 'border-l-2 border-l-red-500 bg-red-500/5' },
  blocked:      { icon: Ban,          color: 'text-gray-400',    label: 'Blocked',      rowClass: 'border-l-2 border-l-gray-400 bg-gray-500/5' },
  excluded:     { icon: SkipForward,  color: 'text-gray-400',    label: 'Excluded' },
  skip:         { icon: SkipForward,  color: 'text-gray-400',    label: 'Skipped' },
  retry:        { icon: Loader2,      color: 'text-yellow-500',  label: 'Retrying',     rowClass: 'border-l-2 border-l-yellow-500 bg-yellow-500/5' },
  rate_limited: { icon: Clock,        color: 'text-amber-500',   label: 'Rate limited', rowClass: 'border-l-2 border-l-amber-500 bg-amber-500/5' },
};

const ROW_HEIGHT = 48;

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
  blockedBy: string[] | null; // upstream story IDs that caused this story to be blocked
  githubStatusPending: boolean; // US-027: true when commit status is being posted to GitHub
  prSyncPending: boolean; // US-034: true transiently when PR body is being updated
  graphHits: number | null; // US-007: graph node hit count from WAL event payload
  browserMcp: boolean; // BMC-005: true when story_started WAL event has browser_mcp: true
}

// ─── Live elapsed timer ──────────────────────────────────────────────────────

function LiveElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.round((now - startedAt) / 1000);
  return <span className="text-[10px] text-emerald-400 shrink-0">{formatElapsed(seconds)}</span>;
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

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

// ─── Story row component ─────────────────────────────────────────────────────

function StoryRow({ story, onStoryClick, indented, runId, onRetryStory, isFocused, includeGraph, context }: {
  story: MergedStory;
  onStoryClick?: (storyId: string) => void;
  indented?: boolean;
  runId?: number;
  onRetryStory?: (storyId: string) => void;
  isFocused?: boolean;
  includeGraph?: boolean;
  context?: StoryContextInfo;
}) {
  const cfg = STATUS_CONFIG[story.status] || STATUS_CONFIG.pending;
  const Icon = cfg.icon;
  const isRunning = story.status === 'running';
  const isRetrying = story.status === 'retry';
  const isExcluded = story.status === 'excluded';
  const isFailed = story.status === 'fail';
  const isBlocked = story.status === 'blocked';
  const isExpandable = isFailed || isBlocked;
  const isClickable = !!onStoryClick;

  // Expandable detail for failed/blocked stories
  const [expanded, setExpanded] = useState(false);
  const [outputLines, setOutputLines] = useState<string[]>([]);
  const [outputLoading, setOutputLoading] = useState(false);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [retryLoading, setRetryLoading] = useState(false);

  // CTM-004: Per-story context accordion (files / tokens first; skills are routing metadata only)
  const [contextExpanded, setContextExpanded] = useState(false);
  const hasContextTokens = !!context && (context.inputTokens > 0 || context.outputTokens > 0);
  const hasContextFiles = !!context && context.contextFiles.length > 0;
  const hasRoutingSkills = !!context && context.skills.length > 0;
  const hasContext = !!context && (hasContextFiles || hasContextTokens);

  const handleToggleContext = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setContextExpanded(prev => !prev);
  }, []);

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

  // Fetch output when expanding a failed story (50 lines for story log)
  useEffect(() => {
    if (expanded && isFailed && runId && outputLines.length === 0 && !outputLoading) {
      setOutputLoading(true);
      fetchStoryOutput(runId, story.storyId, 50)
        .then(data => {
          setOutputLines(data.output);
          setFailureReason(data.failureReason);
        })
        .catch(() => { /* ignore */ })
        .finally(() => setOutputLoading(false));
    }
  }, [expanded, isFailed, runId, story.storyId, outputLines.length, outputLoading]);

  const handleToggleExpand = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(prev => !prev);
  }, []);

  const handleRetry = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!runId || !onRetryStory || retryLoading) return;
    setRetryLoading(true);
    onRetryStory(story.storyId);
  }, [runId, onRetryStory, retryLoading, story.storyId]);

  const retriesUsed = story.retries ?? 0;
  const canRetry = retriesUsed < MAX_RETRIES;

  return (
    <div className={`${cfg.rowClass || ''} ${justPassed ? 'animate-story-pass' : ''}`}>
      {/* Main row — fixed 48px height */}
      <div
        onClick={isExpandable ? handleToggleExpand : (isClickable ? () => onStoryClick!(story.storyId) : undefined)}
        className={`flex items-center gap-2 ${indented ? 'pl-6 pr-3' : 'px-3'} h-[${ROW_HEIGHT}px] border-b border-border/50 transition-colors ${
          isExpandable || isClickable ? 'cursor-pointer hover:bg-bg/50' : ''
        } ${isFocused ? 'ring-2 ring-inset ring-accent/50 bg-accent/5' : ''}`}
        style={{ height: ROW_HEIGHT }}
      >
        {/* Expand chevron for failed/blocked stories */}
        {isExpandable ? (
          <button onClick={handleToggleExpand} className="shrink-0 p-0 bg-transparent border-none" aria-label={expanded ? 'Collapse details' : 'Expand details'} aria-expanded={expanded}>
            {expanded ? (
              <ChevronDown size={12} className={isFailed ? 'text-red-400' : 'text-gray-400'} />
            ) : (
              <ChevronRight size={12} className={isFailed ? 'text-red-400' : 'text-gray-400'} />
            )}
          </button>
        ) : null}
        <Icon
          size={14}
          className={`shrink-0 ${cfg.color} ${isRunning ? 'animate-pulse' : isRetrying ? 'animate-spin' : ''} ${justPassed ? 'animate-checkmark-pop' : ''}`}
        />
        <span className={`text-[11px] font-mono font-semibold shrink-0 px-1 py-0.5 rounded ${
          story.status === 'running' ? 'bg-emerald-500/10 text-emerald-500' :
          story.status === 'pass' ? 'bg-emerald-500/10 text-emerald-500' :
          story.status === 'fail' ? 'bg-red-500/10 text-red-500' :
          story.status === 'blocked' ? 'bg-gray-500/10 text-gray-400' :
          story.status === 'rate_limited' ? 'bg-amber-500/10 text-amber-500' :
          'bg-bg text-muted'
        }`} aria-live="polite">
          {story.storyId}
        </span>
        <span className={`text-xs truncate flex-1 ${
          isExcluded || isBlocked ? 'text-muted' : isExcluded ? 'line-through text-muted' : 'text-[var(--text)]'
        }`}>
          {story.title}
        </span>
        {/* US-007: Graph context badge — shown when run has includeGraph=true */}
        {includeGraph && (
          <span
            className="inline-flex items-center gap-1 text-[10px] text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded shrink-0"
            title="Knowledge graph context was injected for this story"
          >
            <Share2 size={10} />
            Graph{story.graphHits != null ? `: ${story.graphHits} hits` : ''}
          </span>
        )}
        {/* BMC-005: Browser MCP indicator — shown when story_started WAL event has browser_mcp: true */}
        {story.browserMcp && (
          <Globe className="w-3 h-3 text-purple-400 shrink-0" aria-label="Browser MCP active" />
        )}
        {/* Blocked by badge — grey with upstream story ID */}
        {isBlocked && story.blockedBy && story.blockedBy.length > 0 && (
          <span className="text-[10px] text-gray-400 bg-gray-500/10 px-1.5 py-0.5 rounded shrink-0 font-mono">
            Blocked by {story.blockedBy[0]}
          </span>
        )}
        {/* View Log button for failed stories */}
        {isFailed && (
          <button
            onClick={handleToggleExpand}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors shrink-0"
          >
            <FileText size={10} />
            View Log
          </button>
        )}
        {/* Rate limit countdown */}
        {story.status === 'rate_limited' && story.rateLimitRetryAt != null && (
          <RateLimitCountdown retryAt={story.rateLimitRetryAt} />
        )}
        {/* US-027: GitHub status indicator — pulses while commit status is being posted */}
        {story.githubStatusPending && (
          <Github size={12} className="shrink-0 text-gray-400 animate-pulse" aria-label="Posting GitHub commit status" />
        )}
        {/* US-034: PR sync indicator — shown transiently when PR body is updated */}
        {story.prSyncPending && (
          <span className="inline-flex items-center gap-1 text-[10px] text-gray-400 animate-pulse shrink-0" aria-label="Syncing to GitHub PR">
            <Github size={10} />
            Syncing PR...
          </span>
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
        {/* Retry count badge — "N/3 retries used" for failed stories */}
        {isFailed && retriesUsed > 0 && (
          <span className="text-[10px] text-red-400 bg-red-500/10 px-1.5 py-0.5 rounded shrink-0 font-mono">
            {retriesUsed}/{MAX_RETRIES} retries
          </span>
        )}
        {/* Non-failed retry indicator */}
        {!isFailed && story.retries != null && story.retries > 0 && (
          <span className="text-[10px] text-yellow-500 shrink-0">
            R{story.retries}
          </span>
        )}
        {story.rateLimitAttempt != null && story.rateLimitAttempt > 0 && (
          <span className="text-[10px] text-amber-500 shrink-0">
            RL{story.rateLimitAttempt}
          </span>
        )}
        {/* CTM-004: Context accordion toggle — shown when per-story context exists */}
        {hasContext && (
          <button
            onClick={handleToggleContext}
            className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
              contextExpanded ? 'text-accent bg-accent/10' : 'text-muted hover:text-[var(--text)] hover:bg-bg/60'
            }`}
            title={contextExpanded ? 'Collapse context' : 'Expand context'}
            aria-label={contextExpanded ? 'Collapse context' : 'Expand context'}
            aria-expanded={contextExpanded}
          >
            <ChevronRight size={11} className={`transition-transform duration-150 ${contextExpanded ? 'rotate-90' : ''}`} />
            Context
          </button>
        )}
      </div>

      {/* CTM-004: Per-story context accordion panel */}
      {hasContext && contextExpanded && context && (
        <div className={`${indented ? 'pl-6 pr-3' : 'px-3'} py-2.5 bg-bg/40 border-b border-border/50`}>
          <div className="rounded-lg border border-border/70 bg-panel/70 overflow-hidden">
            <div className="px-2.5 py-2 border-b border-border/60 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-accent flex items-center gap-1">
                  <Files size={10} className="text-blue-400" /> Context used
                </p>
                <p className="mt-0.5 text-[10px] text-muted leading-4">
                  Files and token budget that were available to the story prompt. Skill matches are shown separately as routing metadata.
                </p>
              </div>
              {hasContextTokens && (
                <div className="shrink-0 grid grid-cols-2 gap-1 text-right">
                  <div className="rounded bg-bg/70 px-1.5 py-1">
                    <div className="text-[9px] uppercase tracking-wider text-muted">In</div>
                    <div className="text-[10px] font-mono text-[var(--text)]">{context.inputTokens.toLocaleString()}</div>
                  </div>
                  <div className="rounded bg-bg/70 px-1.5 py-1">
                    <div className="text-[9px] uppercase tracking-wider text-muted">Out</div>
                    <div className="text-[10px] font-mono text-[var(--text)]">{context.outputTokens.toLocaleString()}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="px-2.5 py-2 space-y-2.5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1 flex items-center gap-1">
                  <Files size={10} className="text-blue-400" /> Context files ({context.contextFiles.length})
                </p>
                {context.contextFiles.length > 0 ? (
                  <div className="grid gap-1 max-w-full">
                    {context.contextFiles.slice(0, 20).map(f => (
                      <code key={f} className="block min-w-0 truncate px-1.5 py-0.5 rounded bg-bg text-[10px] font-mono text-accent/85 border border-border/60" title={f}>
                        {f}
                      </code>
                    ))}
                    {context.contextFiles.length > 20 && (
                      <span className="text-[10px] text-muted">+{context.contextFiles.length - 20} more files</span>
                    )}
                  </div>
                ) : (
                  <div className="rounded border border-dashed border-border/70 bg-bg/40 px-2 py-1.5 text-[10px] leading-4 text-muted">
                    No file-level context was recorded for this story. Token usage is available, but the run did not persist a per-story file list.
                  </div>
                )}
              </div>

              {hasRoutingSkills && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1 flex items-center gap-1">
                    <Sparkles size={10} className="text-purple-400" /> Routing skills ({context.skills.length})
                  </p>
                  <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto pr-1">
                    {context.skills.map(sk => (
                      <span
                        key={sk.name}
                        className="inline-flex min-w-0 max-w-full items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300 text-[10px] font-medium"
                        title={sk.reason ?? undefined}
                      >
                        <span className="truncate">{sk.name}</span>
                        {sk.relevance != null && (
                          <span className={`shrink-0 text-[9px] font-semibold ${sk.relevance >= 7 ? 'text-purple-200' : 'text-purple-500/70'}`}>
                            {sk.relevance}/10
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Expanded detail panel — for failed stories (story log) */}
      {isFailed && expanded && (
        <div className={`${indented ? 'pl-6 pr-3' : 'px-3'} py-2 bg-red-500/5 border-b border-border/50`}>
          {/* Failure reason */}
          {failureReason && (
            <div className="text-[10px] text-red-400 font-medium mb-1.5">
              Failure: {failureReason.replace(/_/g, ' ')}
            </div>
          )}

          {/* Story Log — last 50 lines of Claude subprocess output */}
          <div className="mb-2">
            <div className="text-[10px] font-semibold text-red-400/80 mb-1">Story Log</div>
            {outputLoading ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 size={12} className="animate-spin text-muted" />
                <span className="text-[10px] text-muted">Loading story log...</span>
              </div>
            ) : outputLines.length > 0 ? (
              <pre className="text-[10px] font-mono text-muted bg-terminal-bg rounded p-2 overflow-x-auto max-h-64 leading-relaxed overflow-y-auto">
                {outputLines.join('\n')}
              </pre>
            ) : (
              <div className="text-[10px] text-muted py-1">No log output available</div>
            )}
          </div>

          {/* Retry button + retry count */}
          <div className="flex items-center gap-2">
            {canRetry && onRetryStory && (
              <button
                onClick={handleRetry}
                disabled={retryLoading}
                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                {retryLoading ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <RotateCcw size={10} />
                )}
                Retry this story
              </button>
            )}
            {!canRetry && (
              <span className="text-[10px] text-red-400/70">
                Max retries ({MAX_RETRIES}) reached
              </span>
            )}
            <span className="text-[10px] text-muted ml-auto">
              {retriesUsed}/{MAX_RETRIES} retries used
            </span>
          </div>
        </div>
      )}

      {/* Expanded detail panel — for blocked stories */}
      {isBlocked && expanded && (
        <div className={`${indented ? 'pl-6 pr-3' : 'px-3'} py-2 bg-gray-500/5 border-b border-border/50`}>
          <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
            <Ban size={10} />
            <span>
              This story was blocked because upstream {story.blockedBy && story.blockedBy.length === 1 ? 'story' : 'stories'}{' '}
              <span className="font-mono font-semibold">{story.blockedBy?.join(', ')}</span>{' '}
              failed. It never ran.
            </span>
          </div>
        </div>
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
      aria-expanded={expanded}
      aria-label={`Wave ${waveIndex}: ${storyCount} ${storyCount === 1 ? 'story' : 'stories'}, ${style.label}`}
      className={`w-full flex items-center gap-2 px-3 border-b border-border bg-panel/80 hover:bg-panel transition-all ${
        isActive ? 'animate-[wave-pulse_2s_ease-in-out_1]' : ''
      }`}
      style={{ height: ROW_HEIGHT }}
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
      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded ${style.bg} ${style.text}`} aria-live="polite">
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

// ─── Virtual list item types ─────────────────────────────────────────────────

type VirtualItem =
  | { type: 'story'; story: MergedStory; indented?: boolean }
  | { type: 'wave-header'; waveIndex: number; storyCount: number; waveStatus: WaveStatus; counts: { passed: number; failed: number } }
  | { type: 'excluded-header'; count: number };

// ─── Main component ──────────────────────────────────────────────────────────

export default function RunStoryList({
  runId,
  walEvents,
  runState,
  resumeSummary,
  onStoryClick,
  onRetryStory,
  parallelism,
  includeGraph,
  storyContext,
}: RunStoryListProps) {
  const [storyResults, setStoryResults] = useState<StoryResult[]>([]);
  const [specStories, setSpecStories] = useState<SpecStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsedWaves, setCollapsedWaves] = useState<Set<number>>(new Set());
  const [retryingStories, setRetryingStories] = useState<Set<string>>(new Set());
  const [prSyncActive, setPrSyncActive] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number>(-1);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollOffsetRef = useRef<number>(0);

  const isWaveMode = (parallelism ?? 1) > 1;

  // Handle individual story retry
  const handleRetryStory = useCallback(async (storyId: string) => {
    // Immediately show as running in UI
    setRetryingStories(prev => new Set(prev).add(storyId));
    try {
      const result = await retryRun(runId, { storyIds: [storyId] });
      if (result.runId && onRetryStory) {
        onRetryStory(storyId, result.runId);
      }
    } catch {
      // Revert on failure
      setRetryingStories(prev => {
        const next = new Set(prev);
        next.delete(storyId);
        return next;
      });
    }
  }, [runId, onRetryStory]);

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
  // Only consider events from the current run — old story_started events from
  // previous runs for the same story_id would otherwise show stale timers.
  const runningStoryIds = useMemo(() => {
    const running = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      const p = parsePayload(evt.payload);
      if (p?.run_id !== undefined && p.run_id !== runId) continue;
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
  }, [walEvents, runId]);

  // Build SSE-derived started-at timestamps for live elapsed
  // Filter by current runId so stale timestamps from prior runs don't bleed through.
  const storyStartTimes = useMemo(() => {
    const map = new Map<string, number>();
    for (const evt of walEvents) {
      if (evt.event_type === 'story_started' && evt.story_id) {
        const p = parsePayload(evt.payload);
        if (p?.run_id !== undefined && p.run_id !== runId) continue;
        map.set(evt.story_id, new Date(evt.ts).getTime());
      }
    }
    return map;
  }, [walEvents, runId]);

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
        map.delete(evt.story_id);
      } else if (evt.event_type === 'story_passed' || evt.event_type === 'story_failed') {
        map.delete(evt.story_id);
      }
    }
    return map;
  }, [walEvents]);

  // US-034: Track pr_body_updated events — show transient "Syncing to GitHub PR..." indicator
  const prSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const hasPrUpdate = walEvents.some(e => e.event_type === 'pr_body_updated');
    if (hasPrUpdate) {
      setPrSyncActive(true);
      if (prSyncTimerRef.current) clearTimeout(prSyncTimerRef.current);
      prSyncTimerRef.current = setTimeout(() => setPrSyncActive(false), 2000);
    }
    return () => {
      if (prSyncTimerRef.current) clearTimeout(prSyncTimerRef.current);
    };
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

  // US-007: Extract graph_hits per story from WAL event payloads
  const graphHitsMap = useMemo(() => {
    if (!includeGraph) return new Map<string, number>();
    const map = new Map<string, number>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started' || evt.event_type === 'story_passed' || evt.event_type === 'story_failed') {
        if (evt.payload) {
          try {
            const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
            if (typeof payload.graph_hits === 'number') {
              map.set(evt.story_id, payload.graph_hits);
            }
          } catch { /* ignore */ }
        }
      }
    }
    return map;
  }, [walEvents, includeGraph]);

  // BMC-005: Extract browser_mcp flag per story from story_started WAL event payloads
  const browserMcpStoryIds = useMemo(() => {
    const set = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started' && evt.payload) {
        try {
          const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
          if (payload.browser_mcp === true) {
            set.add(evt.story_id);
          }
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
    const carriedPassed = new Map((runState?.completedStories ?? []).map((story) => [story.storyId, story]));
    const carriedFailed = new Map((runState?.failedStories ?? []).map((story) => [story.storyId, story]));
    const carriedSkipped = new Map((runState?.skippedStories ?? []).map((story) => [story.storyId, story]));
    if (carriedPassed.size === 0 && resumeSummary?.continueFromId) {
      const continueIndex = source.findIndex((story) => story.id === resumeSummary.continueFromId);
      if (continueIndex > 0) {
        for (const prior of source.slice(0, continueIndex)) {
          carriedPassed.set(prior.id, {
            storyId: prior.id,
            title: prior.title,
            status: 'passed',
            startedAt: '',
            finishedAt: '',
            agentType: 'resume',
          });
        }
      }
    }

    return source.map((spec): MergedStory => {
      const result = resultMap.get(spec.id);
      const carriedPass = carriedPassed.get(spec.id);
      const carriedFail = carriedFailed.get(spec.id);
      const carriedSkip = carriedSkipped.get(spec.id);
      let status: DerivedStatus = 'pending';
      let blockedBy: string[] | null = null;

      if (result) {
        if (result.status === 'pass') status = 'pass';
        else if (result.status === 'fail') status = 'fail';
        else if (result.status === 'skip') {
          // Distinguish between blocked (has blocked_by) and regular skip
          if (result.blocked_by) {
            try { blockedBy = JSON.parse(result.blocked_by); } catch { /* ignore */ }
          }
          status = blockedBy ? 'blocked' : 'skip';
        }
        else if (result.status === 'retry') status = 'retry';
        else status = result.status as DerivedStatus;
      } else if (carriedPass) {
        status = 'pass';
      } else if (carriedFail) {
        status = 'fail';
      } else if (carriedSkip) {
        status = 'skip';
      } else if (spec.passes === true) {
        status = 'excluded';
      }

      // Also check WAL events for blocked_by info if not in story_results
      if (!blockedBy && (status === 'skip' || status === 'fail')) {
        for (const evt of walEvents) {
          if (evt.story_id === spec.id && evt.event_type === 'story_failed' && evt.payload) {
            try {
              const payload = JSON.parse(evt.payload);
              if (payload.reason === 'blocked_by' && Array.isArray(payload.blockedBy)) {
                blockedBy = payload.blockedBy;
                status = 'blocked';
                break;
              }
            } catch { /* ignore */ }
          }
        }
      }

      // SSE override: if this story is currently rate limited
      const rlInfo = rateLimitedStories.get(spec.id);
      if (rlInfo) {
        status = 'rate_limited';
      }

      // SSE override: if this story is currently running
      if (runningStoryIds.has(spec.id) && (!result || result.status === 'retry')) {
        status = 'running';
      } else if (runState?.currentStory === spec.id && !result) {
        status = 'running';
      }

      // Local retry override: show as running immediately after retry button click
      if (retryingStories.has(spec.id)) {
        status = 'running';
      }

      return {
        storyId: spec.id,
        title: spec.title,
        status,
        elapsed: result?.elapsed_seconds ?? (carriedPass?.elapsedMs != null ? Math.round(carriedPass.elapsedMs / 1000) : carriedFail?.elapsedMs != null ? Math.round(carriedFail.elapsedMs / 1000) : carriedSkip?.elapsedMs != null ? Math.round(carriedSkip.elapsedMs / 1000) : null),
        retries: result?.retries ?? carriedFail?.retries ?? carriedSkip?.retries ?? null,
        startedAt: storyStartTimes.get(spec.id) ?? (runState?.currentStory === spec.id ? Date.parse(runState.lastUpdatedAt) : null),
        rateLimitRetryAt: rlInfo?.retryAt ?? null,
        rateLimitAttempt: rlInfo?.attempt ?? null,
        blockedBy,
        githubStatusPending: status === 'running' || status === 'retry',
        prSyncPending: prSyncActive && (status === 'pass' || status === 'fail'),
        graphHits: graphHitsMap.get(spec.id) ?? null,
        browserMcp: browserMcpStoryIds.has(spec.id),
      };
    });
  }, [specStories, storyResults, resultMap, runningStoryIds, storyStartTimes, rateLimitedStories, retryingStories, walEvents, prSyncActive, graphHitsMap, browserMcpStoryIds, runState]);

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
      let passed = 0, failed = 0, running = 0;

      for (const s of stories) {
        if (s.status === 'pass' || s.status === 'excluded') passed++;
        else if (s.status === 'fail' || s.status === 'skip' || s.status === 'blocked') failed++;
        else if (s.status === 'running' || s.status === 'retry' || s.status === 'rate_limited') running++;
      }

      let waveStatus: WaveStatus = 'waiting';
      const isMerged = mergedWaveIndices.has(wave.index);

      if (isMerged) {
        waveStatus = failed > 0 ? 'partial-fail' : 'done';
      } else if (running > 0) {
        waveStatus = 'running';
      } else if (passed + failed === stories.length && stories.length > 0 && (passed > 0 || failed > 0)) {
        waveStatus = 'merging';
      } else if (passed > 0 || failed > 0) {
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
    let passed = 0, failed = 0, blocked = 0;
    const total = mergedStories.length;
    for (const s of mergedStories) {
      if (s.status === 'pass') passed++;
      else if (s.status === 'fail') failed++;
      else if (s.status === 'blocked') blocked++;
    }
    return { passed, failed, blocked, total };
  }, [mergedStories]);

  // CTM-004: Aggregate context usage across stories for the header summary bar.
  const contextSummary = useMemo(() => {
    if (!storyContext || storyContext.size === 0) return null;
    const skills = new Set<string>();
    const files = new Set<string>();
    let tokenSum = 0;
    let tokenStories = 0;
    for (const info of storyContext.values()) {
      for (const sk of info.skills) skills.add(sk.name);
      for (const f of info.contextFiles) files.add(f);
      if (info.inputTokens > 0) { tokenSum += info.inputTokens; tokenStories++; }
    }
    const avgTokens = tokenStories > 0 ? tokenSum / tokenStories : 0;
    if (skills.size === 0 && files.size === 0 && avgTokens === 0) return null;
    return { skillCount: skills.size, fileCount: files.size, avgTokens };
  }, [storyContext]);

  // ─── Build flat virtual items list ─────────────────────────────────────────

  const virtualItems = useMemo((): VirtualItem[] => {
    if (isWaveMode && waves && waves.length > 0) {
      const items: VirtualItem[] = [];

      // Excluded stories (pre-passed)
      const waveCoveredIds = new Set(waves.flatMap(w => w.storyIds));
      const excludedStories = mergedStories.filter(s => !waveCoveredIds.has(s.storyId));

      if (excludedStories.length > 0) {
        items.push({ type: 'excluded-header', count: excludedStories.length });
        for (const story of excludedStories) {
          items.push({ type: 'story', story, indented: true });
        }
      }

      for (const wave of waves) {
        const ws = waveStatuses.get(wave.index) ?? { status: 'waiting' as WaveStatus, passed: 0, failed: 0 };
        items.push({
          type: 'wave-header',
          waveIndex: wave.index,
          storyCount: wave.storyIds.length,
          waveStatus: ws.status,
          counts: { passed: ws.passed, failed: ws.failed },
        });

        // Only include stories if wave is expanded
        if (!collapsedWaves.has(wave.index)) {
          for (const storyId of wave.storyIds) {
            const story = mergedMap.get(storyId);
            if (story) {
              items.push({ type: 'story', story, indented: true });
            }
          }
        }
      }

      return items;
    }

    // Sequential mode: flat story list
    return mergedStories.map(story => ({ type: 'story' as const, story }));
  }, [isWaveMode, waves, waveStatuses, collapsedWaves, mergedMap, mergedStories]);

  // ─── Virtual scroll setup ──────────────────────────────────────────────────

  const virtualizer = useVirtualizer({
    count: virtualItems.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    initialOffset: scrollOffsetRef.current,
  });

  // Preserve scroll position across re-renders
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollOffsetRef.current = el.scrollTop;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // ─── Auto-scroll running/active story into view ───────────────────────────

  const prevRunningRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Find newly started stories (not previously running)
    const newlyRunning: string[] = [];
    for (const id of runningStoryIds) {
      if (!prevRunningRef.current.has(id)) {
        newlyRunning.push(id);
      }
    }
    prevRunningRef.current = new Set(runningStoryIds);

    if (newlyRunning.length === 0) return;

    // Find the index of the first newly running story in virtualItems
    const lastNewId = newlyRunning[newlyRunning.length - 1];
    const idx = virtualItems.findIndex(
      item => item.type === 'story' && item.story.storyId === lastNewId
    );

    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'auto', behavior: 'smooth' });
    }
  }, [runningStoryIds, virtualItems, virtualizer]);

  // ─── Keyboard navigation ──────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const itemCount = virtualItems.length;
    if (itemCount === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex(prev => {
        const next = Math.min(prev + 1, itemCount - 1);
        virtualizer.scrollToIndex(next, { align: 'auto', behavior: 'smooth' });
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex(prev => {
        const next = Math.max(prev - 1, 0);
        virtualizer.scrollToIndex(next, { align: 'auto', behavior: 'smooth' });
        return next;
      });
    } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < itemCount) {
      e.preventDefault();
      const item = virtualItems[focusedIndex];
      if (item.type === 'story' && onStoryClick) {
        onStoryClick(item.story.storyId);
      } else if (item.type === 'wave-header') {
        toggleWave(item.waveIndex);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusedIndex(0);
      virtualizer.scrollToIndex(0, { align: 'start', behavior: 'smooth' });
    } else if (e.key === 'End') {
      e.preventDefault();
      const lastIdx = itemCount - 1;
      setFocusedIndex(lastIdx);
      virtualizer.scrollToIndex(lastIdx, { align: 'end', behavior: 'smooth' });
    }
  }, [virtualItems, focusedIndex, onStoryClick, toggleWave, virtualizer]);

  // ─── Render ────────────────────────────────────────────────────────────────

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
      <div className="shrink-0 px-3 py-2 border-b border-border bg-panel flex items-center gap-2">
        {isWaveMode && <Layers size={12} className="text-purple-400" />}
        <span className="text-xs font-semibold text-muted uppercase tracking-wider">
          Stories ({counts.total})
        </span>
        {isWaveMode && waves && (
          <span className="text-[10px] text-muted ml-auto">
            {waves.length} {waves.length === 1 ? 'wave' : 'waves'}
          </span>
        )}
      </div>

      {resumeSummary && (resumeSummary.continueFromId || resumeSummary.resumedAfterId || resumeSummary.carriedForwardCount > 0) && (
        <div className="shrink-0 px-3 py-2 border-b border-amber-500/20 bg-amber-500/5 flex items-center gap-2" data-testid="story-list-resume-banner">
          <RotateCcw size={12} className="text-amber-400 shrink-0" />
          <div className="min-w-0 text-[11px] leading-4 text-amber-200/90">
            <span className="font-medium">Continuing</span>
            {resumeSummary.continueFromId && <span> from <span className="font-mono">{resumeSummary.continueFromId}</span></span>}
            {resumeSummary.resumedAfterId && <span className="text-amber-200/70"> after <span className="font-mono">{resumeSummary.resumedAfterId}</span></span>}
            {resumeSummary.carriedForwardCount > 0 && <span className="text-amber-200/70"> · {resumeSummary.carriedForwardCount} carried forward</span>}
          </div>
        </div>
      )}

      {/* CTM-004: Context usage summary bar — aggregate skills/files/tokens */}
      {contextSummary && (
        <div
          className="shrink-0 px-3 py-1.5 border-b border-border bg-panel/60 flex items-center gap-3 text-[11px] text-muted"
          aria-label="Run context usage summary"
        >
          {contextSummary.avgTokens > 0 && (
            <span className="flex items-center gap-1">
              <Cpu size={11} className="text-emerald-400 shrink-0" />
              {contextSummary.avgTokens >= 1000
                ? `~${(contextSummary.avgTokens / 1000).toFixed(1)}K`
                : `~${Math.round(contextSummary.avgTokens)}`} tokens/story
            </span>
          )}
          {contextSummary.fileCount > 0 && (
            <span className="flex items-center gap-1">
              <Files size={11} className="text-blue-400 shrink-0" />
              {contextSummary.fileCount} {contextSummary.fileCount === 1 ? 'file' : 'files'}
            </span>
          )}
          {contextSummary.skillCount > 0 && (
            <span className="flex items-center gap-1">
              <Sparkles size={11} className="text-purple-400 shrink-0" />
              {contextSummary.skillCount} routing {contextSummary.skillCount === 1 ? 'skill' : 'skills'}
            </span>
          )}
        </div>
      )}

      {/* Virtual scroll container */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        role="listbox"
        aria-label="Story list"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((vItem) => {
            const item = virtualItems[vItem.index];
            const isFocused = focusedIndex === vItem.index;

            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  minHeight: ROW_HEIGHT,
                  transform: `translateY(${vItem.start}px)`,
                }}
                role="option"
                aria-selected={isFocused}
              >
                {item.type === 'story' ? (
                  <StoryRow
                    story={item.story}
                    onStoryClick={onStoryClick}
                    onRetryStory={handleRetryStory}
                    runId={runId}
                    indented={item.indented}
                    isFocused={isFocused}
                    includeGraph={includeGraph}
                    context={storyContext?.get(item.story.storyId)}
                  />
                ) : item.type === 'wave-header' ? (
                  <WaveHeader
                    waveIndex={item.waveIndex}
                    storyCount={item.storyCount}
                    waveStatus={item.waveStatus}
                    expanded={!collapsedWaves.has(item.waveIndex)}
                    onToggle={() => toggleWave(item.waveIndex)}
                    counts={item.counts}
                  />
                ) : item.type === 'excluded-header' ? (
                  <div
                    className="flex items-center gap-2 px-3 border-b border-border bg-panel/50"
                    style={{ height: ROW_HEIGHT }}
                  >
                    <SkipForward size={10} className="text-gray-400" />
                    <span className="text-[10px] font-medium text-muted">
                      {item.count} pre-passed
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Summary footer */}
      <div className="shrink-0 px-3 py-2 border-t border-border bg-panel flex items-center gap-3">
        <span className="text-[11px] font-medium text-emerald-500">
          {counts.passed} passed
        </span>
        <span className="text-[11px] font-medium text-red-500">
          {counts.failed} failed
        </span>
        {counts.blocked > 0 && (
          <span className="text-[11px] font-medium text-gray-400">
            {counts.blocked} blocked
          </span>
        )}
        <span className="text-[11px] text-muted ml-auto">
          {counts.passed + counts.failed + counts.blocked} / {counts.total}
        </span>
      </div>
    </div>
  );
}
