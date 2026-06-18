/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

// @refresh reset
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ScrollText, List, GitBranch, ArrowLeftRight, FolderGit2, GitCommitHorizontal, RefreshCw, Loader2, Pause, Play, Square, Send, AlertTriangle, Layers, DollarSign, Smartphone, XCircle, ExternalLink, RotateCcw, X, Wrench, ChevronRight, Sparkles, Files, Cpu, MailWarning, Clock, Check, GitMerge, GitPullRequest, Zap } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { usePipelineSSE } from '../hooks/usePipelineSSE';
import { useIsMobile } from '../hooks/useIsMobile';
import { apiFetch } from '../lib/apiFetch';
import { pauseRun, resumeRun, cancelRun, injectContext, retryRun, getRunDlq, retryRunFromDlq, type DlqEntry } from '../api/pipeline';
import RunTerminal from '../components/RunTerminal';
import type { RunTerminalHandle } from '../components/RunTerminal';
import MultiPaneTerminal from '../components/MultiPaneTerminal';

import SplitPane from '../components/SplitPane';
import RunStoryList from '../components/RunStoryList';
import type { StoryContextInfo } from '../components/RunStoryList';
import RunMetadataPanel from '../components/RunMetadataPanel';
import AgentBadge from '../components/AgentBadge';
import InteractiveDependencyGraph from '../components/InteractiveDependencyGraph';
import type { DerivedStatus } from '../components/InteractiveDependencyGraph';
import CompareRunsPanel from './CompareRunsPanel';
import WorktreesPanel from './WorktreesPanel';
import FinOpsTab from '../components/FinOpsTab';
import SkillsTab from '../components/SkillsTab';
import ContextInspector from '../components/ContextInspector';
import type { PanelId } from '../components/Sidebar';
import { RunViewSkeleton } from '../components/skeletons';
import AppHeader from '../components/AppHeader';

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
  parallelism?: number;
  agentType?: string;
  agentModel?: string | null;
  merge_status?: 'pending' | 'merging' | 'merged' | 'failed' | null;
  merge_commit_sha?: string | null;
  merge_error?: string | null;
  pr_number?: number | null;
  pr_creating?: boolean;
  pr_creation_error?: string | null;
  include_graph?: boolean;
  terminal_mode?: 'ansi-html' | 'pty';
}

interface StoryResultSeed {
  story_id: string;
  status: string; // 'pass' | 'fail' | 'skip' from DB
  started_at: string | null;
  finished_at: string | null;
  elapsed_seconds: number | null;
  active_skills?: string | null; // JSON array string from story_results.active_skills
  reason?: string | null; // e.g. 'previously_passed' for pre-seeded skip rows
}

interface StoryTokenEntry {
  storyId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  modelUsed: string | null;
  costUsd: number;
}

