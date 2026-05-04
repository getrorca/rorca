/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { BarChart3, RefreshCw, Calendar, Loader2, AlertTriangle } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────────────── */

interface CompletionGroup {
  label: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  passRate: number;
}

interface CompletionRateResponse {
  byComplexity: CompletionGroup[];
  byTag: CompletionGroup[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    overallPassRate: number;
  };
  dateRange: { from: string; to: string };
}

type DateRange = '7d' | '30d' | '90d' | '180d';
type ViewTab = 'complexity' | 'tags';

/* ─── Helpers ─────────────────────────────────────────────────────── */

function dateRangeToDays(range: DateRange): number {
  return range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 180;
}

function dateRangeToISO(range: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - dateRangeToDays(range) * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/* ─── Colors ──────────────────────────────────────────────────────── */

const COLOR_PASS = '#10b981';
const COLOR_FAIL = '#ef4444';
const COLOR_SKIP = '#6b7280';
const COLOR_WARN = '#ef4444';  // same red for <60% bars
const THRESHOLD = 60;

/* ─── Custom Tooltip ──────────────────────────────────────────────── */

interface TooltipPayloadEntry {
  dataKey: string;
  value: number;
  color: string;
  name: string;
  payload?: CompletionGroup;
}

function RateTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const group = payload[0]?.payload;
  if (!group) return null;

  return (
    <div className="bg-panel border border-border rounded-lg shadow-lg p-3 max-w-xs">
      <p className="text-xs text-muted mb-2 font-medium">{label}</p>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_PASS }} />
            Passed
          </span>
          <span className="font-mono">{group.passed}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_FAIL }} />
            Failed
          </span>
          <span className="font-mono">{group.failed}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_SKIP }} />
            Skipped
          </span>
          <span className="font-mono">{group.skipped}</span>
        </div>
        <div className="flex justify-between gap-4 pt-1 border-t border-border mt-1">
          <span className="font-medium">Pass Rate</span>
          <span className={`font-mono font-bold ${group.passRate < THRESHOLD ? 'text-red-500' : 'text-green-500'}`}>
            {group.passRate}%
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Horizontal Bar Row (for the detailed table view) ────────────── */

