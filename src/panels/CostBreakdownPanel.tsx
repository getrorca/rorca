/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { DollarSign, Calendar, ArrowDownUp, Loader2, Settings, Plus, Trash2, Save, X } from 'lucide-react';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { apiFetch } from '../lib/apiFetch';
import { HelpTooltip } from '../components/HelpTooltip';
import ErrorBanner from '../components/ErrorBanner';

/* ─── Types ───────────────────────────────────────────────────────── */

interface CostRow {
  group_key: string;
  total_input_tokens: number;
  total_output_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  story_count: number;
}

interface PeriodCostRow {
  period: string;
  total_input_tokens: number;
  total_output_tokens: number;
  input_cost_usd: number;
  output_cost_usd: number;
  total_cost_usd: number;
  story_count: number;
}

interface CostTotals {
  total_input_tokens: number;
  total_output_tokens: number;
  total_input_cost_usd: number;
  total_output_cost_usd: number;
  total_cost_usd: number;
  total_stories: number;
}

interface CostResponse {
  groupBy: string;
  breakdown?: CostRow[];
  periods?: PeriodCostRow[];
  totals?: CostTotals;
  dateRange: { from: string; to: string };
}

interface PricingEntry {
  model_id: string;
  provider: string;
  input_cost_per_1m_tokens: number;
  output_cost_per_1m_tokens: number;
  effective_date: string;
  updated_at: string;
}

type GroupBy = 'spec' | 'run' | 'model' | 'period';
type DateRange = '7d' | '30d' | '90d' | 'all';
type Tab = 'costs' | 'pricing';

/* ─── Helpers ─────────────────────────────────────────────────────── */

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

function dateRangeToISO(range: DateRange): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString();
  if (range === 'all') return { from: '2020-01-01T00:00:00Z', to };
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  return { from, to };
}

/* ─── Component ───────────────────────────────────────────────────── */

