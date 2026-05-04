/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useMemo } from 'react';
import { ArrowLeftRight, ArrowUp, ArrowDown, Plus, Minus, Equal, ChevronLeft, GitCompare, BarChart2 } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PipelineRun {
  id: number;
  spec_path: string;
  workspace_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
}

type StoryChange = 'unchanged' | 'improved' | 'regressed' | 'new_in_run2' | 'removed_in_run2';

interface StoryComparison {
  storyId: string;
  run1Status: string | null;
  run2Status: string | null;
  run1Elapsed: number | null;
  run2Elapsed: number | null;
  run1Retries: number | null;
  run2Retries: number | null;
  change: StoryChange;
}

interface CompareSummary {
  run1PassRate: number;
  run2PassRate: number;
  passRateDelta: number;
  run1TotalElapsed: number;
  run2TotalElapsed: number;
  elapsedDelta: number;
  run1StoryCount: number;
  run2StoryCount: number;
  improved: number;
  regressed: number;
  newStories: number;
  removedStories: number;
}

interface CompareResponse {
  run1: PipelineRun;
  run2: PipelineRun;
  stories: StoryComparison[];
  summary: CompareSummary;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function specName(specPath: string): string {
  const parts = specPath.split('/');
  const file = parts[parts.length - 1] || specPath;
  return file.replace(/\.json$/, '').replace(/-/g, ' ');
}

function formatElapsed(seconds: number | null): string {
  if (seconds === null || seconds === 0) return '-';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${seconds % 60}s`;
}

function formatDelta(delta: number): string {
  if (delta === 0) return '0s';
  const sign = delta > 0 ? '+' : '';
  if (Math.abs(delta) < 60) return `${sign}${delta}s`;
  const m = Math.floor(Math.abs(delta) / 60);
  const s = Math.abs(delta) % 60;
  return `${sign}${delta < 0 ? '-' : ''}${m}m ${s}s`;
}

const STATUS_BADGE: Record<string, string> = {
  pass: 'bg-emerald-500/20 text-emerald-400',
  fail: 'bg-red-500/20 text-red-400',
  skip: 'bg-zinc-500/20 text-zinc-400',
  retry: 'bg-yellow-500/20 text-yellow-400',
  timeout: 'bg-orange-500/20 text-orange-400',
};

const CHANGE_CONFIG: Record<StoryChange, { label: string; icon: typeof Equal; className: string }> = {
  regressed: { label: 'Regressed', icon: ArrowDown, className: 'text-red-400' },
  improved: { label: 'Improved', icon: ArrowUp, className: 'text-emerald-400' },
  new_in_run2: { label: 'New', icon: Plus, className: 'text-blue-400' },
  removed_in_run2: { label: 'Removed', icon: Minus, className: 'text-orange-400' },
  unchanged: { label: 'Unchanged', icon: Equal, className: 'text-zinc-500' },
};

// ─── Component ───────────────────────────────────────────────────────────────

interface CompareRunsPanelProps {
  onBack: () => void;
}

export default function CompareRunsPanel({ onBack }: CompareRunsPanelProps) {
  const { workspaceId } = useWorkspace();
  const [runs, setRuns] = useState<PipelineRun[]>([]);
  const [run1Id, setRun1Id] = useState<number | null>(null);
  const [run2Id, setRun2Id] = useState<number | null>(null);
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterChange, setFilterChange] = useState<StoryChange | 'all'>('all');

  // Fetch available runs
  useEffect(() => {
    if (!workspaceId) return;
    apiFetch<{ items: PipelineRun[]; total: number; hasMore: boolean; cursor?: string }>(`/api/pipeline/runs?workspaceId=${workspaceId}`)
      .then((data) => {
        // Only show completed runs (can't meaningfully compare in-progress runs)
        const completed = data.items.filter(r => ['done', 'failed', 'partial_failure'].includes(r.status));
        setRuns(completed);
      })
      .catch(console.error);
  }, [workspaceId]);

  // Fetch comparison when both runs selected
  useEffect(() => {
    if (!run1Id || !run2Id || run1Id === run2Id) {
      setComparison(null);
      return;
    }
    setLoading(true);
    setError(null);
    apiFetch<CompareResponse>(`/api/pipeline/runs/compare?run1=${run1Id}&run2=${run2Id}`)
      .then(setComparison)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [run1Id, run2Id]);

  const filteredStories = useMemo(() => {
    if (!comparison) return [];
    if (filterChange === 'all') return comparison.stories;
    return comparison.stories.filter(s => s.change === filterChange);
  }, [comparison, filterChange]);

  // ─── Empty State ─────────────────────────────────────────────────────────

  if (!workspaceId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--text-muted)]">
        Select a workspace to compare runs.
      </div>
    );
  }

  return (
    <div role="main" aria-label="Compare runs panel - compare pipeline run outcomes" className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
        <button
          onClick={onBack}
          aria-label="Back to Pipeline Monitor"
          className="p-1 rounded hover:bg-[var(--surface)] transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50"
          title="Back to Pipeline Monitor"
        >
          <ChevronLeft className="w-4 h-4 text-[var(--text-muted)]" />
        </button>
        <ArrowLeftRight className="w-5 h-5 text-[var(--accent)]" />
        <h2 className="text-base font-medium">Compare Pipeline Runs</h2>
      </div>

      {/* Run selectors */}
      <div className="p-4 border-b border-[var(--border)] flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
        <div className="flex-1">
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Baseline (Run 1)</label>
          <select
            value={run1Id ?? ''}
            onChange={(e) => setRun1Id(e.target.value ? Number(e.target.value) : null)}
            aria-label="Baseline run (Run 1)"
            className="w-full px-3 py-1.5 text-sm bg-[var(--surface)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <option value="">Select a run...</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id} disabled={r.id === run2Id}>
                #{r.id} - {specName(r.spec_path)} ({r.status})
              </option>
            ))}
          </select>
        </div>

        <ArrowLeftRight className="w-4 h-4 text-[var(--text-muted)] hidden sm:block sm:mt-5 flex-shrink-0" />

        <div className="flex-1">
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Comparison (Run 2)</label>
          <select
            value={run2Id ?? ''}
            onChange={(e) => setRun2Id(e.target.value ? Number(e.target.value) : null)}
            aria-label="Comparison run (Run 2)"
            className="w-full px-3 py-1.5 text-sm bg-[var(--surface)] border border-[var(--border)] rounded text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <option value="">Select a run...</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id} disabled={r.id === run1Id}>
                #{r.id} - {specName(r.spec_path)} ({r.status})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div aria-live="polite" className="flex items-center justify-center py-12 text-[var(--text-muted)] text-sm">
          <span className="sr-only">Loading...</span>
          Loading comparison...
        </div>
      )}
      {error && (
        <div className="p-4 text-sm text-red-400">{error}</div>
      )}

      {/* Comparison results */}
      {comparison && !loading && (
        <div aria-live="polite" className="flex-1 overflow-y-auto">
          {/* Summary header */}
          <div className="p-4 border-b border-[var(--border)] grid grid-cols-2 md:grid-cols-4 gap-4">
            {/* Pass rate */}
            <div className="bg-[var(--surface)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">Pass Rate</div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-semibold">{comparison.summary.run1PassRate}%</span>
                <span className="text-[var(--text-muted)]">&rarr;</span>
                <span className="text-lg font-semibold">{comparison.summary.run2PassRate}%</span>
              </div>
              <div className={`text-xs mt-1 ${
                comparison.summary.passRateDelta > 0 ? 'text-emerald-400' :
                comparison.summary.passRateDelta < 0 ? 'text-red-400' : 'text-zinc-500'
              }`}>
                {comparison.summary.passRateDelta > 0 ? '+' : ''}{Math.round(comparison.summary.passRateDelta * 100)}pp
              </div>
            </div>

            {/* Execution time */}
            <div className="bg-[var(--surface)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">Total Time</div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-semibold">{formatElapsed(comparison.summary.run1TotalElapsed)}</span>
                <span className="text-[var(--text-muted)]">&rarr;</span>
                <span className="text-lg font-semibold">{formatElapsed(comparison.summary.run2TotalElapsed)}</span>
              </div>
              <div className={`text-xs mt-1 ${
                comparison.summary.elapsedDelta < 0 ? 'text-emerald-400' :
                comparison.summary.elapsedDelta > 0 ? 'text-red-400' : 'text-zinc-500'
              }`}>
                {formatDelta(comparison.summary.elapsedDelta)}
              </div>
            </div>

            {/* Changes */}
            <div className="bg-[var(--surface)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">Changes</div>
              <div className="space-y-1">
                {comparison.summary.improved > 0 && (
                  <div className="text-xs text-emerald-400">{comparison.summary.improved} improved</div>
                )}
                {comparison.summary.regressed > 0 && (
                  <div className="text-xs text-red-400">{comparison.summary.regressed} regressed</div>
                )}
                {comparison.summary.newStories > 0 && (
                  <div className="text-xs text-blue-400">{comparison.summary.newStories} new</div>
                )}
                {comparison.summary.removedStories > 0 && (
                  <div className="text-xs text-orange-400">{comparison.summary.removedStories} removed</div>
                )}
                {comparison.summary.improved === 0 && comparison.summary.regressed === 0 &&
                 comparison.summary.newStories === 0 && comparison.summary.removedStories === 0 && (
                  <div className="text-xs text-zinc-500">No changes</div>
                )}
              </div>
            </div>

            {/* Story counts */}
            <div className="bg-[var(--surface)] rounded-lg p-3">
              <div className="text-xs text-[var(--text-muted)] mb-1">Stories</div>
              <div className="flex items-baseline gap-2">
                <span className="text-lg font-semibold">{comparison.summary.run1StoryCount}</span>
                <span className="text-[var(--text-muted)]">&rarr;</span>
                <span className="text-lg font-semibold">{comparison.summary.run2StoryCount}</span>
              </div>
            </div>
          </div>

          {/* Filter bar */}
          <div className="px-4 py-2 border-b border-[var(--border)] flex items-center gap-2 flex-wrap">
            <span className="text-xs text-[var(--text-muted)]">Filter:</span>
            {(['all', 'regressed', 'improved', 'new_in_run2', 'removed_in_run2', 'unchanged'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilterChange(f)}
                aria-pressed={filterChange === f}
                className={`px-2 py-0.5 text-xs rounded transition-colors focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  filterChange === f
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--text)]'
                }`}
              >
                {f === 'all' ? 'All' :
                 f === 'new_in_run2' ? 'New' :
                 f === 'removed_in_run2' ? 'Removed' :
                 f.charAt(0).toUpperCase() + f.slice(1)}
                {f !== 'all' && (
                  <span className="ml-1 opacity-70">
                    ({comparison.stories.filter(s => s.change === f).length})
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Story comparison table */}
          <div className="overflow-x-auto">
            <div role="table" aria-label="Story comparison results" className="divide-y divide-[var(--border)] min-w-[480px]">
              {/* Table header */}
              <div role="row" className="grid grid-cols-[1fr_90px_90px_70px_70px_90px] md:grid-cols-[1fr_100px_100px_80px_80px_100px] px-4 py-2 text-xs font-medium text-[var(--text-muted)] bg-[var(--surface)]">
                <span role="columnheader">Story</span>
                <span role="columnheader" className="text-center">Run 1</span>
                <span role="columnheader" className="text-center">Run 2</span>
                <span role="columnheader" className="text-right hidden md:block">R1 Time</span>
                <span role="columnheader" className="text-right hidden md:block">R2 Time</span>
                <span role="columnheader" className="text-center">Change</span>
              </div>

              {filteredStories.length === 0 ? (
                <div aria-live="polite" className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
                  No stories match the selected filter.
                </div>
              ) : (
                filteredStories.map((story) => {
                  const changeConfig = CHANGE_CONFIG[story.change];
                  const ChangeIcon = changeConfig.icon;
                  return (
                    <div
                      key={story.storyId}
                      role="row"
                      className="grid grid-cols-[1fr_90px_90px_70px_70px_90px] md:grid-cols-[1fr_100px_100px_80px_80px_100px] px-4 py-2 items-center hover:bg-[var(--surface)] transition-colors"
                    >
                      <span role="cell" className="text-sm font-mono truncate">{story.storyId}</span>
                      <span role="cell" className="text-center">
                        {story.run1Status ? (
                          <span className={`inline-block px-2 py-0.5 text-xs rounded ${STATUS_BADGE[story.run1Status] || 'bg-zinc-500/20 text-zinc-400'}`}>
                            {story.run1Status}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-600">-</span>
                        )}
                      </span>
                      <span role="cell" className="text-center">
                        {story.run2Status ? (
                          <span className={`inline-block px-2 py-0.5 text-xs rounded ${STATUS_BADGE[story.run2Status] || 'bg-zinc-500/20 text-zinc-400'}`}>
                            {story.run2Status}
                          </span>
                        ) : (
                          <span className="text-xs text-zinc-600">-</span>
                        )}
                      </span>
                      <span role="cell" className="text-xs font-mono text-[var(--text-muted)] text-right hidden md:block">
                        {formatElapsed(story.run1Elapsed)}
                      </span>
                      <span role="cell" className="text-xs font-mono text-[var(--text-muted)] text-right hidden md:block">
                        {formatElapsed(story.run2Elapsed)}
                      </span>
                      <span role="cell" className={`flex items-center justify-center gap-1 text-xs ${changeConfig.className}`}>
                        <ChangeIcon className="w-3 h-3" aria-hidden="true" />
                        <span className="hidden sm:inline">{changeConfig.label}</span>
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* Initial state — no runs selected */}
      {!comparison && !loading && !error && (
        <div className="flex items-center justify-center flex-1">
          <div className="flex flex-col items-center text-center max-w-md px-6">
            {runs.length < 2 ? (
              <>
                <BarChart2 size={48} className="text-[var(--text-muted)] opacity-40 mb-4" />
                <h3 className="text-lg font-semibold text-[var(--text)] mb-2">Not enough runs to compare</h3>
                <p className="text-sm text-[var(--text-muted)]">
                  You need at least 2 completed pipeline runs to use run comparison. Trigger a spec from the Pipeline panel to get started.
                </p>
              </>
            ) : (
              <>
                <GitCompare size={48} className="text-[var(--text-muted)] opacity-40 mb-4" />
                <h3 className="text-lg font-semibold text-[var(--text)] mb-2">Select two runs to compare</h3>
                <p className="text-sm text-[var(--text-muted)]">
                  Choose a baseline run and a comparison run above to see a story-by-story diff of pass rates and outcomes.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
