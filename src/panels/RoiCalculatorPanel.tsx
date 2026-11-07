/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { Calculator, Calendar, Loader2, Settings2, Check } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { ProBadge } from '../components/UpgradePrompt';
import { useAuth } from '../contexts/AuthContext';

/* ─── Types ───────────────────────────────────────────────────────── */

interface ROITimeSeries {
  date: string;
  stories_passed: number;
  hours_saved: number;
  llm_cost: number;
  net_savings: number;
}

interface ROIResponse {
  total_stories_passed: number;
  estimated_hours_saved: number;
  total_llm_cost: number;
  savings_value: number;
  net_savings: number;
  roi_multiplier: number | null;
  metricDefinitions: {
    storiesPassed: string;
    estimatedValue: string;
    costBasis: string;
  };
  accounting: {
    basis: 'blended_effective';
    meteredCostUsd: number;
    allocatedSubscriptionCostUsd: number;
    blendedEffectiveCostUsd: number;
    coverage: {
      totalRecords: number;
      pricedRecords: number;
      unpricedRecords: number;
      pricingCoverage: number | null;
      profileClassifiedRecords: number;
      allocationModes: string[];
    };
  };
  config: {
    hours_per_story: number;
    hourly_rate: number;
  };
  timeSeries: ROITimeSeries[];
  dateRange: { from: string; to: string };
}

type DateRange = '7d' | '30d' | '90d' | 'all';

/* ─── Helpers ─────────────────────────────────────────────────────── */