export default function CostBreakdownPanel() {
  const { workspaceId } = useWorkspace();
  const [tab, setTab] = useState<Tab>('costs');
  const [data, setData] = useState<CostResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('spec');
  const [dateRange, setDateRange] = useState<DateRange>('30d');

  // Pricing state
  const [pricing, setPricing] = useState<PricingEntry[]>([]);
  const [pricingLoading, setPricingLoading] = useState(false);
  const [editingModel, setEditingModel] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ provider: '', input: '', output: '', effective_date: '' });
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({ model_id: '', provider: 'anthropic', input: '', output: '' });

  const fetchCosts = useCallback(async () => {
    if (!workspaceId) return;
    setError(null);
    try {
      const { from, to } = dateRangeToISO(dateRange);
      const params = new URLSearchParams({
        group_by: groupBy,
        workspace_id: workspaceId,
        from,
        to,
      });
      const result = await apiFetch<CostResponse>(`/api/analytics/costs?${params}`);
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load cost data';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, groupBy, dateRange]);

  const fetchPricing = useCallback(async () => {
    setPricingLoading(true);
    try {
      const result = await apiFetch<{ pricing: PricingEntry[] }>('/api/analytics/pricing');
      setPricing(result.pricing);
    } catch (err) {
      console.error('[CostBreakdown] pricing fetch error:', err);
    } finally {
      setPricingLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'costs') {
      setLoading(true);
      fetchCosts();
    } else {
      fetchPricing();
    }
  }, [tab, fetchCosts, fetchPricing]);

  const handleSavePricing = async (modelId: string) => {
    try {
      await apiFetch(`/api/analytics/pricing/${encodeURIComponent(modelId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: editForm.provider,
          input_cost_per_1m_tokens: parseFloat(editForm.input),
          output_cost_per_1m_tokens: parseFloat(editForm.output),
          effective_date: editForm.effective_date || undefined,
        }),
      });
      setEditingModel(null);
      fetchPricing();
    } catch (err) {
      console.error('[CostBreakdown] save pricing error:', err);
    }
  };

  const handleAddPricing = async () => {
    if (!addForm.model_id || !addForm.input || !addForm.output) return;
    try {
      await apiFetch(`/api/analytics/pricing/${encodeURIComponent(addForm.model_id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: addForm.provider,
          input_cost_per_1m_tokens: parseFloat(addForm.input),
          output_cost_per_1m_tokens: parseFloat(addForm.output),
        }),
      });
      setShowAddForm(false);
      setAddForm({ model_id: '', provider: 'anthropic', input: '', output: '' });
      fetchPricing();
    } catch (err) {
      console.error('[CostBreakdown] add pricing error:', err);
    }
  };

  const handleDeletePricing = async (modelId: string) => {
    try {
      await apiFetch(`/api/analytics/pricing/${encodeURIComponent(modelId)}`, {
        method: 'DELETE',
      });
      fetchPricing();
    } catch (err) {
      console.error('[CostBreakdown] delete pricing error:', err);
    }
  };

  /* ─── Render ──────────────────────────────────────────────────── */

  return (
    <div className="flex flex-col h-full overflow-hidden" role="main" aria-label="Cost Breakdown analytics panel">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <DollarSign size={20} className="text-accent" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Cost Breakdown</h2>
          <HelpTooltip helpKey="cost-breakdown" />
        </div>

        <div className="flex items-center gap-2">
          {/* Tab toggle */}
          <div className="flex items-center gap-1 bg-panel-alt rounded-md p-0.5" role="tablist" aria-label="Cost panel tabs">
            <button
              role="tab"
              aria-selected={tab === 'costs'}
              onClick={() => setTab('costs')}
              className={`px-3 py-1 text-xs rounded transition-colors ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                tab === 'costs' ? 'bg-accent text-white' : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              Costs
            </button>
            <button
              role="tab"
              aria-selected={tab === 'pricing'}
              onClick={() => setTab('pricing')}
              className={`px-3 py-1 text-xs rounded transition-colors flex items-center gap-1 ring-offset-1 focus:outline-none focus:ring-2 focus:ring-accent/50 ${
                tab === 'pricing' ? 'bg-accent text-white' : 'text-muted hover:text-[var(--text)]'
              }`}
            >
              <Settings size={12} aria-hidden="true" />
              Pricing
            </button>
          </div>

          {tab === 'costs' && (
            <>
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
                {(['spec', 'run', 'model', 'period'] as GroupBy[]).map(g => (
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
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6" aria-live="polite" aria-busy={loading}>
        {error && tab === 'costs' && <ErrorBanner message={error} onRetry={fetchCosts} onDismiss={() => setError(null)} />}
        {tab === 'costs' ? (
          <CostsTab data={data} loading={loading} groupBy={groupBy} />
        ) : (
          <PricingTab
            pricing={pricing}
            loading={pricingLoading}
            editingModel={editingModel}
            editForm={editForm}
            showAddForm={showAddForm}
            addForm={addForm}
            onStartEdit={(p) => {
              setEditingModel(p.model_id);
              setEditForm({
                provider: p.provider,
                input: String(p.input_cost_per_1m_tokens),
                output: String(p.output_cost_per_1m_tokens),
                effective_date: p.effective_date?.split('T')[0] || '',
              });
            }}
            onCancelEdit={() => setEditingModel(null)}
            onSaveEdit={handleSavePricing}
            onDelete={handleDeletePricing}
            onEditFormChange={setEditForm}
            onShowAddForm={setShowAddForm}
            onAddFormChange={setAddForm}
            onAdd={handleAddPricing}
          />
        )}
      </div>
    </div>
  );
}

/* ─── Costs Tab ──────────────────────────────────────────────────── */

function CostsTab({ data, loading, groupBy }: { data: CostResponse | null; loading: boolean; groupBy: GroupBy }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted" size={28} />
      </div>
    );
  }

  const isEmpty = groupBy === 'period'
    ? !data?.periods?.length
    : !data?.breakdown?.length;

  if (!data || isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-64">
        <div className="flex flex-col items-center max-w-[400px] text-center">
          <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
            <DollarSign size={28} className="text-accent" />
          </div>
          <h3 className="text-base font-semibold text-[var(--text)] mb-1.5">No cost data yet</h3>
          <p className="text-sm text-muted leading-relaxed">Cost breakdowns appear after your first pipeline run. Run a spec to get started.</p>
        </div>
      </div>
    );
  }

  if (groupBy === 'period' && data.periods) {
    return <PeriodView periods={data.periods} />;
  }

  const breakdown = data.breakdown || [];
  const totals = data.totals;

  return (
    <>
      {/* Summary Cards */}
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <SummaryCard label="Total Cost" value={formatCost(totals.total_cost_usd)} sub={`${totals.total_stories} stories`} helpKey="cost-breakdown" />
          <SummaryCard label="Input Cost" value={formatCost(totals.total_input_cost_usd)} sub={formatTokens(totals.total_input_tokens) + ' tokens'} helpKey="cost-input-tokens" />
          <SummaryCard label="Output Cost" value={formatCost(totals.total_output_cost_usd)} sub={formatTokens(totals.total_output_tokens) + ' tokens'} helpKey="cost-output-tokens" />
          <SummaryCard
            label="Avg Cost / Story"
            value={totals.total_stories > 0 ? formatCost(totals.total_cost_usd / totals.total_stories) : '$0.00'}
            sub="per completion"
          />
        </div>
      )}

      {/* Bar chart */}
      <div className="bg-panel-alt rounded-lg p-4">
        <h3 className="text-sm font-medium text-muted mb-3 capitalize">
          Cost by {groupBy}
        </h3>
        <div className="w-full min-h-[200px]" aria-label={`Bar chart showing cost breakdown by ${groupBy}`} role="img">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={breakdown.slice(0, 15)} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
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
                formatter={((value: string | number | undefined, name: string | number | undefined) => [
                  formatCost(typeof value === 'number' ? value : Number(value ?? 0)),
                  name === 'input_cost_usd' ? 'Input Cost' : 'Output Cost',
                ]) as any}
              />
              <Legend formatter={(value: string) => value === 'input_cost_usd' ? 'Input Cost' : 'Output Cost'} />
              <Bar dataKey="input_cost_usd" fill="#6366f1" stackId="cost" radius={[0, 0, 0, 0]} />
              <Bar dataKey="output_cost_usd" fill="#22d3ee" stackId="cost" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Screen-reader table alternative */}
        <table className="sr-only" aria-label={`Cost by ${groupBy} data table`}>
          <thead>
            <tr>
              <th scope="col" role="columnheader">{groupBy}</th>
              <th scope="col" role="columnheader">Input Cost</th>
              <th scope="col" role="columnheader">Output Cost</th>
              <th scope="col" role="columnheader">Total Cost</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.slice(0, 15).map((row) => (
              <tr key={row.group_key}>
                <td>{row.group_key}</td>
                <td>{formatCost(row.input_cost_usd)}</td>
                <td>{formatCost(row.output_cost_usd)}</td>
                <td>{formatCost(row.total_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Cost breakdown table */}
      <div className="bg-panel-alt rounded-lg p-4">
        <h3 className="text-sm font-medium text-muted mb-3 capitalize">
          Detailed Cost Breakdown by {groupBy}
        </h3>
        <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table" aria-label={`Detailed cost breakdown by ${groupBy}`}>
          <thead>
            <tr className="text-left text-muted border-b border-border">
              <th className="pb-2 font-medium capitalize" role="columnheader">{groupBy}</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Input Cost</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Output Cost</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Total Cost</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Stories</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Input Tokens</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Output Tokens</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.map((row) => (
              <tr key={row.group_key} className="border-b border-border/50 last:border-0">
                <td className="py-2">
                  <span className="truncate max-w-[200px] block" title={row.group_key}>
                    {row.group_key}
                  </span>
                </td>
                <td className="py-2 text-right text-muted">{formatCost(row.input_cost_usd)}</td>
                <td className="py-2 text-right text-muted">{formatCost(row.output_cost_usd)}</td>
                <td className="py-2 text-right font-medium">{formatCost(row.total_cost_usd)}</td>
                <td className="py-2 text-right text-muted">{row.story_count}</td>
                <td className="py-2 text-right text-muted">{formatTokens(row.total_input_tokens)}</td>
                <td className="py-2 text-right text-muted">{formatTokens(row.total_output_tokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}

/* ─── Period View ────────────────────────────────────────────────── */

function PeriodView({ periods }: { periods: PeriodCostRow[] }) {
  const totalCost = periods.reduce((s, p) => s + p.total_cost_usd, 0);
  const totalStories = periods.reduce((s, p) => s + p.story_count, 0);

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard label="Total Cost" value={formatCost(totalCost)} sub={`${periods.length} periods`} />
        <SummaryCard label="Total Stories" value={String(totalStories)} sub="across all periods" />
        <SummaryCard
          label="Avg / Period"
          value={periods.length > 0 ? formatCost(totalCost / periods.length) : '$0.00'}
          sub="per week"
        />
      </div>

      <div className="bg-panel-alt rounded-lg p-4">
        <h3 className="text-sm font-medium text-muted mb-3">Cost by Period (Weekly)</h3>
        <div role="img" aria-label="Bar chart showing weekly cost breakdown by input and output tokens">
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={periods} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis
                dataKey="period"
                tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
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
                formatter={((value: string | number | undefined, name: string | number | undefined) => [
                  formatCost(typeof value === 'number' ? value : Number(value ?? 0)),
                  name === 'input_cost_usd' ? 'Input Cost' : 'Output Cost',
                ]) as any}
              />
              <Legend formatter={(value: string) => value === 'input_cost_usd' ? 'Input Cost' : 'Output Cost'} />
              <Bar dataKey="input_cost_usd" fill="#6366f1" stackId="cost" />
              <Bar dataKey="output_cost_usd" fill="#22d3ee" stackId="cost" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Screen-reader table alternative */}
        <table className="sr-only" aria-label="Weekly cost data table">
          <thead>
            <tr>
              <th scope="col" role="columnheader">Period</th>
              <th scope="col" role="columnheader">Input Cost</th>
              <th scope="col" role="columnheader">Output Cost</th>
              <th scope="col" role="columnheader">Total</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.period}>
                <td>{p.period}</td>
                <td>{formatCost(p.input_cost_usd)}</td>
                <td>{formatCost(p.output_cost_usd)}</td>
                <td>{formatCost(p.total_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-panel-alt rounded-lg p-4">
        <h3 className="text-sm font-medium text-muted mb-3">Period Breakdown</h3>
        <div className="overflow-x-auto">
        <table className="w-full text-sm" role="table" aria-label="Period cost breakdown table">
          <thead>
            <tr className="text-left text-muted border-b border-border">
              <th className="pb-2 font-medium" role="columnheader">Period</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Input Cost</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Output Cost</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Total</th>
              <th className="pb-2 font-medium text-right" role="columnheader">Stories</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.period} className="border-b border-border/50 last:border-0">
                <td className="py-2 font-mono text-xs">{p.period}</td>
                <td className="py-2 text-right text-muted">{formatCost(p.input_cost_usd)}</td>
                <td className="py-2 text-right text-muted">{formatCost(p.output_cost_usd)}</td>
                <td className="py-2 text-right font-medium">{formatCost(p.total_cost_usd)}</td>
                <td className="py-2 text-right text-muted">{p.story_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}

/* ─── Pricing Tab ────────────────────────────────────────────────── */

interface PricingTabProps {
  pricing: PricingEntry[];
  loading: boolean;
  editingModel: string | null;
  editForm: { provider: string; input: string; output: string; effective_date: string };
  showAddForm: boolean;
  addForm: { model_id: string; provider: string; input: string; output: string };
  onStartEdit: (p: PricingEntry) => void;
  onCancelEdit: () => void;
  onSaveEdit: (modelId: string) => void;
  onDelete: (modelId: string) => void;
  onEditFormChange: (form: { provider: string; input: string; output: string; effective_date: string }) => void;
  onShowAddForm: (show: boolean) => void;
  onAddFormChange: (form: { model_id: string; provider: string; input: string; output: string }) => void;
  onAdd: () => void;
}

function PricingTab({
  pricing, loading, editingModel, editForm, showAddForm, addForm,
  onStartEdit, onCancelEdit, onSaveEdit, onDelete,
  onEditFormChange, onShowAddForm, onAddFormChange, onAdd,
}: PricingTabProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-muted" size={28} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Model Pricing</h3>
          <p className="text-xs text-muted mt-0.5">
            Update pricing when providers change rates. Costs are per 1M tokens.
          </p>
        </div>
        <button
          onClick={() => onShowAddForm(!showAddForm)}
          className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent text-white hover:opacity-90 transition-opacity"
        >
          <Plus size={14} />
          Add Model
        </button>
      </div>

      {/* Add form */}
      {showAddForm && (
        <div className="bg-panel-alt rounded-lg p-4 border border-accent/30">
          <h4 className="text-sm font-medium mb-3">Add New Model Pricing</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted block mb-1">Model ID</label>
              <input
                type="text"
                value={addForm.model_id}
                onChange={e => onAddFormChange({ ...addForm, model_id: e.target.value })}
                placeholder="claude-sonnet-4-5-20250929"
                className="w-full px-2 py-1.5 text-xs bg-bg border border-border rounded focus:border-accent outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Provider</label>
              <input
                type="text"
                value={addForm.provider}
                onChange={e => onAddFormChange({ ...addForm, provider: e.target.value })}
                placeholder="anthropic"
                className="w-full px-2 py-1.5 text-xs bg-bg border border-border rounded focus:border-accent outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Input ($/1M tokens)</label>
              <input
                type="number"
                step="0.01"
                value={addForm.input}
                onChange={e => onAddFormChange({ ...addForm, input: e.target.value })}
                placeholder="3.00"
                className="w-full px-2 py-1.5 text-xs bg-bg border border-border rounded focus:border-accent outline-none"
              />
            </div>
            <div>
              <label className="text-xs text-muted block mb-1">Output ($/1M tokens)</label>
              <input
                type="number"
                step="0.01"
                value={addForm.output}
                onChange={e => onAddFormChange({ ...addForm, output: e.target.value })}
                placeholder="15.00"
                className="w-full px-2 py-1.5 text-xs bg-bg border border-border rounded focus:border-accent outline-none"
              />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={onAdd}
              disabled={!addForm.model_id || !addForm.input || !addForm.output}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              <Save size={12} />
              Save
            </button>
            <button
              onClick={() => onShowAddForm(false)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-panel border border-border text-muted hover:text-[var(--text)] transition-colors"
            >
              <X size={12} />
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pricing table */}
      <div className="bg-panel-alt rounded-lg p-4">
        <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b border-border">
              <th className="pb-2 font-medium">Model</th>
              <th className="pb-2 font-medium">Provider</th>
              <th className="pb-2 font-medium text-right">Input ($/1M)</th>
              <th className="pb-2 font-medium text-right">Output ($/1M)</th>
              <th className="pb-2 font-medium text-right">Effective Date</th>
              <th className="pb-2 font-medium text-right w-24">Actions</th>
            </tr>
          </thead>
          <tbody>
            {pricing.map((p) => (
              <tr key={p.model_id} className="border-b border-border/50 last:border-0">
                {editingModel === p.model_id ? (
                  <>
                    <td className="py-2 font-mono text-xs">{p.model_id}</td>
                    <td className="py-2">
                      <input
                        type="text"
                        value={editForm.provider}
                        onChange={e => onEditFormChange({ ...editForm, provider: e.target.value })}
                        className="w-full px-2 py-1 text-xs bg-bg border border-border rounded focus:border-accent outline-none"
                      />
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={editForm.input}
                        onChange={e => onEditFormChange({ ...editForm, input: e.target.value })}
                        className="w-20 px-2 py-1 text-xs bg-bg border border-border rounded focus:border-accent outline-none text-right ml-auto block"
                      />
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="number"
                        step="0.01"
                        value={editForm.output}
                        onChange={e => onEditFormChange({ ...editForm, output: e.target.value })}
                        className="w-20 px-2 py-1 text-xs bg-bg border border-border rounded focus:border-accent outline-none text-right ml-auto block"
                      />
                    </td>
                    <td className="py-2 text-right">
                      <input
                        type="date"
                        value={editForm.effective_date}
                        onChange={e => onEditFormChange({ ...editForm, effective_date: e.target.value })}
                        className="w-32 px-2 py-1 text-xs bg-bg border border-border rounded focus:border-accent outline-none text-right ml-auto block"
                      />
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onSaveEdit(p.model_id)}
                          className="p-1 text-accent hover:bg-accent/10 rounded transition-colors"
                          title="Save"
                        >
                          <Save size={14} />
                        </button>
                        <button
                          onClick={onCancelEdit}
                          className="p-1 text-muted hover:text-[var(--text)] hover:bg-bg rounded transition-colors"
                          title="Cancel"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="py-2 font-mono text-xs">{p.model_id}</td>
                    <td className="py-2 text-muted">{p.provider}</td>
                    <td className="py-2 text-right font-medium">${p.input_cost_per_1m_tokens.toFixed(2)}</td>
                    <td className="py-2 text-right font-medium">${p.output_cost_per_1m_tokens.toFixed(2)}</td>
                    <td className="py-2 text-right text-muted text-xs">
                      {p.effective_date ? new Date(p.effective_date).toLocaleDateString() : '-'}
                    </td>
                    <td className="py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onStartEdit(p)}
                          className="p-1 text-muted hover:text-accent hover:bg-accent/10 rounded transition-colors"
                          title="Edit pricing"
                        >
                          <Settings size={14} />
                        </button>
                        <button
                          onClick={() => onDelete(p.model_id)}
                          className="p-1 text-muted hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {pricing.length === 0 && (
              <tr>
                <td colSpan={6} className="py-8 text-center text-muted text-sm">
                  No pricing configured. Add a model to get started.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────────── */

function SummaryCard({ label, value, sub, helpKey }: { label: string; value: string; sub: string; helpKey?: string }) {
  return (
    <div className="bg-panel-alt rounded-lg p-4 flex flex-col gap-1" aria-label={`${label}: ${value}`}>
      <span className="text-xs text-muted inline-flex items-center gap-1">
        {label}
        {helpKey && <HelpTooltip helpKey={helpKey} size={10} />}
      </span>
      <span className="text-2xl font-bold" aria-hidden="true">{value}</span>
      <span className="text-xs text-muted">{sub}</span>
    </div>
  );
}
