/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Download, TrendingDown, Info, Calendar, DollarSign } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch, BASE_URL } from '../lib/apiFetch';
import { ProBadge } from '../components/UpgradePrompt';
import { useAuth } from '../contexts/AuthContext';
import { formatPiProviderCostLabel } from './finops/piProviderCost';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, BarChart, Bar, Legend,
} from 'recharts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface DailyTrend {
  date: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  storyCount: number;
}

interface ByWorkspace {
  workspaceId: string;
  label: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  runCount: number;
}

interface BySpec {
  specSlug: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  runCount: number;
}

interface ByMonth {
  month: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  runCount: number;
  storyCount: number;
}

interface ModelDistEntry {
  model: string;
  tier: string;
  storyCount: number;
  totalCost: number;
  percentage: number;
}

interface Savings {
  opusBaseline: number;
  actual: number;
  saved: number;
  percentage: number;
}

interface HistoricalData {
  dailyTrend: DailyTrend[];
  byWorkspace: ByWorkspace[];
  bySpec: BySpec[];
  byMonth: ByMonth[];
  modelDistribution: ModelDistEntry[];
  projectedMonthlyCost: number;
  savings: Savings | null;
  allSubscription: boolean;
  dateRange: { from: string; to: string };
}

interface PiProviderUsage {
  provider: string;
  totalRuns: number;
  totalStories: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgCostPerStory: number;
  lastUsed: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatCost(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const PIE_COLORS: Record<string, string> = {
  haiku: '#10b981',
  sonnet: '#3b82f6',
  opus: '#a855f7',
};

const TIER_BG: Record<string, string> = {
  haiku: 'bg-emerald-500/15 text-emerald-400',
  sonnet: 'bg-blue-500/15 text-blue-400',
  opus: 'bg-purple-500/15 text-purple-400',
};

type DateRange = '30d' | '90d' | '180d' | '365d';

// ─── Component ──────────────────────────────────────────────────────────────

export default function FinOpsDashboardPanel() {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const userPlan = user?.app_metadata?.plan as string | undefined;
  const isFreePlan = !userPlan || userPlan === 'free';
  const [data, setData] = useState<HistoricalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>('90d');
  const [piProviders, setPiProviders] = useState<PiProviderUsage[]>([]);
  const [piProvidersLoading, setPiProvidersLoading] = useState(true);
  const [piProvidersError, setPiProvidersError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const days = parseInt(dateRange);
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({ from, to: now.toISOString() });
      if (workspaceId) params.set('workspace_id', workspaceId);

      const result = await apiFetch<HistoricalData>(`/api/analytics/finops/historical?${params}`);
      setData(result);
    } catch (err: any) {
      setError(err.message || 'Failed to load FinOps data');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const fetchPiProviders = useCallback(async () => {
    setPiProvidersLoading(true);
    setPiProvidersError(null);
    try {
      const params = new URLSearchParams();
      if (workspaceId) params.set('workspace_id', workspaceId);
      const result = await apiFetch<PiProviderUsage[]>(
        `/api/analytics/pi-providers${params.toString() ? `?${params.toString()}` : ''}`,
      );
      setPiProviders(result);
    } catch (err: any) {
      setPiProviders([]);
      setPiProvidersError(err.message || 'Failed to load Pi providers');
    } finally {
      setPiProvidersLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { fetchPiProviders(); }, [fetchPiProviders]);

  // Aggregate totals
  const totals = useMemo(() => {
    if (!data) return { cost: 0, inputTokens: 0, outputTokens: 0, runs: 0, stories: 0 };
    return {
      cost: data.byMonth.reduce((s, m) => s + m.totalCost, 0),
      inputTokens: data.byMonth.reduce((s, m) => s + m.inputTokens, 0),
      outputTokens: data.byMonth.reduce((s, m) => s + m.outputTokens, 0),
      runs: data.byMonth.reduce((s, m) => s + m.runCount, 0),
      stories: data.byMonth.reduce((s, m) => s + m.storyCount, 0),
    };
  }, [data]);

  // Pie chart data
  const pieData = useMemo(() => {
    if (!data) return [];
    // Group by tier
    const tierMap = new Map<string, { tier: string; stories: number; cost: number }>();
    for (const m of data.modelDistribution) {
      const existing = tierMap.get(m.tier) || { tier: m.tier, stories: 0, cost: 0 };
      existing.stories += m.storyCount;
      existing.cost += m.totalCost;
      tierMap.set(m.tier, existing);
    }
    return Array.from(tierMap.values());
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

  if (!data) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="flex flex-col items-center max-w-[400px] text-center">
          <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
            <DollarSign size={28} className="text-accent" />
          </div>
          <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No FinOps data yet</h3>
          <p className="text-sm text-muted leading-relaxed">Cost analytics appear after your first pipeline run. Run a spec to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 space-y-6 max-w-6xl mx-auto">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <DollarSign size={20} className="text-[var(--accent)]" />
              FinOps Dashboard
              {isFreePlan && <ProBadge />}
            </h1>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Cost observability across all runs and workspaces
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Date range selector */}
            <div className="flex items-center gap-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg p-0.5">
              {(['30d', '90d', '180d', '365d'] as DateRange[]).map(range => (
                <button
                  key={range}
                  onClick={() => setDateRange(range)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    dateRange === range
                      ? 'bg-[var(--accent)] text-white'
                      : 'text-[var(--text-muted)] hover:text-[var(--text)]'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
            {/* Export */}
            <a
              href={`${BASE_URL}/api/analytics/finops/export?${workspaceId ? `workspace_id=${workspaceId}&` : ''}from=${data.dateRange.from}&to=${data.dateRange.to}`}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface)] transition-colors"
              title="Export all cost data as CSV"
            >
              <Download size={12} />
              Export CSV
            </a>
          </div>
        </div>

        {/* Subscription notice */}
        {data.allSubscription && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-500/10 border border-orange-500/20 text-xs text-orange-400">
            <Info size={14} className="shrink-0" />
            <span>All runs used subscription-based agents (Claude/Codex) — token counts shown, no dollar costs.</span>
          </div>
        )}

        {/* Savings banner */}
        {data.savings && (
          <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingDown size={16} className="text-emerald-400" />
              <span className="text-sm font-semibold text-emerald-400">Cumulative Savings</span>
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-[var(--text-muted)]">
                All-Opus baseline: <span className="font-mono text-[var(--text)] line-through opacity-60">{formatCost(data.savings.opusBaseline)}</span>
              </span>
              <span className="text-[var(--text-muted)]">&rarr;</span>
              <span className="text-[var(--text-muted)]">
                Actual: <span className="font-mono text-[var(--text)]">{formatCost(data.savings.actual)}</span>
              </span>
              <span className="text-[var(--text-muted)]">&rarr;</span>
              <span className="font-semibold text-emerald-400">
                Saved: {formatCost(data.savings.saved)} ({data.savings.percentage}%)
              </span>
            </div>
          </div>
        )}

        {/* Summary cards */}
        <div className="grid grid-cols-5 gap-3">
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Total Cost</div>
            <div className="text-lg font-mono font-medium">
              {data.allSubscription ? '—' : formatCost(totals.cost)}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Projected Monthly</div>
            <div className="text-lg font-mono font-medium">
              {data.allSubscription ? '—' : formatCost(data.projectedMonthlyCost)}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Total Tokens</div>
            <div className="text-lg font-mono font-medium">{formatTokens(totals.inputTokens + totals.outputTokens)}</div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Runs</div>
            <div className="text-lg font-mono font-medium">{totals.runs}</div>
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Stories</div>
            <div className="text-lg font-mono font-medium">{totals.stories}</div>
          </div>
        </div>

        {/* Cost trend chart + Model distribution pie */}
        <div className="grid grid-cols-3 gap-4">
          {/* Line chart: daily spend */}
          <div className="col-span-2 rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
              <Calendar size={14} className="text-[var(--text-muted)]" />
              <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                {data.allSubscription ? 'Daily Token Usage' : 'Daily Spend'}
              </span>
            </div>
            <div className="p-4" style={{ height: 280 }}>
              {data.dailyTrend.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
                  No data in selected range
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={data.dailyTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickFormatter={(d: string) => d.slice(5)}
                    />
                    <YAxis
                      tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                      tickFormatter={(v: number) => data.allSubscription ? formatTokens(v) : `$${v.toFixed(2)}`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={((value: string | number | undefined, name: string | number | undefined) => {
                        const v = typeof value === 'number' ? value : Number(value ?? 0);
                        if (name === 'cost') return [formatCost(v), 'Cost'];
                        return [formatTokens(v), name === 'inputTokens' ? 'Input' : 'Output'];
                      }) as any}
                    />
                    {data.allSubscription ? (
                      <>
                        <Line type="monotone" dataKey="inputTokens" stroke="#3b82f6" strokeWidth={2} dot={false} name="inputTokens" />
                        <Line type="monotone" dataKey="outputTokens" stroke="#06b6d4" strokeWidth={2} dot={false} name="outputTokens" />
                      </>
                    ) : (
                      <Line type="monotone" dataKey="cost" stroke="var(--accent)" strokeWidth={2} dot={false} name="cost" />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Pie chart: model distribution */}
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--border)]">
              <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                Model Distribution
              </span>
            </div>
            <div className="p-4" style={{ height: 280 }}>
              {pieData.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-[var(--text-muted)]">
                  No data
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      dataKey="stories"
                      nameKey="tier"
                      cx="50%"
                      cy="45%"
                      outerRadius={80}
                      label={({ name, value }: { name?: string; value?: number }) => `${name ?? ''} (${value ?? 0})`}
                      labelLine={false}
                    >
                      {pieData.map((entry) => (
                        <Cell
                          key={entry.tier}
                          fill={PIE_COLORS[entry.tier] || '#71717a'}
                        />
                      ))}
                    </Pie>
                    <Legend
                      verticalAlign="bottom"
                      iconType="circle"
                      formatter={(value: string) => <span className="text-xs capitalize">{value}</span>}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={((value: string | number | undefined, name: string | number | undefined) => [
                        `${typeof value === 'number' ? value : Number(value ?? 0)} stories`,
                        String(name ?? '').charAt(0).toUpperCase() + String(name ?? '').slice(1),
                      ]) as any}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* Monthly cost bar chart */}
        {data.byMonth.length > 0 && (
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[var(--border)]">
              <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                {data.allSubscription ? 'Monthly Token Usage' : 'Monthly Cost'}
              </span>
            </div>
            <div className="p-4" style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.byMonth}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="month"
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    tickFormatter={(v: number) => data.allSubscription ? formatTokens(v) : `$${v.toFixed(0)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={((value: string | number | undefined, name: string | number | undefined) => {
                      const v = typeof value === 'number' ? value : Number(value ?? 0);
                      if (name === 'totalCost') return [formatCost(v), 'Cost'];
                      if (name === 'inputTokens') return [formatTokens(v), 'Input Tokens'];
                      if (name === 'reasoningTokens') return [formatTokens(v), 'Thinking Tokens'];
                      return [formatTokens(v), 'Output Tokens'];
                    }) as any}
                  />
                  {data.allSubscription ? (
                    <>
                      <Bar dataKey="inputTokens" fill="#3b82f6" radius={[4, 4, 0, 0]} name="inputTokens" />
                      <Bar dataKey="outputTokens" fill="#06b6d4" radius={[4, 4, 0, 0]} name="outputTokens" />
                      {data.byMonth.some(m => (m.reasoningTokens ?? 0) > 0) && (
                        <Bar dataKey="reasoningTokens" fill="#f59e0b" radius={[4, 4, 0, 0]} name="reasoningTokens" />
                      )}
                    </>
                  ) : (
                    <Bar dataKey="totalCost" fill="var(--accent)" radius={[4, 4, 0, 0]} name="totalCost" />
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* By workspace + By spec tables side by side */}
        <div className="grid grid-cols-2 gap-4">
          {/* By workspace */}
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              By Workspace
            </div>
            {data.byWorkspace.length === 0 ? (
              <div className="p-4 text-xs text-[var(--text-muted)] text-center">No data</div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)]">
                    <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Workspace</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Runs</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens</th>
                    {!data.allSubscription && (
                      <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Cost</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {data.byWorkspace.map(w => (
                    <tr key={w.workspaceId} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-1.5 truncate max-w-[200px]" title={w.label}>{w.label}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{w.runCount}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(w.inputTokens + w.outputTokens)}</td>
                      {!data.allSubscription && (
                        <td className="px-3 py-1.5 text-right font-mono">{formatCost(w.totalCost)}</td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* By spec */}
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              By Spec (Top 20)
            </div>
            {data.bySpec.length === 0 ? (
              <div className="p-4 text-xs text-[var(--text-muted)] text-center">No data</div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[var(--surface)]">
                    <tr className="border-b border-[var(--border)]">
                      <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Spec</th>
                      <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Runs</th>
                      <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens</th>
                      {!data.allSubscription && (
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Cost</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.bySpec.map(s => (
                      <tr key={s.specSlug} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-1.5 font-mono truncate max-w-[200px]" title={s.specSlug}>{s.specSlug}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{s.runCount}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(s.inputTokens + s.outputTokens)}</td>
                        {!data.allSubscription && (
                          <td className="px-3 py-1.5 text-right font-mono">{formatCost(s.totalCost)}</td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Model breakdown table */}
        {data.modelDistribution.length > 0 && (
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              Model Breakdown
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Model</th>
                  <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Tier</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Stories</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">%</th>
                  {!data.allSubscription && (
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Cost</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {data.modelDistribution.map(m => (
                  <tr key={m.model} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-1.5 font-mono">{m.model}</td>
                    <td className="px-3 py-1.5">
                      <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${TIER_BG[m.tier] || 'bg-zinc-500/15 text-zinc-400'}`}>
                        {m.tier}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{m.storyCount}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{m.percentage}%</td>
                    {!data.allSubscription && (
                      <td className="px-3 py-1.5 text-right font-mono">{formatCost(m.totalCost)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(piProvidersLoading || piProvidersError || piProviders.length > 0) && (
          <div className="rounded-lg bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
            <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                  Pi Providers
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5">
                  Provider-level usage and marginal cost for Pi runs
                </div>
              </div>
              {piProvidersLoading && (
                <div className="text-xs text-[var(--text-muted)]">Loading...</div>
              )}
            </div>

            {piProvidersError ? (
              <div className="px-4 py-6 flex items-center justify-between gap-3">
                <span className="text-sm text-red-400">{piProvidersError}</span>
                <button onClick={fetchPiProviders} className="text-xs text-[var(--accent)] hover:underline">Retry</button>
              </div>
            ) : piProvidersLoading ? (
              <div className="px-4 py-6 text-sm text-[var(--text-muted)]">
                Loading Pi provider aggregates...
              </div>
            ) : (
              <>
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)]">
                        <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Provider</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Runs</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Stories</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Input</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Output</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Total Cost</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Avg/Story</th>
                        <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Last Used</th>
                      </tr>
                    </thead>
                    <tbody>
                      {piProviders.map((row) => (
                        <tr key={row.provider} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-3 py-1.5 font-mono">{row.provider}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{row.totalRuns}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{row.totalStories}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{formatTokens(row.totalInputTokens)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{formatTokens(row.totalOutputTokens)}</td>
                          <td className="px-3 py-1.5 text-right"><PiProviderCostCell provider={row.provider} cost={row.totalCost} /></td>
                          <td className="px-3 py-1.5 text-right font-mono">{formatPiProviderCostLabel(row.provider, row.avgCostPerStory)}</td>
                          <td className="px-3 py-1.5 text-[var(--text-muted)]">{formatPiProviderLastUsed(row.lastUsed)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="md:hidden divide-y divide-[var(--border)]">
                  {piProviders.map((row) => (
                    <div key={row.provider} className="p-4 space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-mono text-sm">{row.provider}</span>
                        <PiProviderCostCell provider={row.provider} cost={row.totalCost} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <MetricCard label="Runs" value={String(row.totalRuns)} />
                        <MetricCard label="Stories" value={String(row.totalStories)} />
                        <MetricCard label="Input" value={formatTokens(row.totalInputTokens)} />
                        <MetricCard label="Output" value={formatTokens(row.totalOutputTokens)} />
                        <MetricCard label="Avg/Story" value={formatPiProviderCostLabel(row.provider, row.avgCostPerStory)} />
                        <MetricCard label="Last Used" value={formatPiProviderLastUsed(row.lastUsed)} />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PiProviderCostCell({ provider, cost }: { provider: string; cost: number }) {
  const label = formatPiProviderCostLabel(provider, cost);

  if (label === 'Sub') {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-400">
        Sub
      </span>
    );
  }

  return <span className="font-mono">{label}</span>;
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</div>
      <div className="mt-1 font-mono text-[var(--text)]">{value}</div>
    </div>
  );
}

function formatPiProviderLastUsed(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
