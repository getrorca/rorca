/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { TrendingUp, RefreshCw, Calendar, Loader2, Filter } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import ErrorBanner from '../components/ErrorBanner';

/* ─── Types ───────────────────────────────────────────────────────── */

interface VelocityWeek {
  week: string;
  week_start: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  specs: string[];
  rollingAvg: number;
}

interface VelocityResponse {
  velocity: VelocityWeek[];
  availableSpecs: string[];
  dateRange: { from: string; to: string };
}

type DateRange = '4w' | '8w' | '12w' | '24w';

/* ─── Helpers ─────────────────────────────────────────────────────── */

function dateRangeToISO(range: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  const weeks = range === '4w' ? 4 : range === '8w' ? 8 : range === '12w' ? 12 : 24;
  const from = new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

function formatWeekLabel(week: string, weekStart: string): string {
  if (!weekStart) return week;
  const d = new Date(weekStart + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/* ─── Chart colors ────────────────────────────────────────────────── */

const COLOR_PASSED = '#10b981';   // green
const COLOR_FAILED = '#ef4444';   // red
const COLOR_SKIPPED = '#6b7280';  // gray
const COLOR_TREND = '#6366f1';    // indigo

/* ─── Custom Tooltip ──────────────────────────────────────────────── */

interface TooltipPayloadEntry {
  dataKey: string;
  value: number;
  color: string;
  name: string;
}

function VelocityTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;

  // Get the original data point for specs list
  const dataPoint = payload[0] as TooltipPayloadEntry & { payload?: VelocityWeek };
  const week = (dataPoint as { payload?: VelocityWeek }).payload;

  return (
    <div className="bg-panel border border-border rounded-lg shadow-lg p-3 max-w-xs">
      <p className="text-xs text-muted mb-2 font-medium">{label}</p>
      <div className="space-y-1">
        {payload.filter(p => p.dataKey !== 'rollingAvg').map(p => (
          <div key={p.dataKey} className="flex items-center justify-between gap-4 text-sm">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: p.color }} />
              {p.name}
            </span>
            <span className="font-mono font-medium">{p.value}</span>
          </div>
        ))}
        {payload.find(p => p.dataKey === 'rollingAvg') && (
          <div className="flex items-center justify-between gap-4 text-sm border-t border-border pt-1 mt-1">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 rounded" style={{ backgroundColor: COLOR_TREND }} />
              4-week avg
            </span>
            <span className="font-mono font-medium">
              {payload.find(p => p.dataKey === 'rollingAvg')?.value}
            </span>
          </div>
        )}
      </div>
      {week?.specs && week.specs.length > 0 && (
        <div className="mt-2 pt-2 border-t border-border">
          <p className="text-xs text-muted mb-1">Specs completed:</p>
          <div className="flex flex-wrap gap-1">
            {week.specs.slice(0, 5).map(s => (
              <span key={s} className="text-xs bg-bg px-1.5 py-0.5 rounded text-[var(--text)]">
                {s}
              </span>
            ))}
            {week.specs.length > 5 && (
              <span className="text-xs text-muted">+{week.specs.length - 5} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function VelocityChartPanel() {
  const { workspaceId, workspaces } = useWorkspace();
  const [data, setData] = useState<VelocityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>('12w');
  const [filterSpec, setFilterSpec] = useState<string>('');
  const [filterWorkspace, setFilterWorkspace] = useState<string>('');

  const fetchVelocity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { from, to } = dateRangeToISO(dateRange);
      const params = new URLSearchParams({ from, to });
      const wsId = filterWorkspace || workspaceId;
      if (wsId) params.set('workspace_id', wsId);
      if (filterSpec) params.set('spec_id', filterSpec);

      const res = await apiFetch<VelocityResponse>(`/api/analytics/velocity?${params}`);
      setData(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load velocity data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateRange, filterSpec, filterWorkspace]);

  useEffect(() => { fetchVelocity(); }, [fetchVelocity]);

  // Summary stats
  const totalPassed = data?.velocity.reduce((s, w) => s + w.passed, 0) ?? 0;
  const totalFailed = data?.velocity.reduce((s, w) => s + w.failed, 0) ?? 0;
  const totalSkipped = data?.velocity.reduce((s, w) => s + w.skipped, 0) ?? 0;
  const totalStories = totalPassed + totalFailed + totalSkipped;
  const avgPerWeek = data?.velocity.length ? (totalStories / data.velocity.length).toFixed(1) : '0';
  const latestAvg = data?.velocity.length ? data.velocity[data.velocity.length - 1].rollingAvg : 0;

  // Chart data with formatted labels
  const chartData = (data?.velocity ?? []).map(w => ({
    ...w,
    label: formatWeekLabel(w.week, w.week_start),
  }));

  return (
    <div className="flex flex-col h-full overflow-hidden" role="main" aria-label="Velocity Chart analytics panel">
      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp size={20} strokeWidth={1.5} className="text-accent" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Velocity Chart</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Date range selector */}
          <div className="flex items-center gap-1 text-xs" role="group" aria-label="Date range filter">
            <Calendar size={14} className="text-muted" aria-hidden="true" />
            {(['4w', '8w', '12w', '24w'] as DateRange[]).map(r => (
              <button
                key={r}
                onClick={() => setDateRange(r)}
                aria-pressed={dateRange === r}
                aria-label={`Show last ${r}`}
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
            onClick={fetchVelocity}
            disabled={loading}
            className="p-1.5 text-muted hover:text-[var(--text)] transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
            aria-label="Refresh velocity data"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5" aria-live="polite" aria-busy={loading}>
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <Filter size={14} className="text-muted" aria-hidden="true" />
          {/* Workspace filter */}
          <label htmlFor="velocity-workspace-filter" className="sr-only">Filter by workspace</label>
          <select
            id="velocity-workspace-filter"
            value={filterWorkspace}
            onChange={e => { setFilterWorkspace(e.target.value); setFilterSpec(''); }}
            className="text-xs bg-bg border border-border rounded px-2 py-1.5 text-[var(--text)] ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <option value="">All workspaces</option>
            {workspaces.map(ws => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
          {/* Spec filter */}
          <label htmlFor="velocity-spec-filter" className="sr-only">Filter by spec</label>
          <select
            id="velocity-spec-filter"
            value={filterSpec}
            onChange={e => setFilterSpec(e.target.value)}
            className="text-xs bg-bg border border-border rounded px-2 py-1.5 text-[var(--text)] ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
          >
            <option value="">All specs</option>
            {(data?.availableSpecs ?? []).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Total stories: ${totalStories}`}>
            <p className="text-xs text-muted mb-1">Total Stories</p>
            <p className="text-xl font-bold" aria-hidden="true">{totalStories}</p>
          </div>
          <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Average stories per week: ${avgPerWeek}`}>
            <p className="text-xs text-muted mb-1">Avg / Week</p>
            <p className="text-xl font-bold" aria-hidden="true">{avgPerWeek}</p>
          </div>
          <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Current trend: ${latestAvg} (4-week rolling average)`}>
            <p className="text-xs text-muted mb-1">Current Trend</p>
            <p className="text-xl font-bold" aria-hidden="true">{latestAvg}</p>
            <p className="text-xs text-muted">4-week rolling avg</p>
          </div>
          <div className="bg-bg rounded-lg p-3 border border-border" aria-label={`Pass rate: ${totalStories > 0 ? Math.round((totalPassed / totalStories) * 100) : 0}%`}>
            <p className="text-xs text-muted mb-1">Pass Rate</p>
            <p className="text-xl font-bold" aria-hidden="true">
              {totalStories > 0 ? Math.round((totalPassed / totalStories) * 100) : 0}%
            </p>
          </div>
        </div>

        {/* Error banner */}
        {error && <ErrorBanner message={error} onRetry={fetchVelocity} onDismiss={() => setError(null)} />}

        {/* Chart */}
        {loading ? (
          <div className="flex items-center justify-center h-64 text-muted">
            <Loader2 size={24} className="animate-spin" aria-label="Loading velocity data" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="flex flex-col items-center max-w-[400px] text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
                <TrendingUp size={28} className="text-accent" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No velocity data yet</h3>
              <p className="text-sm text-muted leading-relaxed">Velocity charts appear after your first pipeline run. Run a spec to get started.</p>
            </div>
          </div>
        ) : (
          <div className="min-h-[200px] h-80">
            <div className="w-full" role="img" aria-label="Stacked bar chart showing weekly story velocity with passed, failed, and skipped counts and a 4-week rolling average trend line">
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 12, fill: 'var(--muted)' }}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: 'var(--muted)' }}
                    tickLine={false}
                  />
                  <Tooltip
                    content={<VelocityTooltip />}
                    cursor={{ fill: 'var(--border)', opacity: 0.3 }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 12 }}
                    iconType="square"
                  />
                  <Bar dataKey="passed" name="Passed" stackId="stories" fill={COLOR_PASSED} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="failed" name="Failed" stackId="stories" fill={COLOR_FAILED} radius={[0, 0, 0, 0]} />
                  <Bar dataKey="skipped" name="Skipped" stackId="stories" fill={COLOR_SKIPPED} radius={[2, 2, 0, 0]} />
                  <Line
                    type="monotone"
                    dataKey="rollingAvg"
                    name="4-week avg"
                    stroke={COLOR_TREND}
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {/* Screen-reader table alternative */}
            <table className="sr-only" aria-label="Weekly velocity data table">
              <thead>
                <tr>
                  <th scope="col" role="columnheader">Week</th>
                  <th scope="col" role="columnheader">Passed</th>
                  <th scope="col" role="columnheader">Failed</th>
                  <th scope="col" role="columnheader">Skipped</th>
                  <th scope="col" role="columnheader">4-week avg</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((w) => (
                  <tr key={w.week}>
                    <td>{w.label}</td>
                    <td>{w.passed}</td>
                    <td>{w.failed}</td>
                    <td>{w.skipped}</td>
                    <td>{w.rollingAvg}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Weekly breakdown table */}
        {chartData.length > 0 && (
          <div className="border border-border rounded-lg overflow-hidden overflow-x-auto">
            <table className="w-full text-sm" role="table" aria-label="Weekly story breakdown table">
              <thead>
                <tr className="bg-bg border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2" role="columnheader">Week</th>
                  <th className="px-3 py-2 text-right" role="columnheader">Passed</th>
                  <th className="px-3 py-2 text-right" role="columnheader">Failed</th>
                  <th className="px-3 py-2 text-right" role="columnheader">Skipped</th>
                  <th className="px-3 py-2 text-right" role="columnheader">Total</th>
                  <th className="px-3 py-2 text-right" role="columnheader">Avg</th>
                  <th className="px-3 py-2" role="columnheader">Notable Specs</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map(w => (
                  <tr key={w.week} className="border-b border-border last:border-0 hover:bg-bg transition-colors">
                    <td className="px-3 py-2 font-mono text-xs">{w.label}</td>
                    <td className="px-3 py-2 text-right font-mono text-green-500">{w.passed}</td>
                    <td className="px-3 py-2 text-right font-mono text-red-500">{w.failed}</td>
                    <td className="px-3 py-2 text-right font-mono text-muted">{w.skipped}</td>
                    <td className="px-3 py-2 text-right font-mono font-medium">{w.total}</td>
                    <td className="px-3 py-2 text-right font-mono text-accent">{w.rollingAvg}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {w.specs.slice(0, 3).map(s => (
                          <span key={s} className="text-xs bg-panel border border-border px-1.5 py-0.5 rounded">
                            {s}
                          </span>
                        ))}
                        {w.specs.length > 3 && (
                          <span className="text-xs text-muted">+{w.specs.length - 3}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