function formatCurrency(usd: number): string {
  if (Math.abs(usd) >= 1000) return `$${(usd / 1000).toFixed(1)}K`;
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatHours(h: number): string {
  if (h >= 1000) return `${(h / 1000).toFixed(1)}K`;
  return h.toFixed(1);
}

function dateRangeToISO(range: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (range === 'all') return { from: '2020-01-01T00:00:00Z', to };
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function RoiCalculatorPanel() {
  const { workspaceId } = useWorkspace();
  const { user } = useAuth();
  const userPlan = user?.app_metadata?.plan as string | undefined;
  const isFreePlan = !userPlan || userPlan === 'free';
  const [data, setData] = useState<ROIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [showSettings, setShowSettings] = useState(false);
  const [hoursPerStory, setHoursPerStory] = useState(4);
  const [hourlyRate, setHourlyRate] = useState(75);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const fetchROI = useCallback(async () => {
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
        workspace_id: workspaceId,
        from,
        to,
      });
      const result = await apiFetch<ROIResponse>(`/api/analytics/roi?${params}`);
      setData(result);
      setHoursPerStory(result.config.hours_per_story);
      setHourlyRate(result.config.hourly_rate);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ROI analytics');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, dateRange]);

  useEffect(() => {
    setLoading(true);
    fetchROI();
  }, [fetchROI]);

  const saveConfig = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch('/api/analytics/roi/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: workspaceId,
          hours_per_story: hoursPerStory,
          hourly_rate: hourlyRate,
        }),
      });
      await fetchROI();
      setShowSettings(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save ROI assumptions');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden" role="main" aria-label="ROI Calculator analytics panel">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Calculator size={20} className="text-accent" aria-hidden="true" />
          <h2 className="text-lg font-semibold">ROI Calculator</h2>
          {isFreePlan && <ProBadge />}
        </div>

        <div className="flex items-center gap-2">
          {/* Date range */}
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

          {/* Settings toggle */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            aria-pressed={showSettings}
            aria-label="Toggle ROI settings"
            className={`p-1.5 rounded transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
              showSettings ? 'bg-accent text-white' : 'text-muted hover:text-[var(--text)]'
            }`}
          >
            <Settings2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Settings panel */}
      {showSettings && (
        <div className="px-5 py-3 border-b border-border bg-panel-alt flex items-center gap-4 text-sm" role="group" aria-label="ROI calculation settings">
          <label className="flex items-center gap-2" htmlFor="roi-hours-per-story">
            <span className="text-muted">Hours per story:</span>
            <input
              id="roi-hours-per-story"
              type="number"
              min={0.5}
              max={100}
              step={0.5}
              value={hoursPerStory}
              onChange={e => setHoursPerStory(parseFloat(e.target.value) || 0)}
              className="w-20 bg-bg border border-border rounded px-2 py-1 text-sm ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
              aria-label="Hours saved per story"
            />
          </label>
          <label className="flex items-center gap-2" htmlFor="roi-hourly-rate">
            <span className="text-muted">Hourly rate ($):</span>
            <input
              id="roi-hourly-rate"
              type="number"
              min={1}
              max={1000}
              step={5}
              value={hourlyRate}
              onChange={e => setHourlyRate(parseFloat(e.target.value) || 0)}
              className="w-24 bg-bg border border-border rounded px-2 py-1 text-sm ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
              aria-label="Developer hourly rate in dollars"
            />
          </label>
          <button
            onClick={saveConfig}
            disabled={saving}
            className="flex items-center gap-1 px-3 py-1 bg-accent text-white rounded text-xs hover:bg-accent/80 transition-colors disabled:opacity-50 ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50"
            aria-label="Save ROI settings"
          >
            {saving ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
            Save
          </button>
          {saveError && <p role="alert" className="text-xs text-red-400">{saveError}</p>}
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6" aria-live="polite" aria-busy={loading}>
        {error && data && (
          <div role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            ROI refresh failed; showing the last successful accounting snapshot. {error}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="animate-spin text-muted" size={28} aria-label="Loading ROI data" />
          </div>
        ) : error && !data ? (
          <div role="alert" className="flex flex-col items-center justify-center h-64 text-center">
            <h3 className="text-base font-semibold text-red-400">ROI analytics unavailable</h3>
            <p className="mt-1 text-sm text-muted">{error}</p>
            <p className="mt-1 text-xs text-muted">No estimates are shown because the accounting request failed.</p>
            <button onClick={() => { setLoading(true); void fetchROI(); }} className="mt-3 text-sm text-accent hover:underline">
              Retry
            </button>
          </div>
        ) : !workspaceId ? (
          <div className="flex items-center justify-center h-64 text-sm text-muted">Select a workspace to calculate ROI.</div>
        ) : !data ? (
          <div className="flex flex-col items-center justify-center h-64">
            <div className="flex flex-col items-center max-w-[400px] text-center">
              <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
                <Calculator size={28} className="text-accent" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No ROI data yet</h3>
              <p className="text-sm text-muted leading-relaxed">ROI calculations appear after your first pipeline run. Run a spec to get started.</p>
            </div>
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <MetricCard
                label="Deduplicated Passes"
                value={String(data.total_stories_passed)}
                sub="latest result per spec + story; retries count once"
              />
              <MetricCard
                label="Assumed Hours Saved"
                value={`${formatHours(data.estimated_hours_saved)}h`}
                sub={`estimate @ ${data.config.hours_per_story}h/passed story`}
              />
              <MetricCard
                label="Assumed Value"
                value={formatCurrency(data.savings_value)}
                sub={`configured @ $${data.config.hourly_rate}/hr`}
              />
              <MetricCard
                label="Blended AI Cost"
                value={formatCurrency(data.total_llm_cost)}
                sub="metered spend + allocated subscription cost"
              />
              <MetricCard
                label="Net Estimated Value"
                value={data.net_savings >= 0 ? formatCurrency(data.net_savings) : `-${formatCurrency(Math.abs(data.net_savings))}`}
                sub={data.roi_multiplier != null ? `${data.roi_multiplier}× assumed value / cost` : 'ratio unavailable: zero blended cost'}
                highlight={data.net_savings > 0}
              />
            </div>
            <div className="rounded-lg border border-border bg-panel-alt p-4 text-xs text-muted space-y-1" aria-label="ROI metric definitions">
              <p><span className="font-medium text-[var(--text)]">Passed-story basis:</span> {data.metricDefinitions.storiesPassed}</p>
              <p><span className="font-medium text-[var(--text)]">Value basis:</span> {data.metricDefinitions.estimatedValue}</p>
              <p><span className="font-medium text-[var(--text)]">Cost basis:</span> {data.metricDefinitions.costBasis}</p>
              <p>
                <span className="font-medium text-[var(--text)]">Coverage:</span>{' '}
                {data.accounting.coverage.pricingCoverage == null
                  ? 'No metered rows required pricing.'
                  : `${Math.round(data.accounting.coverage.pricingCoverage * 100)}% of metered rows priced.`}
                {data.accounting.coverage.unpricedRecords > 0
                  ? ` ${data.accounting.coverage.unpricedRecords} unpriced record${data.accounting.coverage.unpricedRecords === 1 ? '' : 's'} excluded from metered cost.`
                  : ''}
              </p>
            </div>

            {/* ROI Multiplier Banner */}
            {data.total_stories_passed > 0 && data.roi_multiplier != null && (
              <div className={`rounded-lg p-4 flex items-center justify-between ${
                data.net_savings > 0 ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-amber-500/10 border border-amber-500/30'
              }`}>
                <div>
                  <span className="text-sm text-muted">Assumed developer value per $1 of blended effective AI cost</span>
                  <span className={`text-2xl font-bold ml-2 ${data.net_savings > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                    ${data.roi_multiplier.toFixed(1)}
                  </span>
                </div>
                <div className="text-right text-xs text-muted">
                  Assumes {data.config.hours_per_story}h/passed story at ${data.config.hourly_rate}/hr
                </div>
              </div>
            )}
            {data.total_stories_passed > 0 && data.roi_multiplier == null && (
              <div role="status" className="rounded-lg p-4 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/30">
                Return ratio unavailable: blended effective AI cost is $0, so the value-to-cost ratio is not calculable.
              </div>
            )}

            {/* Cumulative Net Savings Chart */}
            {data.timeSeries.length > 1 && (
              <div className="bg-panel-alt rounded-lg p-4">
                <h3 className="text-sm font-medium text-muted mb-3">Cumulative Net Savings Over Time</h3>
                <div role="img" aria-label="Line chart showing cumulative net savings and daily LLM cost over time">
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={data.timeSeries} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        tickLine={false}
                      />
                      <YAxis
                        tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                        tickFormatter={(v: number) => formatCurrency(v)}
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
                          if (name === 'net_savings') return [formatCurrency(v), 'Net Savings'];
                          if (name === 'llm_cost') return [formatCurrency(v), 'LLM Cost'];
                          if (name === 'hours_saved') return [`${v}h`, 'Hours Saved'];
                          return [String(v), String(name ?? '')];
                        }) as any}
                      />
                      <Legend
                        formatter={(value: string) => {
                          if (value === 'net_savings') return 'Cumulative Net Savings';
                          if (value === 'llm_cost') return 'Daily LLM Cost';
                          if (value === 'hours_saved') return 'Daily Hours Saved';
                          return value;
                        }}
                      />
                      <Line type="monotone" dataKey="net_savings" stroke="#10b981" strokeWidth={2.5} dot={false} />
                      <Line type="monotone" dataKey="llm_cost" stroke="#ef4444" strokeWidth={1.5} dot={false} strokeDasharray="4 4" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {/* Screen-reader table alternative */}
                <table className="sr-only" aria-label="Cumulative net savings data table">
                  <thead>
                    <tr>
                      <th scope="col" role="columnheader">Date</th>
                      <th scope="col" role="columnheader">Net Savings</th>
                      <th scope="col" role="columnheader">LLM Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.timeSeries.map((row) => (
                      <tr key={row.date}>
                        <td>{row.date}</td>
                        <td>{formatCurrency(row.net_savings)}</td>
                        <td>{formatCurrency(row.llm_cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Daily Breakdown Table */}
            {data.timeSeries.length > 0 && (
              <div className="bg-panel-alt rounded-lg p-4">
                <h3 className="text-sm font-medium text-muted mb-3">Daily Breakdown</h3>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm" role="table" aria-label="Daily ROI breakdown table">
                    <thead className="sticky top-0 bg-panel-alt">
                      <tr className="text-left text-muted border-b border-border">
                        <th className="pb-2 font-medium" role="columnheader">Date</th>
                        <th className="pb-2 font-medium text-right" role="columnheader">Stories</th>
                        <th className="pb-2 font-medium text-right" role="columnheader">Hours Saved</th>
                        <th className="pb-2 font-medium text-right" role="columnheader">LLM Cost</th>
                        <th className="pb-2 font-medium text-right" role="columnheader">Net Savings</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.timeSeries.map(row => (
                        <tr key={row.date} className="border-b border-border/50 last:border-0">
                          <td className="py-1.5 text-muted">{row.date}</td>
                          <td className="py-1.5 text-right">{row.stories_passed}</td>
                          <td className="py-1.5 text-right text-muted">{row.hours_saved}h</td>
                          <td className="py-1.5 text-right text-red-400">{formatCurrency(row.llm_cost)}</td>
                          <td className={`py-1.5 text-right font-medium ${row.net_savings >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                            {formatCurrency(row.net_savings)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {data.total_stories_passed === 0 && (
              <div className="flex flex-col items-center justify-center h-32 text-muted text-sm gap-2">
                <Calculator size={28} className="opacity-40" />
                <p>No passed stories in this period. Run a pipeline to see ROI data.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────────── */

function MetricCard({ label, value, sub, highlight }: {
  label: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg p-4 flex flex-col gap-1 ${
      highlight ? 'bg-emerald-500/10 border border-emerald-500/30' : 'bg-panel-alt'
    }`} aria-label={`${label}: ${value}`}>
      <span className="text-xs text-muted">{label}</span>
      <span className={`text-2xl font-bold ${highlight ? 'text-emerald-400' : ''}`} aria-hidden="true">{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}
