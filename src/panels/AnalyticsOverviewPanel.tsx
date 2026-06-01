/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, DollarSign, Loader2, Target, TrendingUp } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import ErrorBanner from '../components/ErrorBanner';

interface UsageResponse {
  totals: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
    total_records: number;
  };
}

interface CostRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  story_count: number;
}

interface CostResponse {
  breakdown?: CostRow[];
}

interface ModelMetrics {
  model: string;
  totalStories: number;
  passRate: number;
  avgCostUsd: number;
  avgElapsedSeconds: number;
}

interface ModelsResponse {
  models: ModelMetrics[];
}

interface VelocityWeek {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  rollingAvg: number;
}

interface VelocityResponse {
  velocity: VelocityWeek[];
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function InsightCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof BarChart3;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-panel-alt p-4">
      <div className="mb-3 flex items-center gap-2 text-muted">
        <Icon size={16} className="text-accent" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-2xl font-semibold text-[var(--text)]">{value}</div>
      <div className="mt-1 text-xs text-muted">{sub}</div>
    </div>
  );
}

export default function AnalyticsOverviewPanel() {
  const { workspaceId } = useWorkspace();
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [costs, setCosts] = useState<CostResponse | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [velocity, setVelocity] = useState<VelocityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      const [usageRes, costsRes, modelsRes, velocityRes] = await Promise.all([
        apiFetch<UsageResponse>(`/api/analytics/usage?workspace_id=${encodeURIComponent(workspaceId)}&group_by=model&from=${encodeURIComponent(isoDaysAgo(30))}&to=${encodeURIComponent(now)}`),
        apiFetch<CostResponse>(`/api/analytics/costs?workspace_id=${encodeURIComponent(workspaceId)}&group_by=spec&from=${encodeURIComponent(isoDaysAgo(365))}&to=${encodeURIComponent(now)}`),
        apiFetch<ModelsResponse>(`/api/analytics/models?workspace_id=${encodeURIComponent(workspaceId)}&from=${encodeURIComponent(isoDaysAgo(30))}&to=${encodeURIComponent(now)}`),
        apiFetch<VelocityResponse>(`/api/analytics/velocity?workspace_id=${encodeURIComponent(workspaceId)}&from=${encodeURIComponent(isoDaysAgo(84))}&to=${encodeURIComponent(now)}`),
      ]);
      setUsage(usageRes);
      setCosts(costsRes);
      setModels(modelsRes);
      setVelocity(velocityRes);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load overview');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchOverview();
  }, [fetchOverview]);

  const totalTokens = useMemo(() => {
    const totals = usage?.totals;
    return (totals?.total_input_tokens ?? 0) + (totals?.total_output_tokens ?? 0);
  }, [usage]);

  const topModel = useMemo(() => {
    const list = [...(models?.models ?? [])].sort((a, b) => b.totalStories - a.totalStories);
    return list[0] ?? null;
  }, [models]);

  const completionSummary = useMemo(() => {
    const weeks = velocity?.velocity ?? [];
    return weeks.reduce(
      (acc, week) => {
        acc.total += week.total;
        acc.passed += week.passed;
        acc.failed += week.failed;
        acc.skipped += week.skipped;
        acc.latestRolling = week.rollingAvg;
        return acc;
      },
      { total: 0, passed: 0, failed: 0, skipped: 0, latestRolling: 0 },
    );
  }, [velocity]);

  const recentSpecs = (costs?.breakdown ?? []).slice(0, 5);
  const modelSnapshot = [...(models?.models ?? [])].sort((a, b) => b.totalStories - a.totalStories).slice(0, 5);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden" role="main" aria-label="Analytics overview panel">
      <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
        <div>
          <h2 className="text-lg font-semibold">Overview</h2>
          <p className="text-xs text-muted mt-1">Cross-workflow snapshot for this workspace — distinct from the detailed Usage and Costs tabs.</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {error && <ErrorBanner message={error} onRetry={fetchOverview} onDismiss={() => setError(null)} />}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <InsightCard
            icon={BarChart3}
            label="30d Tokens"
            value={formatTokens(totalTokens)}
            sub={`${formatTokens(usage?.totals.total_input_tokens ?? 0)} in / ${formatTokens(usage?.totals.total_output_tokens ?? 0)} out`}
          />
          <InsightCard
            icon={DollarSign}
            label="30d Cost"
            value={formatCost(usage?.totals.total_cost_usd ?? 0)}
            sub={`${usage?.totals.total_records ?? 0} story runs`}
          />
          <InsightCard
            icon={Target}
            label="Delivery"
            value={String(completionSummary.passed)}
            sub={`passed stories in range · ${completionSummary.latestRolling.toFixed(1)} rolling avg/week`}
          />
          <InsightCard
            icon={TrendingUp}
            label="Top Model"
            value={topModel?.model ?? '—'}
            sub={topModel ? `${Math.round(topModel.passRate * 100)}% pass · ${formatCost(topModel.avgCostUsd)} avg` : 'No model data yet'}
          />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <section className="rounded-lg border border-border bg-panel-alt overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Recent Spec Costs</h3>
              <p className="text-xs text-muted mt-1">Last 20 specs, newest first, with cost computed consistently across engines/providers.</p>
            </div>
            {recentSpecs.length === 0 ? (
              <div className="p-4 text-sm text-muted">No spec cost data yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-4 py-2 font-medium">Spec</th>
                    <th className="px-4 py-2 text-right font-medium">Stories</th>
                    <th className="px-4 py-2 text-right font-medium">Tokens</th>
                    <th className="px-4 py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recentSpecs.map((row) => (
                    <tr key={row.group_key} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2 font-mono text-xs" title={row.group_key}>{row.group_key}</td>
                      <td className="px-4 py-2 text-right text-muted">{row.story_count}</td>
                      <td className="px-4 py-2 text-right text-muted">{formatTokens(row.total_input_tokens + row.total_output_tokens)}</td>
                      <td className="px-4 py-2 text-right">{formatCost(row.total_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-lg border border-border bg-panel-alt overflow-hidden">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Model Snapshot</h3>
              <p className="text-xs text-muted mt-1">Most-used models over the last 30 days.</p>
            </div>
            {modelSnapshot.length === 0 ? (
              <div className="p-4 text-sm text-muted">No model performance data yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th className="px-4 py-2 font-medium">Model</th>
                    <th className="px-4 py-2 text-right font-medium">Stories</th>
                    <th className="px-4 py-2 text-right font-medium">Pass</th>
                    <th className="px-4 py-2 text-right font-medium">Avg Cost</th>
                    <th className="px-4 py-2 text-right font-medium">Avg Time</th>
                  </tr>
                </thead>
                <tbody>
                  {modelSnapshot.map((row) => (
                    <tr key={row.model} className="border-b border-border/60 last:border-0">
                      <td className="px-4 py-2 font-mono text-xs" title={row.model}>{row.model}</td>
                      <td className="px-4 py-2 text-right text-muted">{row.totalStories}</td>
                      <td className="px-4 py-2 text-right">{Math.round(row.passRate * 100)}%</td>
                      <td className="px-4 py-2 text-right">{formatCost(row.avgCostUsd)}</td>
                      <td className="px-4 py-2 text-right text-muted">{formatDuration(row.avgElapsedSeconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <section className="rounded-lg border border-border bg-panel-alt p-4">
          <div className="mb-3 flex items-center gap-2">
            <Activity size={16} className="text-accent" />
            <h3 className="text-sm font-semibold">Delivery Snapshot</h3>
          </div>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 text-sm">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Passed</div>
              <div className="mt-1 text-xl font-semibold">{completionSummary.passed}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Failed</div>
              <div className="mt-1 text-xl font-semibold">{completionSummary.failed}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Skipped</div>
              <div className="mt-1 text-xl font-semibold">{completionSummary.skipped}</div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted">Latest rolling avg/week</div>
              <div className="mt-1 text-xl font-semibold">{completionSummary.latestRolling.toFixed(1)}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
