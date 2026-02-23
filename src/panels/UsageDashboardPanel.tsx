import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Coins, Cpu, ArrowDownUp, RefreshCw, Calendar, Loader2 } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────────────── */

interface UsageGroupRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  count: number;
}

interface TimeSeriesRow {
  date: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

interface UsageTotals {
  total_input_tokens: number;
  total_output_tokens: number;
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
  const [groupBy, setGroupBy] = useState<GroupBy>('model');
  const [dateRange, setDateRange] = useState<DateRange>('30d');

  const fetchUsage = useCallback(async () => {
    if (!workspaceId) return;
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
    } catch (err) {
      console.error('[UsageDashboard] fetch error:', err);
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
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Coins size={20} className="text-accent" />
          <h2 className="text-lg font-semibold">Token Usage</h2>
          {data?.hasActiveRuns && (
            <span className="flex items-center gap-1 text-xs text-emerald-400 ml-2">
              <RefreshCw size={12} className="animate-spin" />
              Live
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Date range selector */}
          <div className="flex items-center gap-1 bg-panel-alt rounded-md p-0.5">
            <Calendar size={14} className="text-muted ml-1.5" />
            {(['7d', '30d', '90d', 'all'] as DateRange[]).map(r => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${
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
          <div className="flex items-center gap-1 bg-panel-alt rounded-md p-0.5">
            <ArrowDownUp size={14} className="text-muted ml-1.5" />
            {(['model', 'spec', 'story', 'user'] as GroupBy[]).map(g => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`px-2.5 py-1 text-xs rounded capitalize transition-colors ${
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
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="animate-spin text-muted" size={28} />
          </div>
        ) : !data || data.totals.total_records === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted text-sm gap-2">
            <Cpu size={32} className="opacity-40" />
            <p>No token usage data yet.</p>
            <p className="text-xs">Run a pipeline to start tracking usage.</p>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-4 gap-4">
              <SummaryCard
                label="Total Tokens"
                value={formatTokens(data.totals.total_input_tokens + data.totals.total_output_tokens)}
                sub={`${formatTokens(data.totals.total_input_tokens)} in / ${formatTokens(data.totals.total_output_tokens)} out`}
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
                value={data.totals.total_output_tokens > 0
                  ? `${(data.totals.total_input_tokens / data.totals.total_output_tokens).toFixed(1)}x`
                  : 'N/A'}
                sub="input tokens per output"
              />
            </div>

            {/* Bar chart: usage by group */}
            <div className="bg-panel-alt rounded-lg p-4">
              <h3 className="text-sm font-medium text-muted mb-3 capitalize">
                Usage by {groupBy}
              </h3>
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
                    formatter={(value?: number, name?: string) => [
                      formatTokens(value ?? 0),
                      name === 'total_input_tokens' ? 'Input' : 'Output',
                    ]}
                  />
                  <Legend
                    formatter={(value: string) =>
                      value === 'total_input_tokens' ? 'Input Tokens' : 'Output Tokens'
                    }
                  />
                  <Bar dataKey="total_input_tokens" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="total_output_tokens" fill="#22d3ee" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Line chart: usage over time */}
            {data.timeSeries.length > 1 && (
              <div className="bg-panel-alt rounded-lg p-4">
                <h3 className="text-sm font-medium text-muted mb-3">Usage Over Time</h3>
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
                      formatter={(value?: number, name?: string) => {
                        const v = value ?? 0;
                        if (name === 'total_cost_usd') return [formatCost(v), 'Cost'];
                        return [formatTokens(v), name === 'total_input_tokens' ? 'Input' : 'Output'];
                      }}
                    />
                    <Legend
                      formatter={(value: string) => {
                        if (value === 'total_cost_usd') return 'Cost (USD)';
                        return value === 'total_input_tokens' ? 'Input Tokens' : 'Output Tokens';
                      }}
                    />
                    <Line yAxisId="tokens" type="monotone" dataKey="total_input_tokens" stroke="#6366f1" strokeWidth={2} dot={false} />
                    <Line yAxisId="tokens" type="monotone" dataKey="total_output_tokens" stroke="#22d3ee" strokeWidth={2} dot={false} />
                    <Line yAxisId="cost" type="monotone" dataKey="total_cost_usd" stroke="#f59e0b" strokeWidth={2} dot={false} strokeDasharray="5 5" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Cost breakdown table */}
            <div className="bg-panel-alt rounded-lg p-4">
              <h3 className="text-sm font-medium text-muted mb-3 capitalize">
                Cost Breakdown by {groupBy}
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted border-b border-border">
                    <th className="pb-2 font-medium capitalize">{groupBy}</th>
                    <th className="pb-2 font-medium text-right">Input</th>
                    <th className="pb-2 font-medium text-right">Output</th>
                    <th className="pb-2 font-medium text-right">Cost</th>
                    <th className="pb-2 font-medium text-right">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {data.grouped.map((row, i) => (
                    <tr key={row.group_key} className="border-b border-border/50 last:border-0">
                      <td className="py-2 flex items-center gap-2">
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="truncate max-w-[200px]" title={row.group_key}>
                          {row.group_key}
                        </span>
                      </td>
                      <td className="py-2 text-right text-muted">{formatTokens(row.total_input_tokens)}</td>
                      <td className="py-2 text-right text-muted">{formatTokens(row.total_output_tokens)}</td>
                      <td className="py-2 text-right font-medium">{formatCost(row.total_cost_usd)}</td>
                      <td className="py-2 text-right text-muted">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────────── */

function SummaryCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-panel-alt rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-2xl font-bold">{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}
