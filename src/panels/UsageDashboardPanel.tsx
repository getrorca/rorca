/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Coins, Cpu, ArrowDownUp, RefreshCw, Calendar, Loader2, Wrench, ChevronDown, ChevronRight } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import ErrorBanner from '../components/ErrorBanner';
import { SkeletonLine } from '../components/Skeleton';

/* ─── Types ───────────────────────────────────────────────────────── */

interface SkillEffectivenessItem {
  name: string;
  totalUses: number;
  passCount: number;
  failCount: number;
  passRate: number;
  avgElapsedSeconds: number | null;
  runsUsedIn: number;
}

interface SkillEffectivenessResponse {
  skills: SkillEffectivenessItem[];
  period: { since: string; until: string };
  totalRuns: number;
  totalStories: number;
}

interface UsageGroupRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_cost_usd: number;
  count: number;
}

interface TimeSeriesRow {
  date: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_cost_usd: number;
}

interface UsageTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_cost_usd: number;
  total_records: number;
}

interface UsageResponse {
  grouped: UsageGroupRow[];
  timeSeries: TimeSeriesRow[];
  totals: UsageTotals;
  hasActiveRuns: boolean;
  dateRange: { from: string; to: string };
  groupBy: string;
}

type GroupBy = 'model' | 'spec' | 'story' | 'user';
type DateRange = '7d' | '30d' | '90d' | 'all';

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function dateRangeToISO(range: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (range === 'all') return { from: '2020-01-01T00:00:00Z', to };
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/* ─── Chart colors (tailwind-compatible) ─────────────────────────── */

const CHART_COLORS = ['#6366f1', '#22d3ee', '#f59e0b', '#ef4444', '#10b981', '#8b5cf6', '#f97316', '#ec4899'];

/* ─── Component ───────────────────────────────────────────────────── */

export default function UsageDashboardPanel() {
  const { workspaceId } = useWorkspace();
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('model');
  const [dateRange, setDateRange] = useState<DateRange>('30d');

  const fetchUsage = useCallback(async () => {
    if (!workspaceId) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const { from, to } = dateRangeToISO(dateRange);
      const params = new URLSearchParams({
        group_by: groupBy,
        workspace_id: workspaceId,
        from,
        to,
      });
      const result = await apiFetch<UsageResponse>(`/api/analytics/usage?${params}`);
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load usage data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, groupBy, dateRange]);

  // Initial load + refetch on filter change
  useEffect(() => {
    setLoading(true);
    fetchUsage();
  }, [fetchUsage]);

  // Auto-refresh every 30s when there are active pipeline runs
  useEffect(() => {
    if (!data?.hasActiveRuns) return;
    const interval = setInterval(fetchUsage, 30_000);
    return () => clearInterval(interval);
  }, [data?.hasActiveRuns, fetchUsage]);

  /* ─── Render ──────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col h-full overflow-hidden" role="main" aria-label="Token Usage analytics panel">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Coins size={20} className="text-accent" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Token Usage</h2>
          {data?.hasActiveRuns && (
            <span className="flex items-center gap-1 text-xs text-emerald-400 ml-2" aria-live="polite" aria-label="Live data updating">
              <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
              Live
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Date range selector */}
          <div className="flex items-center gap-1 bg-panel-alt rounded-md p-0.5" role="group" aria-label="Date range filter">
            <Calendar size={14} className="text-muted ml-1.5" aria-hidden="true" />
            {(['7d', '30d', '90d', 'all'] as DateRange[]).map(r => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                aria-pressed={dateRange === r}
                aria-label={`Filter by ${r === 'all' ? 'all time' : `last ${r}`}`}
                className={`px-2.5 py-1 text-xs rounded transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  dateRange === r
                    ? 'bg-accent text-white'
                    : 'text-muted hover:text-[var(--text)]'
                }`}
              >
                {r === 'all' ? 'All' : r}
              </button>
            ))}
          </div>

          {/* Group by selector */}
          <div className="flex items-center gap-1 bg-panel-alt rounded-md p-0.5" role="group" aria-label="Group by filter" aria-live="polite">
            <ArrowDownUp size={14} className="text-muted ml-1.5" aria-hidden="true" />
            {(['model', 'spec', 'story', 'user'] as GroupBy[]).map(g => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                aria-pressed={groupBy === g}
                aria-label={`Group by ${g}`}
                className={`px-2.5 py-1 text-xs rounded capitalize transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  groupBy === g
                    ? 'bg-accent text-white'
                    : 'text-muted hover:text-[var(--text)]'
                }`}
              >
                {g}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6" aria-live="polite" aria-busy={loading}>
        {error && data && <ErrorBanner message={error} onRetry={fetchUsage} onDismiss={() => setError(null)} />}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="animate-spin text-muted" size={28} />
          </div>
        ) : error && !data ? (
          <div role="alert" className="flex flex-col items-center justify-center h-64 text-center">
            <h3 className="text-base font-semibold text-red-400">Usage analytics unavailable</h3>
            <p className="mt-1 text-sm text-muted">{error}</p>
            <button onClick={() => { setLoading(true); void fetchUsage(); }} className="mt-3 text-sm text-accent hover:underline">
              Retry
            </button>
          </div>
        ) : !workspaceId ? (
          <div className="flex items-center justify-center h-64 text-sm text-muted">Select a workspace to view usage analytics.</div>
        ) : !data || data.totals.total_records === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="flex flex-col items-center max-w-[400px] text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
                <Cpu size={28} className="text-accent" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No usage data yet</h3>
              <p className="text-sm text-muted leading-relaxed">Analytics data appears after your first pipeline run. Run a spec to get started.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <SummaryCard
                label="Total Tokens"
                value={formatTokens(Number(data.totals.total_input_tokens) + Number(data.totals.total_output_tokens))}
                sub={`${formatTokens(Number(data.totals.total_input_tokens))} in / ${formatTokens(Number(data.totals.total_output_tokens))} out`}
              />
              <SummaryCard
                label="Total Cost"
                value={formatCost(data.totals.total_cost_usd)}
                sub={`${data.totals.total_records} story runs`}
              />
              <SummaryCard
                label="Avg Cost / Story"
                value={data.totals.total_records > 0
                  ? formatCost(data.totals.total_cost_usd / data.totals.total_records)
                  : '$0'}
                sub="per completion"
              />
              <SummaryCard
                label="Input / Output Ratio"
                value={Number(data.totals.total_output_tokens) > 0
                  ? `${(Number(data.totals.total_input_tokens) / Number(data.totals.total_output_tokens)).toFixed(1)}x`
                  : 'N/A'}
                sub="input tokens per output"
              />
            </div>

            {/* Bar chart: usage by group */}
            <div className="bg-panel-alt rounded-lg p-4">
              <h3 className="text-sm font-medium text-muted mb-3 capitalize">
                Usage by {groupBy}
              </h3>
              <div role="img" aria-label={`Bar chart showing monthly token usage by ${groupBy}`}>
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={data.grouped.slice(0, 15)} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="group_key"
                      tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      tickLine={false}
                      interval={0}
                      angle={-30}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis
                      tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                      tickFormatter={formatTokens}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--panel)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                        fontSize: '12px',
                      }}
                      formatter={((value: string | number | undefined, name: string | number | undefined) => [
                        formatTokens(typeof value === 'number' ? value : Number(value ?? 0)),
                        name === 'total_input_tokens' ? 'Input' : name === 'total_reasoning_tokens' ? 'Reasoning' : 'Output',
                      ]) as any}
                    />
                    <Legend
                      formatter={(value: string) =>
                        value === 'total_input_tokens' ? 'Input Tokens' : value === 'total_reasoning_tokens' ? 'Reasoning Tokens' : 'Output Tokens'
                      }
                    />
                    <Bar dataKey="total_input_tokens" fill="#6366f1" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="total_output_tokens" fill="#22d3ee" radius={[3, 3, 0, 0]} />
                    {data.totals.total_reasoning_tokens > 0 && (
                      <Bar dataKey="total_reasoning_tokens" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                    )}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Screen-reader table alternative */}
              <table className="sr-only" aria-label={`Token usage by ${groupBy} data table`}>
                <thead>
                  <tr>
                    <th scope="col" role="columnheader">{groupBy}</th>
                    <th scope="col" role="columnheader">Input Tokens</th>
                    <th scope="col" role="columnheader">Output Tokens</th>
                    {data.totals.total_reasoning_tokens > 0 && (
                      <th scope="col" role="columnheader">Reasoning Tokens</th>
                    )}
                    <th scope="col" role="columnheader">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.grouped.slice(0, 15).map((row) => (
                    <tr key={row.group_key}>
                      <td>{row.group_key}</td>
                      <td>{formatTokens(row.total_input_tokens)}</td>
                      <td>{formatTokens(row.total_output_tokens)}</td>
                      {data.totals.total_reasoning_tokens > 0 && (
                        <td>{formatTokens(row.total_reasoning_tokens)}</td>
                      )}
                      <td>{formatCost(row.total_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Line chart: usage over time */}
            {data.timeSeries.length > 1 && (
              <div className="bg-panel-alt rounded-lg p-4">
                <h3 className="text-sm font-medium text-muted mb-3">Usage Over Time</h3>
                <div role="img" aria-label="Line chart showing token usage and cost trends over time">
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart data={data.timeSeries} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        tickLine={false}
                      />
                      <YAxis
                        yAxisId="tokens"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        tickFormatter={formatTokens}
                        tickLine={false}
                      />
                      <YAxis
                        yAxisId="cost"
                        orientation="right"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        tickFormatter={(v: number) => `$${v.toFixed(2)}`}
                        tickLine={false}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'var(--panel)',
                          border: '1px solid var(--border)',
                          borderRadius: '6px',
                          fontSize: '12px',
                        }}
                        formatter={((value: string | number | undefined, name: string | number | undefined) => {
                          const v = typeof value === 'number' ? value : Number(value ?? 0);
                          if (name === 'total_cost_usd') return [formatCost(v), 'Cost'];
                          if (name === 'total_reasoning_tokens') return [formatTokens(v), 'Reasoning'];
                          return [formatTokens(v), name === 'total_input_tokens' ? 'Input' : 'Output'];
                        }) as any}
                      />
                      <Legend
                        formatter={(value: string) => {
                          if (value === 'total_cost_usd') return 'Cost (USD)';
                          if (value === 'total_reasoning_tokens') return 'Reasoning Tokens';
                          return value === 'total_input_tokens' ? 'Input Tokens' : 'Output Tokens';
                        }}
                      />
                      <Line yAxisId="tokens" type="monotone" dataKey="total_input_tokens" stroke="#6366f1" strokeWidth={2} dot={false} />
                      <Line yAxisId="tokens" type="monotone" dataKey="total_output_tokens" stroke="#22d3ee" strokeWidth={2} dot={false} />
                      {data.totals.total_reasoning_tokens > 0 && (
                        <Line yAxisId="tokens" type="monotone" dataKey="total_reasoning_tokens" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="4 4" />
                      )}
                      <Line yAxisId="cost" type="monotone" dataKey="total_cost_usd" stroke="#a855f7" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Cost breakdown table */}
            <div className="bg-panel-alt rounded-lg p-4">
              <h3 className="text-sm font-medium text-muted mb-3 capitalize">
                Cost Breakdown by {groupBy}
              </h3>
              <div className="overflow-x-auto">
              <table className="w-full text-sm" role="table" aria-label={`Cost breakdown by ${groupBy}`}>
                <thead>
                  <tr className="text-left text-muted border-b border-border">
                    <th className="pb-2 font-medium capitalize" role="columnheader">{groupBy}</th>
                    <th className="pb-2 font-medium text-right" role="columnheader">Input</th>
                    <th className="pb-2 font-medium text-right" role="columnheader">Output</th>
                    {data.totals.total_reasoning_tokens > 0 && (
                      <th className="pb-2 font-medium text-right" role="columnheader">Reasoning</th>
                    )}
                    <th className="pb-2 font-medium text-right" role="columnheader">Cost</th>
                    <th className="pb-2 font-medium text-right" role="columnheader">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.grouped.map((row, i) => (
                    <tr key={row.group_key} className="border-b border-border/50 last:border-0">
                      <td className="py-2 flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                          aria-hidden="true"
                        />
                        <span className="truncate max-w-[200px]" title={row.group_key}>
                          {row.group_key}
                        </span>
                      </td>
                      <td className="py-2 text-right text-muted">{formatTokens(row.total_input_tokens)}</td>
                      <td className="py-2 text-right text-muted">{formatTokens(row.total_output_tokens)}</td>
                      {data.totals.total_reasoning_tokens > 0 && (
                        <td className="py-2 text-right text-amber-400">{formatTokens(row.total_reasoning_tokens)}</td>
                      )}
                      <td className="py-2 text-right font-medium">{formatCost(row.total_cost_usd)}</td>
                      <td className="py-2 text-right text-muted">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>

            {/* Skill Effectiveness */}
            <SkillEffectivenessCard />
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────────── */

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-panel-alt rounded-lg p-4 flex flex-col gap-1" aria-label={`${label}: ${value}`}>
      <span className="text-xs text-muted">{label}</span>
      <span className="text-2xl font-bold" aria-hidden="true">{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}

function formatElapsed(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function passRateColor(rate: number): string {
  if (rate >= 0.8) return 'text-emerald-500';
  if (rate >= 0.5) return 'text-amber-500';
  return 'text-red-500';
}

function SkillEffectivenessCard() {
  const { workspaceId } = useWorkspace();
  const [data, setData] = useState<SkillEffectivenessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const fetchData = useCallback(async () => {
    if (!workspaceId) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const result = await apiFetch<SkillEffectivenessResponse>(
        `/api/analytics/skills/effectiveness?workspaceId=${workspaceId}`
      );
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load skill effectiveness data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  const skills = data?.skills ?? [];
  const visibleSkills = showAll ? skills : skills.slice(0, 10);

  return (
    <div className="bg-panel-alt rounded-lg p-4">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-2 w-full text-left group"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={14} className="text-muted shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight size={14} className="text-muted shrink-0" aria-hidden="true" />
        )}
        <Wrench size={16} className="text-muted shrink-0" aria-hidden="true" />
        <h3 className="text-sm font-medium text-muted">
          Skill Effectiveness
          {!expanded && skills.length > 0 && (
            <span className="ml-1">({skills.length} skill{skills.length !== 1 ? 's' : ''})</span>
          )}
        </h3>
        <span className="text-xs text-muted">(Last 30 Days · pass rate = passes ÷ uses)</span>
      </button>

      {/* Collapsible body */}
      {expanded && (
        <div className="mt-3">
          {loading ? (
            <div className="space-y-2.5">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-4">
                  <SkeletonLine className="w-28" />
                  <SkeletonLine className="w-10 ml-auto" />
                  <SkeletonLine className="w-12" />
                  <SkeletonLine className="w-12" />
                  <SkeletonLine className="w-8" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-red-400">{error}</span>
              <button
                onClick={() => { setLoading(true); fetchData(); }}
                className="text-accent text-xs hover:underline"
              >
                Retry
              </button>
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center py-6 text-center">
              <p className="text-sm text-muted">No skill usage data yet</p>
              <p className="text-xs text-muted mt-1">
                Skills will appear here after running specs with matched skills.
              </p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm" role="table" aria-label="Skill effectiveness data">
                  <thead>
                    <tr className="text-left text-muted border-b border-border">
                      <th className="pb-2 font-medium">Skill Name</th>
                      <th className="pb-2 font-medium text-right">Uses</th>
                      <th className="pb-2 font-medium text-right">Pass Rate</th>
                      <th className="pb-2 font-medium text-right">Avg Time</th>
                      <th className="pb-2 font-medium text-right">Runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSkills.map(skill => (
                      <tr key={skill.name} className="border-b border-border/50 last:border-0">
                        <td className="py-2 font-mono text-sm truncate max-w-[200px]" title={skill.name}>
                          {skill.name}
                        </td>
                        <td className="py-2 text-right text-muted">{skill.totalUses}</td>
                        <td className={`py-2 text-right font-medium ${passRateColor(skill.passRate)}`}>
                          {Math.round(skill.passRate * 100)}%
                        </td>
                        <td className="py-2 text-right text-muted">{formatElapsed(skill.avgElapsedSeconds)}</td>
                        <td className="py-2 text-right text-muted">{skill.runsUsedIn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {skills.length > 10 && (
                <button
                  onClick={() => setShowAll(s => !s)}
                  className="mt-2 text-xs text-accent hover:underline"
                >
                  {showAll ? 'Show less' : `Show all (${skills.length})`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