function RateBar({ group }: { group: CompletionGroup }) {
  const isWarn = group.passRate < THRESHOLD;

  return (
    <div className="flex items-center gap-3 py-2">
      {/* Label */}
      <div className="w-28 text-sm truncate font-medium flex items-center gap-1.5">
        {isWarn && <AlertTriangle size={14} className="text-red-500 shrink-0" />}
        <span className={isWarn ? 'text-red-500' : ''}>{group.label}</span>
      </div>

      {/* Stacked bar */}
      <div className="flex-1 flex items-center gap-2">
        <div className="flex-1 h-6 bg-bg rounded-full overflow-hidden flex">
          {group.total > 0 && (
            <>
              {group.passed > 0 && (
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${(group.passed / group.total) * 100}%`,
                    backgroundColor: isWarn ? COLOR_WARN + '40' : COLOR_PASS,
                  }}
                />
              )}
              {group.failed > 0 && (
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${(group.failed / group.total) * 100}%`,
                    backgroundColor: COLOR_FAIL,
                  }}
                />
              )}
              {group.skipped > 0 && (
                <div
                  className="h-full transition-all"
                  style={{
                    width: `${(group.skipped / group.total) * 100}%`,
                    backgroundColor: COLOR_SKIP,
                  }}
                />
              )}
            </>
          )}
        </div>
        <span className={`text-sm font-mono font-bold w-14 text-right ${
          isWarn ? 'text-red-500' : 'text-green-500'
        }`}>
          {group.passRate}%
        </span>
        <span className="text-xs text-muted w-16 text-right">
          {group.total} stories
        </span>
      </div>
    </div>
  );
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function CompletionRatePanel() {
  const { workspaceId, workspaces } = useWorkspace();
  const [data, setData] = useState<CompletionRateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [filterWorkspace, setFilterWorkspace] = useState<string>('');
  const [viewTab, setViewTab] = useState<ViewTab>('complexity');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { from, to } = dateRangeToISO(dateRange);
      const params = new URLSearchParams({ from, to });
      const wsId = filterWorkspace || workspaceId;
      if (wsId) params.set('workspace_id', wsId);

      const res = await apiFetch<CompletionRateResponse>(`/api/analytics/completion-rates?${params}`);
      setData(res);
    } catch (err) {
      console.error('[CompletionRate] Fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateRange, filterWorkspace]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const groups = viewTab === 'complexity' ? data?.byComplexity : data?.byTag;
  const warnCount = (groups ?? []).filter(g => g.passRate < THRESHOLD).length;

  // Chart data: pass rate per group for a simple bar chart
  const chartData = (groups ?? []).map(g => ({
    ...g,
    name: g.label,
  }));

  return (
    <div className="flex flex-col h-full overflow-hidden" role="main" aria-label="Completion Rates analytics panel">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 size={20} strokeWidth={1.5} className="text-accent" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Completion Rates</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs" role="group" aria-label="Date range filter">
            <Calendar size={14} className="text-muted" aria-hidden="true" />
            {(['7d', '30d', '90d', '180d'] as DateRange[]).map(r => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                aria-pressed={dateRange === r}
                aria-label={`Filter by last ${r}`}
                className={`px-2 py-1 rounded transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  dateRange === r
                    ? 'bg-accent text-white'
                    : 'text-muted hover:text-[var(--text)] hover:bg-bg'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-1.5 text-muted hover:text-[var(--text)] transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
            aria-label="Refresh completion rate data"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5" aria-live="polite" aria-busy={loading}>
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="completion-workspace-filter" className="sr-only">Filter by workspace</label>
          <select
            id="completion-workspace-filter"
            value={filterWorkspace}
            onChange={e => setFilterWorkspace(e.target.value)}
            className="text-xs bg-bg border border-border rounded px-2 py-1.5 text-[var(--text)] ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <option value="">All workspaces</option>
            {workspaces.map(ws => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>

          {/* View tab toggle */}
          <div className="flex items-center gap-1 text-xs ml-auto" role="group" aria-label="View breakdown by" aria-live="polite">
            {(['complexity', 'tags'] as ViewTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => setViewTab(tab)}
                aria-pressed={viewTab === tab}
                className={`px-3 py-1.5 rounded transition-colors capitalize ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                  viewTab === tab
                    ? 'bg-accent text-white'
                    : 'text-muted hover:text-[var(--text)] hover:bg-bg'
                }`}
              >
                {tab === 'complexity' ? 'By Complexity' : 'By Tag'}
              </button>
            ))}
          </div>
        </div>

        {/* Summary cards */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Total stories: ${data.summary.total}`}>
              <p className="text-xs text-muted mb-1">Total Stories</p>
              <p className="text-xl font-bold" aria-hidden="true">{data.summary.total}</p>
            </div>
            <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Passed stories: ${data.summary.passed}`}>
              <p className="text-xs text-muted mb-1">Passed</p>
              <p className="text-xl font-bold text-green-500" aria-hidden="true">{data.summary.passed}</p>
            </div>
            <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Failed stories: ${data.summary.failed}`}>
              <p className="text-xs text-muted mb-1">Failed</p>
              <p className="text-xl font-bold text-red-500" aria-hidden="true">{data.summary.failed}</p>
            </div>
            <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Overall pass rate: ${data.summary.overallPassRate}%`}>
              <p className="text-xs text-muted mb-1">Overall Pass Rate</p>
              <p className={`text-xl font-bold ${
                data.summary.overallPassRate < THRESHOLD ? 'text-red-500' : 'text-green-500'
              }`} aria-hidden="true">
                {data.summary.overallPassRate}%
              </p>
            </div>
            <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Groups needing attention: ${warnCount}`}>
              <p className="text-xs text-muted mb-1">Needs Attention</p>
              <p className={`text-xl font-bold ${warnCount > 0 ? 'text-red-500' : 'text-green-500'}`} aria-hidden="true">
                {warnCount} {warnCount === 1 ? 'group' : 'groups'}
              </p>
            </div>
          </div>
        )}

        {/* Chart */}
        {loading ? (
          <div className="flex items-center justify-center h-64 text-muted">
            <Loader2 size={24} className="animate-spin" aria-label="Loading completion rate data" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="flex flex-col items-center max-w-[400px] text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
                <BarChart3 size={28} className="text-accent" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No completion data yet</h3>
              <p className="text-sm text-muted leading-relaxed">Completion rates appear after your first pipeline run. Run a spec to see pass rates.</p>
            </div>
          </div>
        ) : (
          <div className="min-h-[200px] h-72">
            <div className="w-full" role="img" aria-label={`Horizontal bar chart showing pass rate by ${viewTab === 'complexity' ? 'complexity' : 'tag'}`}>
              <ResponsiveContainer width="100%" height={288}>
                <BarChart
                  data={chartData}
                  layout="vertical"
                  margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tick={{ fontSize: 12, fill: 'var(--muted)' }}
                    tickFormatter={v => `${v}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={100}
                    tick={{ fontSize: 12, fill: 'var(--muted)' }}
                  />
                  <Tooltip content={<RateTooltip />} cursor={{ fill: 'var(--border)', opacity: 0.3 }} />
                  <Bar dataKey="passRate" name="Pass Rate" radius={[0, 4, 4, 0]}>
                    {chartData.map((entry, idx) => (
                      <Cell
                        key={idx}
                        fill={entry.passRate < THRESHOLD ? COLOR_WARN : COLOR_PASS}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* Screen-reader table alternative */}
            <table className="sr-only" aria-label={`Pass rate by ${viewTab} data table`}>
              <thead>
                <tr>
                  <th scope="col" role="columnheader">{viewTab === 'complexity' ? 'Complexity' : 'Tag'}</th>
                  <th scope="col" role="columnheader">Pass Rate</th>
                  <th scope="col" role="columnheader">Passed</th>
                  <th scope="col" role="columnheader">Failed</th>
                  <th scope="col" role="columnheader">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((entry) => (
                  <tr key={entry.label}>
                    <td>{entry.label}</td>
                    <td>{entry.passRate}%</td>
                    <td>{entry.passed}</td>
                    <td>{entry.failed}</td>
                    <td>{entry.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Detailed breakdown */}
        {(groups ?? []).length > 0 && (
          <div className="border border-border rounded-lg p-4 space-y-1">
            <h3 className="text-sm font-medium text-muted mb-3">
              Detailed Breakdown — {viewTab === 'complexity' ? 'By Complexity' : 'By Tag'}
            </h3>

            {/* Legend */}
            <div className="flex items-center gap-4 text-xs text-muted mb-2">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_PASS }} />
                Passed
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_FAIL }} />
                Failed
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: COLOR_SKIP }} />
                Skipped
              </span>
              <span className="flex items-center gap-1">
                <AlertTriangle size={12} className="text-red-500" />
                Below {THRESHOLD}%
              </span>
            </div>

            <div className="divide-y divide-border">
              {(groups ?? []).map(g => (
                <RateBar key={g.label} group={g} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