interface ContextComparisonData {
  predicted: Record<string, { totalTokens: number; injectedFiles: string[] }>;
  actual: Record<string, { contextFiles: string[] }>;
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

interface RunApiResponse {
  run: PipelineRun;
  stories: StoryResultSeed[];
  specStories: { id: string; title: string; suggestedSkills?: Array<{ name: string; relevance: number; reason: string }> }[];
  specModel?: string | null;
  agentType?: string;
  agentModel?: string | null;
  tokenSummary?: { inputTokens: number; outputTokens: number };
  runState?: RunStateSnapshot | null;
  contextComparison?: ContextComparisonData | null;
  storyTokenBreakdown?: StoryTokenEntry[];
}

interface CommitEntry {
  sha: string;
  message: string;
  date: string;
  author: string;
}

type RunViewTab = 'terminal' | 'stories' | 'inspector' | 'graph' | 'skills' | 'finops' | 'compare' | 'worktrees' | 'commits';

const TABS: { id: RunViewTab; label: string; icon: typeof ScrollText }[] = [
  { id: 'terminal', label: 'Execution Trace', icon: ScrollText },
  { id: 'stories', label: 'Stories', icon: List },
  { id: 'inspector', label: 'Context', icon: Layers },
  { id: 'graph', label: 'Graph', icon: GitBranch },
  { id: 'skills', label: 'Skills', icon: Wrench },
  { id: 'finops', label: 'FinOps', icon: DollarSign },
  { id: 'compare', label: 'Compare', icon: ArrowLeftRight },
  { id: 'worktrees', label: 'Worktrees', icon: FolderGit2 },
  { id: 'commits', label: 'Commits', icon: GitCommitHorizontal },
];

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
  failed: '\u2717 Failed',
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

// ─── Stories List Tab ───────────────────────────────────────────────────────

/**
 * @deprecated Replaced by RunStoryList component (src/components/RunStoryList.tsx).
 * RunStoryList provides live elapsed timers, auto-scroll to running story,
 * checkmark pop animation, green flash animation, WAL event integration,
 * wave group visualization, and keyboard navigation (j/k).
 * Kept here temporarily for rollback safety — remove once RunStoryList is confirmed stable.
 */
function StoriesListTab({ dbStories, specStories, liveStatuses, contextComparison, storyTokenBreakdown }: {
  dbStories: StoryResultSeed[];
  specStories: { id: string; title: string; suggestedSkills?: Array<{ name: string; relevance: number; reason: string }> }[];
  liveStatuses: Map<string, DerivedStatus>;
  contextComparison?: ContextComparisonData | null;
  storyTokenBreakdown?: StoryTokenEntry[];
}) {
  const [expandedStoryId, setExpandedStoryId] = useState<string | null>(null);

  // Merge spec story titles with db results and live statuses
  const titleMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of specStories) m.set(s.id, s.title);
    return m;
  }, [specStories]);

  // Build suggestedSkills lookup: storyId -> Map<name, { relevance, reason }>
  const suggestedSkillsMap = useMemo(() => {
    const m = new Map<string, Map<string, { relevance: number; reason: string }>>();
    for (const s of specStories) {
      if (Array.isArray(s.suggestedSkills) && s.suggestedSkills.length > 0) {
        const skillMap = new Map<string, { relevance: number; reason: string }>();
        for (const sk of s.suggestedSkills) skillMap.set(sk.name, { relevance: sk.relevance, reason: sk.reason });
        m.set(s.id, skillMap);
      }
    }
    return m;
  }, [specStories]);

  // Build token lookup by storyId
  const tokenMap = useMemo(() => {
    const m = new Map<string, StoryTokenEntry>();
    for (const t of (storyTokenBreakdown ?? [])) m.set(t.storyId, t);
    return m;
  }, [storyTokenBreakdown]);

  const rows = useMemo(() => {
    // Start from spec stories order if available, else db order
    const ids = specStories.length > 0
      ? specStories.map(s => s.id)
      : dbStories.map(s => s.story_id);
    return ids.map(id => {
      const db = dbStories.find(s => s.story_id === id);
      const live = liveStatuses.get(id);
      const status = live?.status ?? (db ? (db.status === 'pass' ? 'passed' : db.status === 'fail' ? 'failed' : db.status) : 'pending');
      const elapsed = live?.elapsed ?? (db?.elapsed_seconds != null ? `${db.elapsed_seconds}s` : null);
      // Parse active_skills from db story (JSON string)
      let activeSkills: string[] = [];
      if (db?.active_skills) {
        try { activeSkills = JSON.parse(db.active_skills); } catch { /* ignore */ }
      }
      return { id, title: titleMap.get(id) ?? id, status, elapsed, activeSkills };
    });
  }, [specStories, dbStories, liveStatuses, titleMap]);

  const STATUS_STYLES: Record<string, { dot: string; label: string }> = {
    passed:  { dot: 'bg-emerald-500', label: 'Passed' },
    failed:  { dot: 'bg-red-500',     label: 'Failed' },
    running: { dot: 'bg-blue-500 animate-pulse', label: 'Running' },
    skipped: { dot: 'bg-gray-400',    label: 'Skipped' },
    pending: { dot: 'bg-gray-600',    label: 'Pending' },
    skip:    { dot: 'bg-gray-400',    label: 'Skipped' },
    pass:    { dot: 'bg-emerald-500', label: 'Passed' },
    fail:    { dot: 'bg-red-500',     label: 'Failed' },
  };

  if (rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        No stories found for this run
      </div>
    );
  }

  const passed = rows.filter(r => r.status === 'passed' || r.status === 'pass').length;
  const failed = rows.filter(r => r.status === 'failed' || r.status === 'fail').length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="shrink-0 px-4 py-2 border-b border-border text-xs text-muted flex items-center gap-3">
        <span>{rows.length} stories</span>
        {passed > 0 && <span className="text-emerald-500">{passed} passed</span>}
        {failed > 0 && <span className="text-red-500">{failed} failed</span>}
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.map((row, i) => {
          const style = STATUS_STYLES[row.status] ?? STATUS_STYLES.pending;
          const isExpanded = expandedStoryId === row.id;

          // Accordion data
          const contextFiles = contextComparison?.actual?.[row.id]?.contextFiles ?? [];
          const tokenEntry = tokenMap.get(row.id);
          const skillSuggestions = suggestedSkillsMap.get(row.id);
          const activeSkillsWithRelevance = row.activeSkills.map(name => ({
            name,
            relevance: skillSuggestions?.get(name)?.relevance ?? null,
            reason: skillSuggestions?.get(name)?.reason ?? null,
          }));

          const hasSkills = activeSkillsWithRelevance.length > 0;
          const hasContextFiles = contextFiles.length > 0;
          const hasTokens = tokenEntry != null && (tokenEntry.inputTokens > 0 || tokenEntry.outputTokens > 0);
          const hasAnyData = hasSkills || hasContextFiles || hasTokens;

          return (
            <div key={row.id} className={i % 2 === 0 ? 'bg-transparent' : 'bg-panel/30'}>
              {/* Story row */}
              <div className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className={`shrink-0 w-2 h-2 rounded-full ${style.dot}`} />
                <span className="font-mono text-xs text-muted shrink-0 w-[72px]">{row.id}</span>
                <span className="flex-1 truncate min-w-0">{row.title}</span>
                {row.elapsed && <span className="text-xs text-muted shrink-0">{row.elapsed}</span>}
                <span className={`text-xs shrink-0 ${row.status === 'passed' || row.status === 'pass' ? 'text-emerald-500' : row.status === 'failed' || row.status === 'fail' ? 'text-red-500' : row.status === 'running' ? 'text-blue-500' : 'text-muted'}`}>
                  {style.label}
                </span>
                {/* Context chevron */}
                <button
                  onClick={() => setExpandedStoryId(isExpanded ? null : row.id)}
                  className={`shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                    isExpanded
                      ? 'text-accent bg-accent/10'
                      : 'text-muted hover:text-[var(--text)] hover:bg-panel'
                  }`}
                  title={isExpanded ? 'Collapse context' : 'Expand context'}
                  aria-label={isExpanded ? 'Collapse context' : 'Expand context'}
                  aria-expanded={isExpanded}
                >
                  <ChevronRight
                    size={12}
                    className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
                  />
                  Context
                </button>
              </div>

              {/* Accordion drawer */}
              {isExpanded && (
                <div className="px-4 pb-3 pt-1 border-t border-border/50 bg-bg/40">
                  {!hasAnyData ? (
                    <p className="text-xs text-muted italic">No context data recorded for this story.</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {/* Skills */}
                      {hasSkills && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">Skills</p>
                          <div className="flex flex-wrap gap-1.5">
                            {activeSkillsWithRelevance.map(sk => (
                              <span key={sk.name} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 text-[11px] font-medium" title={sk.reason ?? undefined}>
                                {sk.name}
                                {sk.relevance != null && (
                                  <span className={`text-[10px] font-semibold ${sk.relevance >= 7 ? 'text-purple-300' : 'text-purple-500/70'}`}>
                                    {sk.relevance}/10
                                  </span>
                                )}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Context Files */}
                      {hasContextFiles && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">Context Files</p>
                          <div className="flex flex-wrap gap-1">
                            {contextFiles.map(f => (
                              <code key={f} className="px-1.5 py-0.5 rounded bg-panel text-[11px] font-mono text-accent/80 border border-border/60">
                                {f}
                              </code>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Tokens */}
                      {hasTokens && tokenEntry && (
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted mb-1.5">Tokens</p>
                          <div className="flex items-center gap-4 text-xs">
                            <span className="text-muted">
                              In: <span className="text-[var(--text)] font-mono">{tokenEntry.inputTokens.toLocaleString()}</span>
                            </span>
                            <span className="text-muted">
                              Out: <span className="text-[var(--text)] font-mono">{tokenEntry.outputTokens.toLocaleString()}</span>
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
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
          aria-label="Refresh commits"
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

// ─── Context Summary Bar ─────────────────────────────────────────────────────

function ContextSummaryBar({
  dbStories,
  contextComparison,
  storyTokenBreakdown,
  onContextClick,
}: {
  dbStories: StoryResultSeed[];
  contextComparison: ContextComparisonData | null;
  storyTokenBreakdown: StoryTokenEntry[];
  onContextClick: () => void;
}) {
  const { skillCount, fileCount, avgTokens } = useMemo(() => {
    // Unique skills across all story_results.active_skills
    const allSkills = new Set<string>();
    for (const s of dbStories) {
      if (s.active_skills) {
        try {
          const parsed = JSON.parse(s.active_skills);
          if (Array.isArray(parsed)) parsed.forEach((sk: string) => allSkills.add(sk));
        } catch { /* ignore */ }
      }
    }

    // Unique context file paths across contextComparison.actual
    const allFiles = new Set<string>();
    if (contextComparison?.actual) {
      for (const entry of Object.values(contextComparison.actual)) {
        if (Array.isArray(entry.contextFiles)) {
          entry.contextFiles.forEach(f => allFiles.add(f));
        }
      }
    }

    // Avg input tokens for stories that actually ran (inputTokens > 0)
    const tokenEntries = storyTokenBreakdown.filter(t => t.inputTokens > 0);
    const avg = tokenEntries.length > 0
      ? tokenEntries.reduce((sum, t) => sum + t.inputTokens, 0) / tokenEntries.length
      : 0;

    return { skillCount: allSkills.size, fileCount: allFiles.size, avgTokens: avg };
  }, [dbStories, contextComparison, storyTokenBreakdown]);

  if (skillCount === 0 && fileCount === 0 && avgTokens === 0) return null;

  const formatTokens = (n: number): string => {
    if (n >= 1000) return `~${(n / 1000).toFixed(1)}K`;
    return `~${Math.round(n)}`;
  };

  return (
    <div className="shrink-0 px-4 py-1.5 border-b border-border bg-panel flex items-center gap-3 text-xs text-muted">
      {skillCount > 0 && (
        <span className="flex items-center gap-1">
          <Sparkles size={11} className="text-purple-400 shrink-0" />
          <span>{skillCount} {skillCount === 1 ? 'skill' : 'skills'}</span>
        </span>
      )}
      {fileCount > 0 && (
        <>
          {skillCount > 0 && <span className="text-border">·</span>}
          <span className="flex items-center gap-1">
            <Files size={11} className="text-blue-400 shrink-0" />
            <span>{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
          </span>
        </>
      )}
      {avgTokens > 0 && (
        <>
          {(skillCount > 0 || fileCount > 0) && <span className="text-border">·</span>}
          <span className="flex items-center gap-1">
            <Cpu size={11} className="text-emerald-400 shrink-0" />
            <span>{formatTokens(avgTokens)} tokens/story</span>
          </span>
        </>
      )}
      <button
        onClick={onContextClick}
        className="ml-auto text-[10px] text-accent hover:underline shrink-0"
      >
        Context →
      </button>
    </div>
  );
}

// ─── Merge Status Types ─────────────────────────────────────────────────────

type MergeState = 'pending' | 'merging' | 'merged' | 'failed';

interface MergeInfo {
  state: MergeState;
  branchName?: string;
  commitSha?: string;
  conflictSummary?: string;
}

// ─── MergeStatusSection ─────────────────────────────────────────────────────

function MergeStatusSection({ mergeInfo, runId, onRetry }: {
  mergeInfo: MergeInfo;
  runId: number;
  onRetry: () => void;
}) {
  const [showFullConflict, setShowFullConflict] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, []);

  const { state, branchName, commitSha, conflictSummary } = mergeInfo;
  const shortSha = commitSha?.slice(0, 7) ?? '';

  return (
    <div data-testid="merge-status-section" className="shrink-0 px-3 md:px-4 py-2 border-b border-border bg-panel">
      <div className="flex items-center gap-2 text-xs">
        <GitMerge size={13} className="text-muted shrink-0" />
        <span className="text-muted font-medium">Auto-Merge</span>

        {state === 'pending' && (
          <span data-testid="merge-badge-pending" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-gray-500/10 text-gray-400">
            <Clock size={10} />
            Pending
          </span>
        )}

        {state === 'merging' && (
          <span data-testid="merge-badge-merging" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-500/10 text-amber-500">
            <Loader2 size={10} className="animate-spin" />
            Merging
          </span>
        )}

        {state === 'merged' && (
          <>
            <span data-testid="merge-badge-merged" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-emerald-500/10 text-emerald-500">
              <Check size={10} />
              Merged
            </span>
            {(branchName || shortSha) && (
              <button
                onClick={() => handleCopy(`${branchName ?? ''}${shortSha ? ` ${shortSha}` : ''}`)}
                title={copied ? 'Copied!' : 'Copy branch + SHA'}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono leading-none rounded bg-emerald-500/5 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10 transition-colors cursor-pointer"
              >
                {branchName && <span>{branchName}</span>}
                {shortSha && <span className="text-emerald-300">{shortSha}</span>}
              </button>
            )}
          </>
        )}

        {state === 'failed' && (
          <>
            <span data-testid="merge-badge-failed" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-red-500/10 text-red-500">
              <XCircle size={10} />
              Failed
            </span>
            <button
              onClick={onRetry}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-colors"
            >
              <RotateCcw size={10} />
              Retry Merge
            </button>
          </>
        )}
      </div>

      {/* Conflict summary for failed state */}
      {state === 'failed' && conflictSummary && (
        <div className="mt-1.5">
          <pre className="text-[10px] text-red-300/80 font-mono whitespace-pre-wrap break-all leading-relaxed bg-red-500/5 border border-red-500/10 rounded px-2 py-1.5 max-h-20 overflow-y-auto">
            {showFullConflict ? conflictSummary : conflictSummary.slice(0, 500)}
            {!showFullConflict && conflictSummary.length > 500 && '...'}
          </pre>
          {conflictSummary.length > 500 && (
            <button
              onClick={() => setShowFullConflict(!showFullConflict)}
              className="text-[10px] text-muted hover:text-[var(--text)] mt-0.5"
            >
              {showFullConflict ? 'Show less' : 'Show full'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── PR Status Types ─────────────────────────────────────────────────────────

type PrState = 'creating' | 'created' | 'failed';

interface PrInfo {
  state: PrState;
  prNumber?: number;
  prUrl?: string;
  errorMsg?: string;
}

// ─── PrStatusSection ─────────────────────────────────────────────────────────

function PrStatusSection({ prInfo, owner, repo }: {
  prInfo: PrInfo;
  owner?: string;
  repo?: string;
}) {
  const { state, prNumber, prUrl, errorMsg } = prInfo;

  const resolvedUrl = prUrl ?? (prNumber && owner && repo
    ? `https://github.com/${owner}/${repo}/pull/${prNumber}`
    : null);

  return (
    <div data-testid="pr-status-section" className="shrink-0 px-3 md:px-4 py-2 border-b border-border bg-panel">
      <div className="flex items-center gap-2 text-xs">
        <GitPullRequest size={13} className="text-muted shrink-0" />
        <span className="text-muted font-medium">Auto-PR</span>

        {state === 'creating' && (
          <span data-testid="pr-badge-creating" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-500/10 text-amber-500">
            <Loader2 size={10} className="animate-spin" />
            Creating pull request...
          </span>
        )}

        {state === 'created' && prNumber && (
          <>
            <span data-testid="pr-badge-created" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-emerald-500/10 text-emerald-500">
              <Check size={10} />
              PR Created
            </span>
            {resolvedUrl ? (
              <a
                href={resolvedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono leading-none rounded bg-emerald-500/5 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/10 transition-colors"
              >
                #{prNumber}
                <ExternalLink size={9} />
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-mono leading-none rounded bg-emerald-500/5 border border-emerald-500/20 text-emerald-400">
                #{prNumber}
              </span>
            )}
          </>
        )}

        {state === 'failed' && (
          <span data-testid="pr-badge-failed" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-500/10 text-amber-500">
            <AlertTriangle size={10} />
            PR creation failed
          </span>
        )}
      </div>

      {/* Error details for failed state */}
      {state === 'failed' && errorMsg && (
        <div className="mt-1.5">
          <pre className="text-[10px] text-amber-300/80 font-mono whitespace-pre-wrap break-all leading-relaxed bg-amber-500/5 border border-amber-500/10 rounded px-2 py-1.5 max-h-16 overflow-y-auto">
            {errorMsg}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── WorkflowDispatchStatusSection (US-026) ──────────────────────────────────

type WorkflowDispatchState = 'dispatching' | 'dispatched' | 'failed';

interface WorkflowDispatchInfo {
  state: WorkflowDispatchState;
  workflowId?: string;
  errorMsg?: string;
}

function WorkflowDispatchStatusSection({ dispatchInfo }: { dispatchInfo: WorkflowDispatchInfo }) {
  const { state, workflowId, errorMsg } = dispatchInfo;
  return (
    <div data-testid="workflow-dispatch-status-section" className="shrink-0 px-3 md:px-4 py-2 border-b border-border bg-panel">
      <div className="flex items-center gap-2 text-xs">
        <Zap size={13} className="text-muted shrink-0" />
        <span className="text-muted font-medium">Workflow Dispatch</span>

        {state === 'dispatching' && (
          <span data-testid="workflow-badge-dispatching" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-500/10 text-amber-500">
            <Loader2 size={10} className="animate-spin" />
            Triggering workflow...
          </span>
        )}

        {state === 'dispatched' && (
          <span data-testid="workflow-badge-dispatched" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-emerald-500/10 text-emerald-500">
            <Check size={10} />
            Workflow triggered{workflowId ? ` — ${workflowId}` : ''}
          </span>
        )}

        {state === 'failed' && (
          <span data-testid="workflow-badge-failed" className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded bg-amber-500/10 text-amber-500">
            <AlertTriangle size={10} />
            Workflow dispatch failed{workflowId ? ` — ${workflowId}` : ''}
          </span>
        )}
      </div>

      {state === 'failed' && errorMsg && (
        <div className="mt-1.5">
          <pre className="text-[10px] text-amber-300/80 font-mono whitespace-pre-wrap break-all leading-relaxed bg-amber-500/5 border border-amber-500/10 rounded px-2 py-1.5 max-h-16 overflow-y-auto">
            {errorMsg}
          </pre>
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

export default function RunViewPanel({ runId, onBack, onNavigate: _onNavigate }: RunViewPanelProps) {
  const { workspaceId } = useWorkspace();
  const isMobile = useIsMobile();
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<RunViewTab>('terminal');
  const terminalRef = useRef<RunTerminalHandle>(null);
  const [pauseLoading, setPauseLoading] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const [hitlContext, setHitlContext] = useState('');
  const [hitlSending, setHitlSending] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);

  // DLQ state — checked once when run transitions to 'failed'
  const [dlqEntry, setDlqEntry] = useState<DlqEntry | null>(null);
  const [showDlqModal, setShowDlqModal] = useState(false);
  const [dlqRetryLoading, setDlqRetryLoading] = useState(false);
  const dlqCheckedRef = useRef(false);

  const [specModel, setSpecModel] = useState<string | null>(null);
  const [tokenSummary, setTokenSummary] = useState({ inputTokens: 0, outputTokens: 0 });
  const [contextComparison, setContextComparison] = useState<ContextComparisonData | null>(null);
  const [totalStories, setTotalStories] = useState(0);
  const [dbStories, setDbStories] = useState<StoryResultSeed[]>([]);
  const [specStories, setSpecStories] = useState<{ id: string; title: string; suggestedSkills?: Array<{ name: string; relevance: number; reason: string }> }[]>([]);
  const [storyTokenBreakdown, setStoryTokenBreakdown] = useState<StoryTokenEntry[]>([]);
  const [runState, setRunState] = useState<RunStateSnapshot | null>(null);
  // Seed from story_results on initial load so graph colors are correct for in-progress/historical runs
  const [seedStatuses, setSeedStatuses] = useState<Map<string, DerivedStatus>>(new Map());

  // Merge status — base state seeded from pipeline_runs, derived state from SSE
  const [mergeInfoBase, setMergeInfoBase] = useState<MergeInfo | null>(null);

  // PR status — base state seeded from pipeline_runs, derived state from SSE (US-028)
  const [prInfoBase, setPrInfoBase] = useState<PrInfo | null>(null);

  // Workflow dispatch status — derived from SSE events only (US-026), no DB seed needed

  // Resume badge — shown when previously_passed stories were pre-seeded by the trigger
  const [showResumeBadge, setShowResumeBadge] = useState(false);
  const [resumeFromId, setResumeFromId] = useState<string | null>(null);
  const [resumePrePassedCount, setResumePrePassedCount] = useState(0);
  const resumeBadgeDismissedRef = useRef(false);

  // Filter tabs for mobile — hide Graph (too complex for small screens)
  const visibleTabs = useMemo(() => {
    if (isMobile) return TABS.filter((t) => t.id !== 'graph');
    return TABS;
  }, [isMobile]);

  const handleTabChange = useCallback((tab: RunViewTab) => {
    setActiveTab(tab);
  }, []);

  // SSE for live status updates — scoped to workspace
  const walEvents = usePipelineSSE(String(runId), workspaceId);

  const resumeSummary = useMemo<ResumeSummary | null>(() => {
    const finishedIds = new Set([
      ...(runState?.completedStories ?? []).map((story) => story.storyId),
      ...(runState?.failedStories ?? []).map((story) => story.storyId),
      ...(runState?.skippedStories ?? []).map((story) => story.storyId),
    ]);
    const lastStartedStoryId = [...walEvents]
      .reverse()
      .find((event) => event.event_type === 'story_started' && event.story_id)?.story_id ?? null;

    let carriedForwardCount = runState?.completedStories.length ?? 0;
    let continueFromId = runState?.currentStory
      ?? specStories.find((story) => !finishedIds.has(story.id))?.id
      ?? lastStartedStoryId
      ?? null;
    let resumedAfterId = runState?.resumedFromStory ?? null;

    if ((!runState || carriedForwardCount === 0) && continueFromId && specStories.length > 0) {
      const continueIndex = specStories.findIndex((story) => story.id === continueFromId);
      if (continueIndex > 0) {
        carriedForwardCount = continueIndex;
        resumedAfterId = resumedAfterId ?? specStories[continueIndex - 1]?.id ?? null;
      }
    }

    if (!continueFromId && !resumedAfterId && carriedForwardCount === 0) return null;
    return { continueFromId, resumedAfterId, carriedForwardCount };
  }, [runState, specStories, walEvents]);

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

  // Derive setup phase state for wave parallel runs (worktree creation before stories start)
  const { isInSetupPhase, setupStoryCount } = useMemo(() => {
    let setupStarted = false;
    let storyCount = 0;
    let setupDone = false;
    let anyStoryStarted = false;
    for (const evt of walEvents) {
      if (evt.event_type === 'run_setup_started') {
        setupStarted = true;
        try {
          const p = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload;
          storyCount = p?.story_count ?? 0;
        } catch { /* ignore */ }
      } else if (evt.event_type === 'run_setup_done') {
        setupDone = true;
      } else if (evt.event_type === 'story_started') {
        anyStoryStarted = true;
      }
    }
    return {
      isInSetupPhase: setupStarted && !setupDone && !anyStoryStarted,
      setupStoryCount: storyCount,
    };
  }, [walEvents]);

  // Derive per-story live statuses: seed from DB results, then overlay live SSE events
  const liveStatuses = useMemo(() => {
    // Start with DB-seeded statuses (covers stories that ran before we subscribed to SSE)
    const map = new Map<string, DerivedStatus>(seedStatuses);
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
  }, [walEvents, seedStatuses]);

  // CTM-004: Per-story context map for the Stories accordion. Combines:
  //   - skills from spec suggestedSkills (relevance/reason) ∪ executed active_skills
  //   - injected/context files from contextComparison.actual (fallback predicted)
  //   - per-story token usage from storyTokenBreakdown
  // Keyed by story ID; tolerates older runs where any source is absent.
  const storyContextMap = useMemo(() => {
    const map = new Map<string, StoryContextInfo>();

    // Suggested skills (with relevance) keyed by story
    const suggestedByStory = new Map<string, Map<string, { relevance: number; reason: string }>>();
    for (const s of specStories) {
      if (Array.isArray(s.suggestedSkills) && s.suggestedSkills.length > 0) {
        const inner = new Map<string, { relevance: number; reason: string }>();
        for (const sk of s.suggestedSkills) inner.set(sk.name, { relevance: sk.relevance, reason: sk.reason });
        suggestedByStory.set(s.id, inner);
      }
    }

    // Active (executed) skills from DB story_results
    const activeByStory = new Map<string, string[]>();
    for (const s of dbStories) {
      if (s.active_skills) {
        try {
          const parsed = JSON.parse(s.active_skills);
          if (Array.isArray(parsed)) activeByStory.set(s.story_id, parsed.filter((x): x is string => typeof x === 'string'));
        } catch { /* ignore */ }
      }
    }

    // Token usage keyed by story
    const tokenByStory = new Map<string, StoryTokenEntry>();
    for (const t of storyTokenBreakdown) tokenByStory.set(t.storyId, t);

    // Union of all story IDs that have any context data
    const ids = new Set<string>();
    for (const s of specStories) ids.add(s.id);
    for (const id of activeByStory.keys()) ids.add(id);
    for (const id of tokenByStory.keys()) ids.add(id);
    if (contextComparison?.actual) for (const id of Object.keys(contextComparison.actual)) ids.add(id);
    if (contextComparison?.predicted) for (const id of Object.keys(contextComparison.predicted)) ids.add(id);

    for (const id of ids) {
      // Skills: prefer executed active_skills; fall back to suggested. Attach relevance from suggested.
      const suggested = suggestedByStory.get(id);
      const active = activeByStory.get(id) ?? [];
      const skillNames = active.length > 0 ? active : (suggested ? Array.from(suggested.keys()) : []);
      const skills = skillNames.map(name => ({
        name,
        relevance: suggested?.get(name)?.relevance ?? null,
        reason: suggested?.get(name)?.reason ?? null,
      }));

      // Files: actual context files preferred; fall back to predicted injected files
      const contextFiles = contextComparison?.actual?.[id]?.contextFiles
        ?? contextComparison?.predicted?.[id]?.injectedFiles
        ?? [];

      const tokens = tokenByStory.get(id);
      const info: StoryContextInfo = {
        skills,
        contextFiles,
        inputTokens: tokens?.inputTokens ?? 0,
        outputTokens: tokens?.outputTokens ?? 0,
      };

      // Only include stories that actually carry context data
      if (info.skills.length > 0 || info.contextFiles.length > 0 || info.inputTokens > 0 || info.outputTokens > 0) {
        map.set(id, info);
      }
    }

    return map;
  }, [specStories, dbStories, storyTokenBreakdown, contextComparison]);

  // US-008: Story completion markers are now injected server-side into run_output_chunks
  // by marker-injector.ts — they arrive via the chunk SSE stream and are replayed for late-joiners.

  // Derive merge status: start from DB base, overlay SSE events (like effectiveStatus pattern)
  const mergeInfo = useMemo<MergeInfo | null>(() => {
    let info = mergeInfoBase;
    for (const evt of walEvents) {
      if (evt.event_type === 'worktree_merge_started') {
        info = { ...info, state: 'merging', branchName: info?.branchName };
      } else if (evt.event_type === 'worktree_merged') {
        try {
          const p = evt.payload ? (typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload as Record<string, unknown>) : {};
          info = { state: 'merged', branchName: p.branchName, commitSha: p.mergeCommitSha };
        } catch {
          info = { ...info, state: 'merged' };
        }
      } else if (evt.event_type === 'worktree_merge_failed') {
        try {
          const p = evt.payload ? (typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload as Record<string, unknown>) : {};
          info = { state: 'failed', branchName: p.branchName, conflictSummary: p.conflictSummary || p.message };
        } catch {
          info = { ...info, state: 'failed' };
        }
      }
    }
    return info;
  }, [mergeInfoBase, walEvents]);

  // Derive PR status: start from DB base, overlay SSE events (US-028)
  const prInfo = useMemo<PrInfo | null>(() => {
    let info = prInfoBase;
    for (const evt of walEvents) {
      if (evt.event_type === 'pr_creating') {
        info = { state: 'creating' };
      } else if (evt.event_type === 'pr_created' || evt.event_type === 'pr_updated' || evt.event_type === 'pr_draft_created' || evt.event_type === 'pr_ready') {
        try {
          const p = JSON.parse(evt.payload ?? '{}');
          info = { state: 'created', prNumber: p.pr_number, prUrl: p.pr_url };
        } catch {
          info = { ...info, state: 'created' };
        }
      } else if (evt.event_type === 'pr_creation_failed') {
        try {
          const p = JSON.parse(evt.payload ?? '{}');
          info = { state: 'failed', errorMsg: p.error };
        } catch {
          info = { state: 'failed' };
        }
      }
    }
    return info;
  }, [prInfoBase, walEvents]);

  // Derive workflow dispatch status from SSE events (US-026)
  const workflowInfo = useMemo<WorkflowDispatchInfo | null>(() => {
    let info: WorkflowDispatchInfo | null = null;
    for (const evt of walEvents) {
      if (evt.event_type === 'workflow_dispatching') {
        try {
          const p = JSON.parse(evt.payload ?? '{}');
          info = { state: 'dispatching', workflowId: p.workflow_id };
        } catch {
          info = { state: 'dispatching' };
        }
      } else if (evt.event_type === 'workflow_dispatched') {
        try {
          const p = JSON.parse(evt.payload ?? '{}');
          info = { state: 'dispatched', workflowId: p.workflow_id };
        } catch {
          info = { ...info, state: 'dispatched' };
        }
      } else if (evt.event_type === 'workflow_dispatch_failed') {
        try {
          const p = JSON.parse(evt.payload ?? '{}');
          info = { state: 'failed', workflowId: p.workflow_id, errorMsg: p.error };
        } catch {
          info = { state: 'failed' };
        }
      }
    }
    return info;
  }, [walEvents]);

  const fetchRun = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const data = await apiFetch<RunApiResponse>(`/api/pipeline/runs/${runId}`);
      // Validate the run belongs to the current workspace
      if (data.run.workspace_id && String(data.run.workspace_id) !== String(workspaceId)) {
        setLoading(false);
        return;
      }
      setRun(data.run);
      // Seed merge status from DB column or infer from worktree presence
      if (data.run.merge_status) {
        setMergeInfoBase({
          state: data.run.merge_status as MergeState,
          branchName: data.run.branch_name ?? undefined,
          commitSha: data.run.merge_commit_sha ?? undefined,
          conflictSummary: data.run.merge_error ?? undefined,
        });
      } else if (data.run.worktree_path || data.run.branch_name) {
        // Worktree run without merge_status yet — show pending while running
        setMergeInfoBase({
          state: 'pending',
          branchName: data.run.branch_name ?? undefined,
        });
      }
      // Seed PR status from DB columns (US-028)
      if (data.run.pr_number != null) {
        setPrInfoBase({ state: 'created', prNumber: data.run.pr_number });
      } else if (data.run.pr_creating) {
        setPrInfoBase({ state: 'creating' });
      } else if (data.run.pr_creation_error) {
        setPrInfoBase({ state: 'failed', errorMsg: data.run.pr_creation_error });
      }
      if (data.specModel !== undefined) setSpecModel(data.specModel);
      if (data.tokenSummary) setTokenSummary(data.tokenSummary);
      if (data.runState !== undefined) setRunState(data.runState ?? null);
      if (data.contextComparison !== undefined) setContextComparison(data.contextComparison ?? null);
      if (data.specStories) { setTotalStories(data.specStories.length); setSpecStories(data.specStories); }
      if (data.stories) {
        setDbStories(data.stories);
        // Resume badge: show when any pre-seeded 'previously_passed' skip rows exist
        if (!resumeBadgeDismissedRef.current) {
          const prePassed = data.stories.filter(s => s.status === 'skip' && s.reason === 'previously_passed');
          if (prePassed.length > 0 && data.specStories?.length) {
            // firstUnpassedId = first specStory not in prePassed set
            const prePassedIds = new Set(prePassed.map(s => s.story_id));
            const firstUnpassed = data.specStories.find(s => !prePassedIds.has(s.id));
            setResumePrePassedCount(prePassed.length);
            setResumeFromId(firstUnpassed?.id ?? null);
            setShowResumeBadge(true);
          }
        }
      }
      if (data.storyTokenBreakdown) setStoryTokenBreakdown(data.storyTokenBreakdown);
      // Seed graph colors from DB story results so nodes aren't all grey on load
      if (data.stories?.length) {
        const seed = new Map<string, DerivedStatus>();
        const DB_STATUS: Record<string, DerivedStatus['status']> = {
          pass: 'passed', fail: 'failed', skip: 'skipped',
        };
        for (const s of data.stories) {
          const status = DB_STATUS[s.status] ?? 'running';
          const elapsed = s.elapsed_seconds != null ? `${s.elapsed_seconds}s` : '';
          seed.set(s.story_id, { storyId: s.story_id, status, startedAt: s.started_at, elapsed });
        }
        setSeedStatuses(seed);
      }
    } catch {
      // run not found
    }
    setLoading(false);
  }, [runId, workspaceId]);

  useEffect(() => {
    fetchRun();
  }, [fetchRun]);

  // Dismiss resume badge when first real story_started WAL event fires
  useEffect(() => {
    if (!showResumeBadge || resumeBadgeDismissedRef.current) return;
    const hasRealStart = walEvents.some(e => e.event_type === 'story_started');
    if (hasRealStart) {
      resumeBadgeDismissedRef.current = true;
      setShowResumeBadge(false);
    }
  }, [walEvents, showResumeBadge]);

  // Auto-dismiss resume badge after 30 seconds as fallback
  useEffect(() => {
    if (!showResumeBadge) return;
    const timer = setTimeout(() => {
      resumeBadgeDismissedRef.current = true;
      setShowResumeBadge(false);
    }, 30_000);
    return () => clearTimeout(timer);
  }, [showResumeBadge]);

  // Check DLQ once when run transitions to 'failed' (terminal state — no polling needed)
  useEffect(() => {
    if (effectiveStatus !== 'failed' || dlqCheckedRef.current) return;
    dlqCheckedRef.current = true;
    getRunDlq(runId).then(entry => setDlqEntry(entry)).catch(() => { /* 404 = not in DLQ */ });
  }, [effectiveStatus, runId]);

  const handleDlqRetry = useCallback(async () => {
    setDlqRetryLoading(true);
    try {
      const result = await retryRunFromDlq(runId);
      if (result.runId) {
        setShowDlqModal(false);
        // Navigate to new run
        window.location.href = `/runs/${result.runId}`;
      }
    } catch (err) {
      console.error('[RunView] DLQ retry failed:', err);
    } finally {
      setDlqRetryLoading(false);
    }
  }, [runId]);

  const handleRetryMerge = useCallback(async () => {
    try {
      await apiFetch(`/api/pipeline/runs/${runId}/retry-merge`, { method: 'POST' });
      setMergeInfoBase((prev) => prev ? { ...prev, state: 'merging' } : { state: 'merging' });
    } catch (err) {
      console.error('[RunView] Retry merge failed:', err);
    }
  }, [runId]);

  // Show merge section when run uses a worktree (auto-merge is always enabled for worktree runs)
  const showMergeStatus = mergeInfo !== null;

  const isActive = effectiveStatus === 'running' || effectiveStatus === 'paused' || effectiveStatus === 'blocked';

  // Detect if we should show multi-pane terminal (parallelism > 1 with 2+ concurrent stories)
  const useMultiPane = useMemo(() => {
    if (!run || run.terminal_mode === 'pty' || (run.parallelism ?? 1) <= 1) return false;
    // Count stories that have started but not finished
    const started = new Set<string>();
    const finished = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started') started.add(evt.story_id);
      if (evt.event_type === 'story_passed' || evt.event_type === 'story_failed' || evt.event_type === 'story_skipped') {
        finished.add(evt.story_id);
      }
    }
    // Check if at any point 2+ stories were concurrently running
    // (once we detect multi-pane mode, we stay in it for the duration of the run)
    return started.size >= 2;
  }, [run, walEvents]);

  // Count currently-active stories (started but not completed) for parallel banner
  const activeStoryCount = useMemo(() => {
    const active = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_started') {
        active.add(evt.story_id);
      } else if (
        evt.event_type === 'story_passed' ||
        evt.event_type === 'story_failed' ||
        evt.event_type === 'story_skipped'
      ) {
        active.delete(evt.story_id);
      }
    }
    return active.size;
  }, [walEvents]);

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

  // Derive failed story IDs from WAL events
  const failedStoryIds = useMemo(() => {
    const failed = new Set<string>();
    const passed = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_failed') {
        failed.add(evt.story_id);
        passed.delete(evt.story_id);
      } else if (evt.event_type === 'story_passed') {
        passed.add(evt.story_id);
        failed.delete(evt.story_id);
      }
    }
    return failed;
  }, [walEvents]);

  const failedStoryCount = failedStoryIds.size;

  // Derive passed story count
  const passedStoryCount = useMemo(() => {
    const passed = new Set<string>();
    for (const evt of walEvents) {
      if (!evt.story_id) continue;
      if (evt.event_type === 'story_passed') passed.add(evt.story_id);
      else if (evt.event_type === 'story_failed') passed.delete(evt.story_id);
    }
    return passed.size;
  }, [walEvents]);

  // Derive root cause analysis for wave failure banner:
  // rootCause = the story(s) that actually ran and failed (not blocked)
  // blockedCount = stories blocked because of root cause failures
  const waveFailureInfo = useMemo(() => {
    if (passedStoryCount > 0) return null; // only show for 0/N pass runs
    if (effectiveStatus !== 'failed' && effectiveStatus !== 'partial_failure') return null;

    const rootCauses: string[] = [];
    const blockedStories = new Map<string, string[]>(); // storyId -> blockedBy[]

    for (const evt of walEvents) {
      if (evt.event_type !== 'story_failed' || !evt.story_id || !evt.payload) continue;
      try {
        const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) : evt.payload as Record<string, unknown>;
        if (payload.reason === 'blocked_by' && Array.isArray(payload.blockedBy)) {
          blockedStories.set(evt.story_id, payload.blockedBy);
        } else {
          rootCauses.push(evt.story_id);
        }
      } catch { /* ignore */ }
    }

    if (rootCauses.length === 0) return null;

    // Find the primary root cause (first story that failed and blocked the most downstream)
    const primaryRoot = rootCauses[0];
    const downstreamCount = blockedStories.size;

    return { primaryRoot, rootCauses, downstreamCount };
  }, [walEvents, passedStoryCount, effectiveStatus]);

  const handleRetryFailed = useCallback(async () => {
    if (failedStoryCount === 0) return;
    setRetryLoading(true);
    try {
      const result = await retryRun(runId, {
        storyIds: [...failedStoryIds],
        workspaceId: workspaceId ?? undefined,
      });
      // Navigate to the new retry run — reload clears stale state
      if (result.runId) {
        handleTabChange('terminal');
        window.location.reload();
      }
    } catch (err) {
      console.error('[RunView] Retry failed:', err);
    } finally {
      setRetryLoading(false);
    }
  }, [runId, failedStoryIds, failedStoryCount, workspaceId]);

  const handleViewErrorDetail = useCallback(() => {
    // Switch to terminal tab and scroll to the last failed story
    handleTabChange('terminal');
    // Find last failed story ID from WAL events
    let lastFailedId: string | null = null;
    for (const evt of walEvents) {
      if (evt.event_type === 'story_failed' && evt.story_id) {
        lastFailedId = evt.story_id;
      }
    }
    if (lastFailedId && terminalRef.current) {
      setTimeout(() => terminalRef.current?.scrollToStory(lastFailedId!), 100);
    }
  }, [walEvents, handleTabChange]);

  if (loading) {
    return <RunViewSkeleton />;
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
            left={
              <div className="h-full flex flex-col min-h-0">
                {activeStoryCount >= 2 && (
                  <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20">
                    <Zap size={12} className="text-emerald-500 animate-pulse" />
                    <span className="text-xs font-medium text-emerald-500">
                      {activeStoryCount} stories running in parallel
                    </span>
                  </div>
                )}
                <div className="flex-1 min-h-0">
                  {useMultiPane
                    ? <MultiPaneTerminal runId={run.id} walEvents={walEvents} />
                    : <RunTerminal
                        ref={terminalRef}
                        runId={run.id}
                        workspaceId={workspaceId}
                        terminalMode={run.terminal_mode ?? 'ansi-html'}
                        runStatus={effectiveStatus}
                      />}
                </div>
              </div>
            }
            right={
              <div className="h-full flex flex-col min-h-0">
                <div className="flex-1 min-h-0 overflow-hidden">
                  <RunStoryList
                    runId={run.id}
                    walEvents={walEvents}
                    runState={runState}
                    resumeSummary={resumeSummary}
                    onStoryClick={useMultiPane ? undefined : (storyId) => terminalRef.current?.scrollToStory(storyId)}
                    parallelism={run.parallelism}
                    includeGraph={run.include_graph}
                    storyContext={storyContextMap}
                  />
                </div>
                <RunMetadataPanel
                  run={run}
                  tokenSummary={tokenSummary}
                  specModel={specModel}
                  totalStories={totalStories}
                  walEvents={walEvents}
                  onKill={() => setShowKillConfirm(true)}
                  contextComparison={contextComparison}
                  resumeSummary={resumeSummary}
                />
              </div>
            }
          />
        );
      case 'stories':
        return (
          <RunStoryList
            runId={run.id}
            walEvents={walEvents}
            runState={runState}
            resumeSummary={resumeSummary}
            onStoryClick={(storyId) => {
              handleTabChange('terminal');
              setTimeout(() => terminalRef.current?.scrollToStory(storyId), 100);
            }}
            parallelism={run.parallelism}
            includeGraph={run.include_graph}
            storyContext={storyContextMap}
          />
        );
      case 'inspector':
        return (
          <ContextInspector
            runId={run.id}
            runSettled={effectiveStatus !== 'running' && effectiveStatus !== 'paused' && effectiveStatus !== 'blocked'}
          />
        );
      case 'graph':
        if (isMobile) {
          return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
              <Smartphone size={32} className="text-muted opacity-40" />
              <span className="text-sm font-medium text-muted">Graph view unavailable on mobile</span>
              <span className="text-xs text-muted/70">
                The dependency graph requires a larger screen to display interactive node connections. Open Rorca on a desktop browser to use this view.
              </span>
              <button
                onClick={() => handleTabChange('terminal')}
                className="mt-2 px-3 py-1.5 text-xs font-medium rounded border border-border text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
              >
                Switch to Execution Trace
              </button>
            </div>
          );
        }
        return (
          <InteractiveDependencyGraph
            specId={extractSpecId(run.spec_path)}
            workspaceId={run.workspace_id}
            runId={run.id}
            liveStatuses={liveStatuses}
          />
        );
      case 'skills':
        return <SkillsTab runId={run.id} />;
      case 'finops':
        return <FinOpsTab runId={run.id} isActive={isActive} />;
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
      <AppHeader
        breadcrumbs={
          <div className="flex items-center gap-1.5 md:gap-2 min-w-0">
            <h1 className="text-xs md:text-sm font-semibold text-[var(--text)] truncate capitalize">
              {specLabel(run.spec_path)}
            </h1>
            <span className="text-[10px] md:text-xs text-muted font-mono shrink-0">#{run.id}</span>
            <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 ${STATUS_BADGE_STYLES[effectiveStatus] || 'bg-gray-500/10 text-gray-400'}`} aria-live="polite">
              {STATUS_BADGE_LABELS[effectiveStatus] || effectiveStatus}
            </span>
            {run.parallelism != null && run.parallelism > 1 && !isMobile && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 bg-purple-500/10 text-purple-500">
                <Layers size={10} />
                Parallelism: {run.parallelism}
              </span>
            )}
            <AgentBadge agentType={run.agentType} agentModel={run.agentModel} />
            {/* DLQ badge — shown when run's pg-boss job exhausted all retries */}
            {dlqEntry && (
              <button
                onClick={() => setShowDlqModal(true)}
                title="Job exhausted all retries — click for details"
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 transition-colors"
              >
                <MailWarning size={10} />
                DLQ
              </button>
            )}
            {/* Resume badge — shown briefly when previously_passed stories were pre-seeded */}
            {showResumeBadge && resumeFromId && (
              <span
                title={`${resumePrePassedCount} ${resumePrePassedCount === 1 ? 'story' : 'stories'} already passed — resuming from ${resumeFromId}`}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold leading-none rounded shrink-0 bg-amber-500/10 text-amber-500"
              >
                <RotateCcw size={10} />
                Resuming from {resumeFromId} — {resumePrePassedCount} {resumePrePassedCount === 1 ? 'story' : 'stories'} already passed
              </span>
            )}
          </div>
        }
        actions={
          <div className="flex items-center gap-1 md:gap-1.5 shrink-0 justify-end flex-wrap pb-1 pt-1 pr-2">
            {/* Pause / Resume */}
            <button
              onClick={handlePauseResume}
              disabled={!isActive || pauseLoading}
              title={effectiveStatus === 'paused' ? 'Resume run' : 'Pause run'}
              aria-label={effectiveStatus === 'paused' ? 'Resume run' : 'Pause run'}
              className={`p-1.5 rounded-lg transition-colors min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center ${isActive && !pauseLoading
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
              aria-label="Kill run"
              className={`p-1.5 rounded-lg transition-colors min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center ${isActive && !killLoading
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
            <div className="w-px h-4 bg-border mx-1" />
            <button
              onClick={onBack}
              className="p-1.5 rounded-lg hover:bg-bg transition-colors text-muted hover:text-[var(--text)] min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center"
              title="Close details"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        }
      />

      {/* Kill confirmation dialog */}
      {showKillConfirm && (
        <KillConfirmDialog
          onConfirm={handleKill}
          onCancel={() => setShowKillConfirm(false)}
        />
      )}

      {/* DLQ detail modal */}
      {showDlqModal && dlqEntry && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowDlqModal(false)}
        >
          <div
            className="relative bg-[var(--bg-elevated)] border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 p-6 flex flex-col gap-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <MailWarning size={18} className="text-amber-500 shrink-0" />
              <h2 className="text-sm font-semibold text-[var(--text)]">Dead-Letter Queue</h2>
              <span className="ml-auto text-[10px] font-mono text-muted">Job {dlqEntry.jobId.slice(0, 8)}…</span>
              <button onClick={() => setShowDlqModal(false)} className="p-1 rounded hover:bg-bg text-muted hover:text-[var(--text)]">
                <X size={14} />
              </button>
            </div>

            <div className="text-xs text-muted space-y-1">
              <div className="flex gap-2">
                <span className="text-[var(--text)] font-medium w-20 shrink-0">Attempts</span>
                <span>{dlqEntry.attempts}</span>
              </div>
              <div className="flex gap-2">
                <span className="text-[var(--text)] font-medium w-20 shrink-0">Failed at</span>
                <span>{new Date(dlqEntry.failedAt).toLocaleString()}</span>
              </div>
            </div>

            {dlqEntry.lastError && (
              <div className="rounded-lg bg-red-500/5 border border-red-500/20 p-3">
                <p className="text-[10px] font-semibold text-red-400 mb-1">Last error</p>
                <pre className="text-[10px] text-red-300 whitespace-pre-wrap break-all font-mono leading-relaxed max-h-40 overflow-y-auto">
                  {dlqEntry.lastError}
                </pre>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setShowDlqModal(false)}
                className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-[var(--text)] hover:bg-bg transition-colors"
              >
                Dismiss
              </button>
              <button
                onClick={handleDlqRetry}
                disabled={dlqRetryLoading}
                className="px-3 py-1.5 text-xs rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {dlqRetryLoading ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                Retry from DLQ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Context usage summary bar */}
      <ContextSummaryBar
        dbStories={dbStories}
        contextComparison={contextComparison}
        storyTokenBreakdown={storyTokenBreakdown}
        onContextClick={() => handleTabChange('inspector')}
      />

      {/* Merge status — visible only for worktree runs with auto-merge */}
      {showMergeStatus && mergeInfo && (
        <MergeStatusSection
          mergeInfo={mergeInfo}
          runId={run.id}
          onRetry={handleRetryMerge}
        />
      )}

      {/* PR status — visible when auto-PR is in progress, created, or failed (US-028) */}
      {prInfo && (
        <PrStatusSection prInfo={prInfo} />
      )}

      {/* Workflow dispatch status — visible when dispatch is triggered (US-026) */}
      {workflowInfo && (
        <WorkflowDispatchStatusSection dispatchInfo={workflowInfo} />
      )}

      {/* Tab bar — scrollable horizontal strip on mobile */}
      <div className="shrink-0 px-2 md:px-4 border-b border-border bg-panel flex items-center gap-0.5 overflow-x-auto scrollbar-none [-webkit-overflow-scrolling:touch]">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const isActiveTab = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              aria-current={isActiveTab ? 'page' : undefined}
              className={`flex items-center gap-1.5 px-3 py-2.5 md:py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors shrink-0 ${isActiveTab
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

      {/* Wave setup phase banner — shown while worktrees are being created */}
      {isInSetupPhase && (
        <div className="shrink-0 border-b border-blue-500/30 bg-blue-500/10" role="status" aria-live="polite">
          <div className="px-4 py-2.5 flex items-center gap-2">
            <Loader2 size={16} className="text-blue-400 shrink-0 animate-spin" />
            <span className="text-sm font-medium text-blue-400">
              Preparing {setupStoryCount || ''} parallel worktree{setupStoryCount !== 1 ? 's' : ''}…
            </span>
          </div>
        </div>
      )}

      {/* HITL blocked banner */}
      {effectiveStatus === 'blocked' && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10" role="alert" aria-live="assertive">
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
              aria-label="Instructions or context for the agent"
              className="flex-1 min-h-[60px] max-h-[120px] px-3 py-2 text-sm rounded-lg border border-amber-500/30 bg-bg text-[var(--text)] placeholder:text-muted resize-y focus:outline-none focus:ring-1 focus:ring-amber-500/50"
              disabled={hitlSending}
            />
            <button
              onClick={handleSendContext}
              disabled={!hitlContext.trim() || hitlSending}
              title="Send context and resume"
              aria-label="Send context and resume"
              className={`self-end px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-1.5 transition-colors ${hitlContext.trim() && !hitlSending
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

      {/* Run failed banner — root cause analysis for wave failures */}
      {(effectiveStatus === 'failed' || effectiveStatus === 'partial_failure') && failedStoryCount > 0 && (
        <div className="shrink-0 border-b border-red-500/30 bg-red-500/10" role="alert" aria-live="assertive">
          <div className="px-3 md:px-4 py-2.5 md:py-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <XCircle size={18} className="text-red-500 shrink-0" />
              <span className="text-xs md:text-sm font-medium text-red-400">
                {waveFailureInfo ? (
                  <>
                    <span className="font-mono font-bold">{waveFailureInfo.primaryRoot}</span>
                    {' '}failed{waveFailureInfo.downstreamCount > 0
                      ? ` and blocked ${waveFailureInfo.downstreamCount} downstream ${waveFailureInfo.downstreamCount === 1 ? 'story' : 'stories'}`
                      : ''
                    }.{' '}
                    <button
                      onClick={handleViewErrorDetail}
                      className="underline hover:text-red-300 transition-colors"
                    >
                      View story log →
                    </button>
                  </>
                ) : (
                  <>Run failed — {failedStoryCount} {failedStoryCount === 1 ? 'story' : 'stories'} did not complete</>
                )}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!waveFailureInfo && (
                <button
                  onClick={handleViewErrorDetail}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <ExternalLink size={12} />
                  View error detail
                </button>
              )}
              <button
                onClick={handleRetryFailed}
                disabled={retryLoading}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${retryLoading
                  ? 'bg-red-500/20 text-red-500/40 cursor-not-allowed'
                  : 'bg-red-500 text-white hover:bg-red-600'
                  }`}
              >
                {retryLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <RotateCcw size={12} />
                )}
                Retry failed stories
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Tab content — fills remaining space */}
      {renderTabContent()}
    </div>
  );
}
