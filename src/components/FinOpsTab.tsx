/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, Download, Info, AlertTriangle } from 'lucide-react';
import { apiFetch, BASE_URL } from '../lib/apiFetch';

// ─── Types ──────────────────────────────────────────────────────────────────

// Mirrors backend BillingMode (finops-types.ts). Each story/provider row carries
// its own billing mode so mixed-provider runs render truthful per-row badges.
type BillingMode = 'metered_api' | 'subscription' | 'managed' | 'free_local' | 'unknown';

interface PerStory {
  storyId: string;
  model: string;
  tier: string;
  billingMode?: BillingMode;
  inputTokens: number;
  outputTokens: number;
  meteredCost?: number;
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
  // `cost` is the blended effective cost (backward-compat). The explicit
  // metered/allocated/blended fields are the canonical accounting surface.
  cost: number | null;
  meteredCostUsd?: number;
  allocatedSubscriptionCostUsd?: number;
  blendedEffectiveCostUsd?: number;
}

// FIN-004 accounting block — separates marginal API spend, allocated
// subscription cost, and blended effective cost rather than one ambiguous total.
interface AccountingBlock {
  meteredCostUsd: number;
  allocatedSubscriptionCostUsd: number;
  blendedEffectiveCostUsd: number;
  subscriptionUsage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    recordCount: number;
  };
  byMode: Array<{
    mode: BillingMode;
    recordCount: number;
    meteredCostUsd: number;
    allocatedCostUsd: number;
    blendedCostUsd: number;
  }>;
  coverage: {
    totalRecords: number;
    profileClassifiedRecords: number;
    pricedRecords: number;
    unpricedRecords: number;
    pricingCoverage: number | null;
    allocationModes: string[];
    hasAllocatedCost: boolean;
    hasBlendedCost: boolean;
  };
}

// Provenance labels so the UI can tell a truthful story about where the numbers
// come from: metered, allocated, blended, or estimated/missing.
interface Provenance {
  billingMode: BillingMode;
  isSubscription: boolean;
  hasMeteredSpend: boolean;
  hasAllocatedCost: boolean;
  hasBlendedCost: boolean;
  pricingCoverage: number | null;
  unpricedRecords: number;
  profileClassifiedRecords: number;
  allocationModes: string[];
}

