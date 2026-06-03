/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Download, Info } from 'lucide-react';
import { apiFetch, BASE_URL } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PerStory {
  storyId: string;
  model: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  actualCost: number;
  opusBaseline: number;
}

interface RunSummaryRow {
  model: string;
  tier: string;
  stories: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface ModelDistEntry {
  tier: string;
  count: number;
  percentage: number;
}

interface Totals {
  stories: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
}

interface FinOpsData {
  runId: number;
  agentType: string;
  agentModel?: string;
  usageAvailable?: boolean;
  isSubscription: boolean;
  runSummary: RunSummaryRow[];
  totals: Totals;
  modelDistribution: ModelDistEntry[];
  perStory: PerStory[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

const TIER_COLORS: Record<string, string> = {
  haiku: 'bg-emerald-500',
  sonnet: 'bg-blue-500',
  opus: 'bg-purple-500',
};

const _TIER_TEXT: Record<string, string> = {
  haiku: 'text-emerald-400',
  sonnet: 'text-blue-400',
  opus: 'text-purple-400',
};

const TIER_BG: Record<string, string> = {
  haiku: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  sonnet: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  opus: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
};

// ─── Component ──────────────────────────────────────────────────────────────

interface FinOpsTabProps {
  runId: number;
}

export default function FinOpsTab({ runId }: FinOpsTabProps) {
  const [data, setData] = useState<FinOpsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStories, setExpandedStories] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<FinOpsData>(`/api/analytics/finops/run/${runId}`);
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load FinOps data');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Sort per-story by cost descending
  const sortedStories = useMemo(() => {
    if (!data) return [];
    return [...data.perStory].sort((a, b) => b.actualCost - a.actualCost);
  }, [data]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
        Loading FinOps data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <span className="text-sm text-red-400">{error}</span>
        <button onClick={fetchData} className="text-xs text-[var(--accent)] hover:underline">Retry</button>
      </div>
    );
  }

  if (!data || data.totals.stories === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
        No token usage data available for this run.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 space-y-4">

        {/* Usage availability notice */}
        {data.usageAvailable === false && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-400">
            <Info size={14} className="shrink-0" />
            <span>
              Waiting for token usage from {data.agentType}{data.agentModel ? ` (${data.agentModel})` : ''}. Provider/model rows are shown now and will update when usage events arrive.
            </span>
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-4 gap-3">
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Stories</div>
            <div className="text-lg font-mono font-medium">{data.totals.stories}</div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Input Tokens</div>
            <div className="text-lg font-mono font-medium">{formatTokens(data.totals.inputTokens)}</div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Output Tokens</div>
            <div className="text-lg font-mono font-medium">{formatTokens(data.totals.outputTokens)}</div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
              Total Cost
            </div>
            <div className="text-lg font-mono font-medium">
              {data.totals.cost != null ? formatCost(data.totals.cost) : '—'}
            </div>
          </div>
        </div>

        {/* Model distribution + Run summary side by side */}
        <div className="grid grid-cols-2 gap-4">
          {/* Model distribution pie (simple horizontal bar) */}
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              Model Distribution
            </div>
            <div className="p-3 space-y-3">
              {/* Visual bar */}
              <div className="h-6 rounded-full overflow-hidden flex bg-[var(--border)]">
                {data.modelDistribution.map((d) => (
                  <div
                    key={d.tier}
                    className={`h-full ${TIER_COLORS[d.tier] || 'bg-zinc-500'} transition-all`}
                    style={{ width: `${d.percentage}%` }}
                    title={`${d.tier}: ${d.count} stories (${d.percentage}%)`}
                  />
                ))}
              </div>
              {/* Legend */}
              <div className="flex items-center gap-4 text-xs">
                {data.modelDistribution.map((d) => (
                  <div key={d.tier} className="flex items-center gap-1.5">
                    <span className={`w-2.5 h-2.5 rounded-sm ${TIER_COLORS[d.tier] || 'bg-zinc-500'}`} />
                    <span className="capitalize">{d.tier}</span>
                    <span className="text-[var(--text-muted)]">{d.count} ({d.percentage}%)</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Run summary table */}
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              Run Summary
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Model</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Stories</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens In</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens Out</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.runSummary.map((row) => (
                  <tr key={row.model} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-1.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${TIER_BG[row.tier] || 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}`}>
                        {row.tier}
                      </span>
                      <span className="ml-2 font-mono text-[var(--text-muted)]">{row.model}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{row.stories}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(row.inputTokens)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(row.outputTokens)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatCost(row.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Per-story cost breakdown (expandable) */}
        <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
          <button
            onClick={() => setExpandedStories(!expandedStories)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide hover:bg-[var(--surface-hover)] transition-colors"
          >
            <span className="flex items-center gap-1.5">
              {expandedStories ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Per-Story Cost Breakdown
              <span className="normal-case font-normal">({data.perStory.length} stories)</span>
            </span>
            <a
              href={`${BASE_URL}/api/analytics/finops/export?run_id=${runId}&format=csv`}
              onClick={(e) => e.stopPropagation()}
              className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg)] transition-colors"
              title="Export as CSV"
            >
              <Download size={10} />
              CSV
            </a>
          </button>

          {expandedStories && (
            <div className="border-t border-[var(--border)]">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Story</th>
                    <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Tier</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens In</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens Out</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Cost</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Opus Baseline</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStories.map((s) => {
                    const saved = s.opusBaseline - s.actualCost;
                    return (
                      <tr key={s.storyId} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-hover)] transition-colors">
                        <td className="px-3 py-1.5 font-mono">{s.storyId}</td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${TIER_BG[s.tier] || 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}`}>
                            {s.tier}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(s.inputTokens)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(s.outputTokens)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">{formatCost(s.actualCost)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)] line-through opacity-60">{formatCost(s.opusBaseline)}</td>
                        <td className={`px-3 py-1.5 text-right font-mono ${saved > 0 ? 'text-emerald-400' : saved < 0 ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                          {saved > 0 ? '+' : ''}{formatCost(saved)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
