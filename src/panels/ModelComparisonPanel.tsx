/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Zap, ArrowUpDown, Calendar, Loader2, AlertTriangle, Check } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';

/* ─── Types ───────────────────────────────────────────────── */

interface ModelMetrics {
  model: string;
  totalStories: number;
  passedStories: number;
  failedStories: number;
  passRate: number;
  avgCostUsd: number;
  totalCostUsd: number;
  avgElapsedSeconds: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  insufficientData: boolean;
}

interface ModelsResponse {
  models: ModelMetrics[];
  dateRange: { from: string; to: string };
}

type SortKey = 'model' | 'totalStories' | 'passRate' | 'avgCostUsd' | 'avgElapsedSeconds';
type SortDir = 'asc' | 'desc';
type DateRange = '7d' | '30d' | '90d' | 'all';

/* ─── Helpers ─────────────────────────────────────────────── */

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function dateRangeToISO(range: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (range === 'all') return { from: '2020-01-01T00:00:00Z', to };
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/* ─── Component ───────────────────────────────────────────── */

export default function ModelComparisonPanel() {
  const { workspaceId } = useWorkspace();
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRange>('30d');
  const [sortKey, setSortKey] = useState<SortKey>('totalStories');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [settingModel, setSettingModel] = useState<string | null>(null);
  const [currentPreferred, setCurrentPreferred] = useState<string | null>(null);

  const fetchData = useCallback(() => {
    setLoading(true);
    const { from, to } = dateRangeToISO(dateRange);
    const params = new URLSearchParams({ from, to });
    if (workspaceId) params.set('workspace_id', workspaceId);

    Promise.all([
      apiFetch<ModelsResponse>(`/api/analytics/models?${params}`),
      workspaceId
        ? apiFetch<{ preferredModel: string | null }>(`/api/direction?layer=3&workspaceId=${workspaceId}`)
        : Promise.resolve({ preferredModel: null }),
    ]).then(([models, direction]) => {
      setData(models);
      setCurrentPreferred(direction.preferredModel);
      setLoading(false);
    }).catch(err => {
      console.error('[ModelComparison] Fetch error:', err);
      setLoading(false);
    });
  }, [dateRange, workspaceId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSetModel = useCallback(async (model: string) => {
    if (!workspaceId) return;
    setSettingModel(model);
    try {
      // Fetch current L3 contentYaml so we don't clobber it
      const l3 = await apiFetch<{ contentYaml: string; preferredModel: string | null }>(
        `/api/direction?layer=3&workspaceId=${workspaceId}`
      );
      await apiFetch('/api/direction', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer: 3,
          workspaceId,
          contentYaml: l3.contentYaml || 'preferred_model: ' + model,
          preferredModel: model,
        }),
      });
      setCurrentPreferred(model);
    } catch (err) {
      console.error('[ModelComparison] Set preferred model error:', err);
    } finally {
      setSettingModel(null);
    }
  }, [workspaceId]);

  const sorted = useMemo(() => {
    if (!data?.models) return [];
    return [...data.models].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string' && typeof bv === 'string') {
        return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = av as number;
      const bn = bv as number;
      return sortDir === 'asc' ? an - bn : bn - an;
    });
  }, [data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  /* ─── Render ───────────────────────────────────────────── */

  return (
    <div className="h-full flex flex-col overflow-hidden" role="main" aria-label="Model Comparison analytics panel">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-accent" aria-hidden="true" />
          <h2 className="text-base font-semibold">Model Comparison</h2>
          {data && (
            <span className="text-xs text-muted ml-2" aria-live="polite">
              {data.models.length} model{data.models.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2" role="group" aria-label="Date range filter">
          <Calendar size={14} className="text-muted" aria-hidden="true" />
          {(['7d', '30d', '90d', 'all'] as DateRange[]).map(r => (
            <button
              key={r}
              onClick={() => setDateRange(r)}
              aria-pressed={dateRange === r}
              aria-label={`Filter by ${r === 'all' ? 'all time' : `last ${r}`}`}
              className={`px-2 py-0.5 text-xs rounded transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                dateRange === r
                  ? 'bg-accent text-white'
                  : 'text-muted hover:text-[var(--text)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              {r === 'all' ? 'All' : r}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="flex items-center justify-center h-40 text-muted gap-2">
            <Loader2 size={16} className="animate-spin" aria-label="Loading model metrics" />
            Loading model metrics...
          </div>
        ) : !data?.models.length ? (
          <div className="flex flex-col items-center justify-center h-40 text-muted gap-2">
            <Zap size={24} strokeWidth={1} />
            <p className="text-sm">No model usage data found</p>
            <p className="text-xs">Run some pipeline stories to see comparison metrics here.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" role="table" aria-label="Model comparison metrics">
              <thead>
                <tr className="border-b border-border text-left">
                  <SortHeader label="Model" sortKey="model" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Stories" sortKey="totalStories" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Pass Rate" sortKey="passRate" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Avg Cost" sortKey="avgCostUsd" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <SortHeader label="Avg Time" sortKey="avgElapsedSeconds" currentKey={sortKey} dir={sortDir} onSort={toggleSort} />
                  <th className="py-2 px-3 text-xs font-medium text-muted" role="columnheader">Avg Tokens</th>
                  <th className="py-2 px-3 text-xs font-medium text-muted text-right" role="columnheader">Action</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(m => {
                  const isPreferred = currentPreferred === m.model;
                  return (
                    <tr key={m.model} className="border-b border-border/50 hover:bg-[var(--bg-hover)] transition-colors">
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <code className="text-xs font-mono">{m.model}</code>
                          {isPreferred && (
                            <span className="px-1.5 py-0.5 text-[10px] rounded bg-accent/20 text-accent font-medium">
                              preferred
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums">{m.totalStories}</td>
                      {m.insufficientData ? (
                        <td className="py-2.5 px-3" colSpan={3}>
                          <span className="inline-flex items-center gap-1 text-xs text-amber-400">
                            <AlertTriangle size={12} />
                            Insufficient data (need 5+ stories)
                          </span>
                        </td>
                      ) : (
                        <>
                          <td className="py-2.5 px-3 text-right tabular-nums">
                            <span className={m.passRate >= 0.8 ? 'text-green-400' : m.passRate >= 0.5 ? 'text-amber-400' : 'text-red-400'}>
                              {(m.passRate * 100).toFixed(0)}%
                            </span>
                            <span className="text-muted text-xs ml-1">
                              ({m.passedStories}/{m.totalStories})
                            </span>
                          </td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{formatCost(m.avgCostUsd)}</td>
                          <td className="py-2.5 px-3 text-right tabular-nums">{formatDuration(m.avgElapsedSeconds)}</td>
                        </>
                      )}
                      {!m.insufficientData && (
                        <td className="py-2.5 px-3 text-right tabular-nums text-muted text-xs">
                          {formatTokens(m.avgInputTokens)} in / {formatTokens(m.avgOutputTokens)} out
                        </td>
                      )}
                      {m.insufficientData && <td />}
                      <td className="py-2.5 px-3 text-right">
                        {isPreferred ? (
                          <span className="inline-flex items-center gap-1 text-xs text-accent">
                            <Check size={12} />
                            Active
                          </span>
                        ) : (
                          <button
                            onClick={() => handleSetModel(m.model)}
                            disabled={settingModel !== null}
                            className="px-2 py-1 text-xs rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors disabled:opacity-50"
                          >
                            {settingModel === m.model ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              'Use this model'
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Summary cards */}
            {sorted.filter(m => !m.insufficientData).length > 1 && (
              <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
                <SummaryCard
                  label="Best Pass Rate"
                  model={sorted.filter(m => !m.insufficientData).sort((a, b) => b.passRate - a.passRate)[0]}
                  metric={m => `${(m.passRate * 100).toFixed(0)}%`}
                />
                <SummaryCard
                  label="Cheapest (Avg)"
                  model={sorted.filter(m => !m.insufficientData).sort((a, b) => a.avgCostUsd - b.avgCostUsd)[0]}
                  metric={m => formatCost(m.avgCostUsd)}
                />
                <SummaryCard
                  label="Fastest (Avg)"
                  model={sorted.filter(m => !m.insufficientData).sort((a, b) => a.avgElapsedSeconds - b.avgElapsedSeconds)[0]}
                  metric={m => formatDuration(m.avgElapsedSeconds)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────── */

function SortHeader({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const isActive = currentKey === sortKey;
  return (
    <th
      role="columnheader"
      scope="col"
      className="py-2 px-3 text-xs font-medium text-muted cursor-pointer hover:text-[var(--text)] select-none"
      onClick={() => onSort(sortKey)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(sortKey); } }}
      tabIndex={0}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      aria-label={`Sort by ${label}${isActive ? `, currently ${dir === 'asc' ? 'ascending' : 'descending'}` : ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <ArrowUpDown size={10} className={isActive ? 'text-accent' : 'opacity-30'} aria-hidden="true" />
        {isActive && <span className="text-[9px] text-accent" aria-hidden="true">{dir === 'asc' ? '\u25B2' : '\u25BC'}</span>}
      </span>
    </th>
  );
}

function SummaryCard({
  label,
  model,
  metric,
}: {
  label: string;
  model: ModelMetrics | undefined;
  metric: (m: ModelMetrics) => string;
}) {
  if (!model) return null;
  const metricValue = metric(model);
  return (
    <div className="p-3 rounded border border-border bg-panel" aria-label={`${label}: ${model.model}, ${metricValue}`}>
      <p className="text-xs text-muted mb-1">{label}</p>
      <code className="text-sm font-mono">{model.model}</code>
      <p className="text-lg font-semibold mt-1" aria-hidden="true">{metricValue}</p>
    </div>
  );
}