interface FinOpsData {
  runId: number;
  agentType: string;
  agentModel?: string;
  usageAvailable?: boolean;
  isSubscription: boolean;
  billingMode?: BillingMode;
  accounting?: AccountingBlock;
  provenance?: Provenance;
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

// Human-readable labels and badge styles for each billing mode.
const BILLING_LABELS: Record<BillingMode, string> = {
  metered_api: 'Metered',
  subscription: 'Subscription',
  managed: 'Managed',
  free_local: 'Local / Free',
  unknown: 'Unknown',
};

const BILLING_BADGE: Record<BillingMode, string> = {
  metered_api: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  subscription: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
  managed: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  free_local: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  unknown: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

function billingLabel(mode: BillingMode | undefined): string {
  return mode ? (BILLING_LABELS[mode] ?? BILLING_LABELS.unknown) : BILLING_LABELS.unknown;
}

function billingBadgeClass(mode: BillingMode | undefined): string {
  return mode ? (BILLING_BADGE[mode] ?? BILLING_BADGE.unknown) : BILLING_BADGE.unknown;
}

function BillingBadge({ mode }: { mode: BillingMode | undefined }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${billingBadgeClass(mode)}`}>
      {billingLabel(mode)}
    </span>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

interface FinOpsTabProps {
  runId: number;
  /**
   * When true, the run is still executing. The tab polls so metered usage that
   * arrives via WAL events is reflected live without losing the rows already on
   * screen. Defaults to false (completed runs fetch once).
   */
  isActive?: boolean;
}

const LIVE_POLL_MS = 5000;

export default function FinOpsTab({ runId, isActive = false }: FinOpsTabProps) {
  const [data, setData] = useState<FinOpsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedStories, setExpandedStories] = useState(false);
  // Track whether the first load has completed so background polls never flip the
  // view back to the loading/empty state while usage is still arriving.
  const loadedRef = useRef(false);

  const fetchData = useCallback(async (opts?: { background?: boolean }) => {
    const background = opts?.background ?? false;
    if (!background) setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<FinOpsData>(`/api/analytics/finops/run/${runId}`, { silent: background });
      setData(result);
      loadedRef.current = true;
    } catch (err: any) {
      // A failed background refresh must not clobber data already on screen.
      if (!background) setError(err.message || 'Failed to load FinOps data');
    } finally {
      if (!background) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    loadedRef.current = false;
    fetchData();
  }, [fetchData]);

  // Live update: while the run is active, refresh in the background so newly
  // metered stories and totals appear without remounting or a loading flash.
  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => {
      if (loadedRef.current) fetchData({ background: true });
    }, LIVE_POLL_MS);
    return () => clearInterval(id);
  }, [isActive, fetchData]);

  // Sort per-story by cost descending
  const sortedStories = useMemo(() => {
    if (!data) return [];
    return [...data.perStory].sort((a, b) => b.actualCost - a.actualCost);
  }, [data]);

  // Derive the accounting-mode split. Prefer the explicit FIN-004 accounting
  // block; fall back to the totals fields, then to the legacy blended `cost`.
  const accountingView = useMemo(() => {
    if (!data) return null;
    const metered = data.accounting?.meteredCostUsd ?? data.totals.meteredCostUsd ?? null;
    const allocated = data.accounting?.allocatedSubscriptionCostUsd ?? data.totals.allocatedSubscriptionCostUsd ?? null;
    const blended = data.accounting?.blendedEffectiveCostUsd
      ?? data.totals.blendedEffectiveCostUsd
      ?? data.totals.cost
      ?? null;
    const hasAllocated = (allocated ?? 0) > 0 || data.provenance?.hasAllocatedCost === true;
    // Show the metered/allocated/blended split only when allocation is in play;
    // pure metered runs keep the single, unambiguous cost card.
    const showSplit = hasAllocated;
    return { metered, allocated, blended, hasAllocated, showSplit };
  }, [data]);

  // Whether any per-story/per-provider row uses a different billing mode than the
  // run headline — drives whether we surface per-row billing badges.
  const isMixedBilling = useMemo(() => {
    if (!data) return false;
    const modes = new Set(data.perStory.map((s) => s.billingMode).filter(Boolean));
    return modes.size > 1;
  }, [data]);

  // Map each model to its billing mode (from per-story rows) so the Run Summary
  // table can render a billing badge per provider on mixed-billing runs.
  const modelBillingMode = useMemo(() => {
    const m = new Map<string, BillingMode>();
    if (!data) return m;
    for (const s of data.perStory) {
      if (s.billingMode && !m.has(s.model)) m.set(s.model, s.billingMode);
    }
    return m;
  }, [data]);

  // Build coverage/provenance sentences as complete strings (no mid-sentence
  // interpolation) so the notice is unambiguous and easy to assert on.
  const coverageMessages = useMemo(() => {
    const p = data?.provenance;
    if (!p) return [];
    const msgs: string[] = [];
    if (p.pricingCoverage != null && p.pricingCoverage < 1) {
      msgs.push(`Metered pricing covers ${Math.round(p.pricingCoverage * 100)}% of usage.`);
    }
    if (p.unpricedRecords > 0) {
      const plural = p.unpricedRecords === 1 ? '' : 's';
      msgs.push(`${p.unpricedRecords} record${plural} lack pricing or token history, so their cost is shown as $0 rather than estimated.`);
    }
    if (msgs.length > 0) {
      msgs.push('Costs without pricing are excluded from metered totals, not guessed.');
    }
    return msgs;
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
        <button onClick={() => fetchData()} className="text-xs text-[var(--accent)] hover:underline">Retry</button>
      </div>
    );
  }

  // Only treat the run as truly empty when there are no provider/model rows AND
  // no stories. Active runs surface provider rows before any usage arrives, so we
  // must keep them visible rather than collapsing to the empty state.
  const hasAnyRows = !!data && (data.runSummary.length > 0 || data.perStory.length > 0 || data.totals.stories > 0);
  if (!data || !hasAnyRows) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)] text-sm">
        No token usage data available for this run.
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-4 space-y-4">

        {/* Usage availability notice — provider rows render before usage arrives. */}
        {data.usageAvailable === false && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-400">
            <Info size={14} className="shrink-0" />
            <span>
              Waiting for token usage from {data.agentType}{data.agentModel ? ` (${data.agentModel})` : ''}. Provider/model rows are shown now and will update live as usage events arrive.
            </span>
          </div>
        )}

        {/* Subscription truthfulness notice — no invoice-backed per-story spend. */}
        {data.isSubscription && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-300">
            <Info size={14} className="shrink-0 mt-0.5" />
            <span>
              This run is covered by a flat subscription. Token usage below reflects what the subscription covered — there is no metered, invoice-backed per-story charge.
              {accountingView?.hasAllocated
                ? ' The allocated cost is your subscription fee spread across runs, not a marginal charge for this run.'
                : ''}
            </span>
          </div>
        )}

        {/* Coverage / provenance notice — explain estimated, allocated, or missing costs. */}
        {coverageMessages.length > 0 && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span className="space-x-1">
              {coverageMessages.map((m, i) => (
                <span key={i}>{m}</span>
              ))}
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
          {/* Cost card: a single blended card for pure-metered runs, or an explicit
              blended card when subscription allocation is mixed in below. */}
          <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">
              {accountingView?.showSplit ? 'Blended Cost' : 'Total Cost'}
            </div>
            <div className="text-lg font-mono font-medium">
              {accountingView?.blended != null ? formatCost(accountingView.blended) : '—'}
            </div>
            {accountingView?.showSplit && (
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">metered + allocated</div>
            )}
          </div>
        </div>

        {/* Accounting-mode split cards — only when subscription cost is allocated,
            so the user can distinguish marginal metered spend from allocated fees. */}
        {accountingView?.showSplit && (
          <div className="grid grid-cols-3 gap-3">
            <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Metered (API)</div>
              <div className="text-base font-mono font-medium text-amber-400">
                {accountingView.metered != null ? formatCost(accountingView.metered) : '—'}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">Marginal pay-per-token spend</div>
            </div>
            <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Allocated (Subscription)</div>
              <div className="text-base font-mono font-medium text-indigo-400">
                {accountingView.allocated != null ? formatCost(accountingView.allocated) : '—'}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">
                Subscription fee spread across runs
                {data.provenance?.allocationModes?.length ? ` (${data.provenance.allocationModes.join(', ')})` : ''}
              </div>
            </div>
            <div className="p-3 rounded-lg bg-[var(--surface)] border border-[var(--border)]">
              <div className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] mb-1">Blended Effective</div>
              <div className="text-base font-mono font-medium">
                {accountingView.blended != null ? formatCost(accountingView.blended) : '—'}
              </div>
              <div className="text-[10px] text-[var(--text-muted)] mt-0.5">What this run effectively cost</div>
            </div>
          </div>
        )}

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
                  {isMixedBilling && (
                    <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Billing</th>
                  )}
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Stories</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens In</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens Out</th>
                  <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium" title="Marginal pay-per-token spend (0 for subscription rows)">Metered Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.runSummary.map((row) => {
                  const mode = modelBillingMode.get(row.model);
                  return (
                    <tr key={row.model} className="border-b border-[var(--border)] last:border-0">
                      <td className="px-3 py-1.5">
                        <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${TIER_BG[row.tier] || 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}`}>
                          {row.tier}
                        </span>
                        <span className="ml-2 font-mono text-[var(--text-muted)]">{row.model}</span>
                      </td>
                      {isMixedBilling && (
                        <td className="px-3 py-1.5"><BillingBadge mode={mode} /></td>
                      )}
                      <td className="px-3 py-1.5 text-right font-mono">{row.stories}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(row.inputTokens)}</td>
                      <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(row.outputTokens)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {mode === 'subscription' ? <span className="text-[var(--text-muted)]">covered</span> : formatCost(row.cost)}
                      </td>
                    </tr>
                  );
                })}
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
                    {isMixedBilling && (
                      <th className="text-left px-3 py-1.5 text-[var(--text-muted)] font-medium">Billing</th>
                    )}
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens In</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Tokens Out</th>
                    <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium" title="Marginal pay-per-token spend (0 for subscription rows)">Metered Cost</th>
                    {/* Savings is a metered-vs-Opus comparison; meaningless for
                        subscription-only runs, so we hide those columns there. */}
                    {!data.isSubscription && (
                      <>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Opus Baseline</th>
                        <th className="text-right px-3 py-1.5 text-[var(--text-muted)] font-medium">Saved</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {sortedStories.map((s) => {
                    const saved = s.opusBaseline - s.actualCost;
                    const isSubRow = s.billingMode === 'subscription';
                    return (
                      <tr key={s.storyId} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-hover)] transition-colors">
                        <td className="px-3 py-1.5 font-mono">{s.storyId}</td>
                        <td className="px-3 py-1.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded border ${TIER_BG[s.tier] || 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30'}`}>
                            {s.tier}
                          </span>
                        </td>
                        {isMixedBilling && (
                          <td className="px-3 py-1.5"><BillingBadge mode={s.billingMode} /></td>
                        )}
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(s.inputTokens)}</td>
                        <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)]">{formatTokens(s.outputTokens)}</td>
                        <td className="px-3 py-1.5 text-right font-mono">
                          {isSubRow ? <span className="text-[var(--text-muted)]">covered</span> : formatCost(s.actualCost)}
                        </td>
                        {!data.isSubscription && (
                          <>
                            <td className="px-3 py-1.5 text-right font-mono text-[var(--text-muted)] line-through opacity-60">{formatCost(s.opusBaseline)}</td>
                            <td className={`px-3 py-1.5 text-right font-mono ${saved > 0 ? 'text-emerald-400' : saved < 0 ? 'text-red-400' : 'text-[var(--text-muted)]'}`}>
                              {saved > 0 ? '+' : ''}{formatCost(saved)}
                            </td>
                          </>
                        )}
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
