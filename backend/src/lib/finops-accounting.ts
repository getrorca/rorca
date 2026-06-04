/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * FIN-002: Shared FinOps accounting layer.
 *
 * A single, deterministic, DB-free place that the historical FinOps view, the
 * per-run FinOps view, provider aggregation, and CSV export all reuse so they
 * agree on the numbers. Callers fetch raw usage rows, model pricing, and billing
 * profiles (FIN-001) from the DB, then hand plain objects to these functions —
 * the functions never touch the database or wall-clock, so they are trivially
 * unit-testable.
 *
 * Core ideas this module makes explicit instead of leaving implicit in SQL:
 *
 *  - Every usage row is *classified* into one billing mode (metered_api,
 *    subscription, managed, free_local, unknown) by matching it against the
 *    active billing profiles, falling back to a heuristic when no profile
 *    matches.
 *  - Metered rows produce real *marginal* cost from token counts × model pricing.
 *    A subscription row's marginal cost is always zero/null — it must never
 *    masquerade as direct spend. Instead a flat monthly subscription cost is
 *    *allocated* across the rows that fall under it using a configured basis
 *    (even / by_tokens / by_runs / by_stories / by_active_days).
 *  - The *blended effective* cost is marginal + allocated, which is what a FinOps
 *    dashboard should show as "what this usage really cost us".
 *  - Coverage/provenance is returned alongside every total: how much usage had
 *    pricing, how many rows were unpriced, what allocation mode was used, and
 *    whether each value is metered, allocated, or blended.
 */

import type {
  BillingMode,
  AllocationBasis,
  BillingProfile,
} from './finops-types';

// ─── Allocation methods ──────────────────────────────────────────────────────

/**
 * How a flat subscription cost is spread across the usage rows it covers.
 *
 * This is a superset of FIN-001's {@link AllocationBasis}: it adds `by_stories`
 * and `by_active_days` which the accounting layer supports per the FIN-002
 * acceptance criteria. A persisted `AllocationBasis` maps onto one of these via
 * {@link allocationMethodFromBasis}.
 */
export type AllocationMethod =
  | 'none'
  | 'even'
  | 'by_tokens'
  | 'by_runs'
  | 'by_stories'
  | 'by_active_days';

export const ALLOCATION_METHODS: readonly AllocationMethod[] = [
  'none',
  'even',
  'by_tokens',
  'by_runs',
  'by_stories',
  'by_active_days',
] as const;

/** Map a persisted FIN-001 allocation basis onto an accounting allocation method. */
export function allocationMethodFromBasis(basis: AllocationBasis): AllocationMethod {
  return basis;
}

export function isAllocationMethod(value: unknown): value is AllocationMethod {
  return typeof value === 'string' && (ALLOCATION_METHODS as readonly string[]).includes(value);
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/**
 * A single unit of usage to be accounted for. This is intentionally a flattened,
 * provider-agnostic shape: callers project their `token_usage`/run rows onto it.
 *
 * `runId`, `storyId`, and `day` drive the by_runs / by_stories / by_active_days
 * allocation methods. They are optional because not every usage source carries
 * all three.
 */
export interface UsageRecord {
  /** Provider key, e.g. 'anthropic', 'openai'. Matched against billing profiles. */
  provider: string;
  /** Model id, e.g. 'claude-opus-4-6'. Matched against profile model_pattern + pricing. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Optional reasoning tokens; billed at the output rate when present. */
  reasoningTokens?: number;
  /** Run identifier, for by_runs / by_active_days grouping. */
  runId?: string | null;
  /** Story identifier, for by_stories grouping. */
  storyId?: string | null;
  /** ISO date or timestamp; only the calendar day is used for by_active_days. */
  day?: string | null;
}

/** Per-token pricing for a model (USD per single token). Mirrors model-pricing.ts. */
export interface PricingRate {
  /** USD per input token. */
  input: number;
  /** USD per output token. */
  output: number;
}

/**
 * Everything the accounting functions need that they cannot derive themselves.
 * The caller is responsible for fetching these from the DB and narrowing them to
 * the selected workspace + date window before calling in.
 */
export interface AccountingContext {
  /**
   * Resolve per-token pricing for a model, or null when unknown. Typically backed
   * by `getModelPricing` from model-pricing.ts or the `model_pricing` table.
   */
  pricingFor: (record: UsageRecord) => PricingRate | null;
  /**
   * Active billing profiles to classify rows against. Order matters: the first
   * matching profile wins, so callers should pass the most specific profiles
   * first (model-scoped before provider-wide, workspace before global).
   */
  profiles: readonly BillingProfile[];
  /**
   * Allocation method override. When omitted, each subscription profile's own
   * `allocationBasis` is used. When set, it overrides every profile — useful for
   * a dashboard toggle that re-allocates the same data different ways.
   */
  allocationOverride?: AllocationMethod;
}

// ─── Classification ──────────────────────────────────────────────────────────

/** The classification verdict for a single usage record. */
export interface Classification {
  mode: BillingMode;
  /** The billing profile that produced this classification, if any matched. */
  profileId: number | null;
  /** True when the mode came from a profile; false when it came from the fallback heuristic. */
  fromProfile: boolean;
}

/** Case-insensitive glob match where `*` matches any run of characters. */
function modelPatternMatches(pattern: string | null, model: string): boolean {
  if (pattern == null || pattern === '') return true; // profile applies to whole provider
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex metachars (keep '*')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(model.toLowerCase());
}

/**
 * Heuristic fallback when no billing profile matches a record.
 *
 * Pricing presence is the strongest signal we have without a profile: a model we
 * can price per-token is almost always metered API usage, while an unpriced model
 * is genuinely unknown (it may be a subscription/local model the operator simply
 * has not declared a profile for yet). We deliberately do NOT guess
 * `subscription`/`free_local` here — that would silently zero out cost. Surfacing
 * `unknown` keeps unpriced usage visible in the coverage counters instead.
 */
function classifyHeuristically(record: UsageRecord, ctx: AccountingContext): BillingMode {
  return ctx.pricingFor(record) != null ? 'metered_api' : 'unknown';
}

/** Classify a usage record against the active billing profiles, then fall back. */
export function classifyUsage(record: UsageRecord, ctx: AccountingContext): Classification {
  for (const profile of ctx.profiles) {
    if (!profile.enabled) continue;
    if (profile.provider.toLowerCase() !== record.provider.toLowerCase()) continue;
    if (!modelPatternMatches(profile.modelPattern, record.model)) continue;
    return { mode: profile.billingMode, profileId: profile.id, fromProfile: true };
  }
  return { mode: classifyHeuristically(record, ctx), profileId: null, fromProfile: false };
}

// ─── Metered cost ────────────────────────────────────────────────────────────

/**
 * Marginal (direct) cost of a single record's tokens at the model's rate.
 *
 * Reasoning tokens are billed at the output rate, matching how providers charge
 * for reasoning/thinking output. Returns `null` when the record is unpriced so
 * callers can distinguish "cost is zero" from "we could not price this".
 */
export function meteredCost(record: UsageRecord, rate: PricingRate | null): number | null {
  if (rate == null) return null;
  const billableOutput = record.outputTokens + (record.reasoningTokens ?? 0);
  return record.inputTokens * rate.input + billableOutput * rate.output;
}

// ─── Allocation ──────────────────────────────────────────────────────────────

/** A subscription bucket: one billing profile plus the records it covers. */
interface SubscriptionBucket {
  profile: BillingProfile;
  method: AllocationMethod;
  records: UsageRecord[];
}

/** The per-record weight used to spread a subscription's flat cost. */
function allocationWeight(record: UsageRecord, method: AllocationMethod): number {
  switch (method) {
    case 'by_tokens':
      return record.inputTokens + record.outputTokens + (record.reasoningTokens ?? 0);
    case 'even':
    case 'by_runs':
    case 'by_stories':
    case 'by_active_days':
      // These are group-count bases; per-record they each contribute one unit and
      // the grouping is handled by the caller via distinct keys. 'even' weights
      // every record equally.
      return 1;
    case 'none':
      return 0;
  }
}

/** Distinct grouping key for a record under a group-count allocation method. */
function groupKey(record: UsageRecord, method: AllocationMethod): string | null {
  switch (method) {
    case 'by_runs':
      return record.runId == null ? null : `run:${record.runId}`;
    case 'by_stories':
      return record.storyId == null ? null : `story:${record.storyId}`;
    case 'by_active_days':
      return record.day == null ? null : `day:${calendarDay(record.day)}`;
    default:
      return null;
  }
}

/** Reduce an ISO date/timestamp to its calendar day (UTC), ignoring time. */
function calendarDay(value: string): string {
  // Fast path for already-`YYYY-MM-DD`-prefixed strings avoids Date parsing drift.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  if (m) return m[1];
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10);
}

/**
 * Allocate one subscription bucket's flat monthly cost across its records.
 *
 * Returns a map from record index (within the bucket) to its allocated USD share.
 * The shares always sum to the bucket's total cost (subject to float precision),
 * so no money is created or lost by allocation.
 */
function allocateBucket(bucket: SubscriptionBucket): Map<number, number> {
  const out = new Map<number, number>();
  const total = bucket.profile.monthlyCostUsd ?? 0;
  const { method, records } = bucket;

  if (method === 'none' || total <= 0 || records.length === 0) {
    for (let i = 0; i < records.length; i++) out.set(i, 0);
    return out;
  }

  // Group-count methods (by_runs/by_stories/by_active_days): split the flat cost
  // evenly across distinct groups, then evenly within each group's records.
  if (method === 'by_runs' || method === 'by_stories' || method === 'by_active_days') {
    const groups = new Map<string, number[]>();
    const ungrouped: number[] = [];
    records.forEach((rec, i) => {
      const key = groupKey(rec, method);
      if (key == null) {
        ungrouped.push(i);
        return;
      }
      const arr = groups.get(key);
      if (arr) arr.push(i);
      else groups.set(key, [i]);
    });

    // Records missing the grouping dimension fall back to even-per-record so their
    // cost is never silently dropped; treat each as its own singleton group.
    const groupCount = groups.size + ungrouped.length;
    if (groupCount === 0) {
      for (let i = 0; i < records.length; i++) out.set(i, 0);
      return out;
    }
    const perGroup = total / groupCount;
    for (const indices of groups.values()) {
      const perRecord = perGroup / indices.length;
      for (const i of indices) out.set(i, perRecord);
    }
    for (const i of ungrouped) out.set(i, perGroup);
    return out;
  }

  // Weight-based methods (even / by_tokens): proportional to per-record weight.
  const weights = records.map((rec) => allocationWeight(rec, method));
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum <= 0) {
    // e.g. by_tokens with all-zero token rows — fall back to even split.
    const perRecord = total / records.length;
    for (let i = 0; i < records.length; i++) out.set(i, perRecord);
    return out;
  }
  for (let i = 0; i < records.length; i++) {
    out.set(i, total * (weights[i] / weightSum));
  }
  return out;
}

// ─── Aggregate result ────────────────────────────────────────────────────────

/** Per-billing-mode rollup of token volume, row count, and cost. */
export interface ModeBreakdown {
  mode: BillingMode;
  recordCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Real metered spend for this mode (0 for subscription/managed/free/unknown). */
  meteredCostUsd: number;
  /** Subscription cost allocated to this mode's rows (only > 0 for subscription). */
  allocatedCostUsd: number;
  /** meteredCostUsd + allocatedCostUsd. */
  blendedCostUsd: number;
  /** Rows in this mode that had no usable pricing. */
  unpricedRecordCount: number;
}

/** Coverage/provenance flags describing how trustworthy the totals are. */
export interface CoverageReport {
  /** Total usage rows accounted for. */
  totalRecords: number;
  /** Rows that were classified by an explicit billing profile (vs. heuristic). */
  profileClassifiedRecords: number;
  /** Metered rows that had usable model pricing. */
  pricedRecords: number;
  /** Metered rows that had NO usable model pricing (cost could not be computed). */
  unpricedRecords: number;
  /**
   * Fraction in [0,1] of *metered* rows that were priced. 1 means full coverage;
   * null means there were no metered rows to price.
   */
  pricingCoverage: number | null;
  /** Distinct allocation methods that were actually applied to subscriptions. */
  allocationModes: AllocationMethod[];
  /** True when any reported total is partly allocated rather than purely metered. */
  hasAllocatedCost: boolean;
  /** True when any reported total mixes metered + allocated (blended). */
  hasBlendedCost: boolean;
}

/** The full deterministic accounting result for a set of usage records. */
export interface AccountingResult {
  meteredCostUsd: number;
  /** Marginal subscription cost — always 0; subscriptions never add direct spend. */
  subscriptionMarginalCostUsd: number;
  allocatedSubscriptionCostUsd: number;
  /** meteredCostUsd + allocatedSubscriptionCostUsd. */
  blendedEffectiveCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalReasoningTokens: number;
  byMode: ModeBreakdown[];
  coverage: CoverageReport;
}

function emptyModeBreakdown(mode: BillingMode): ModeBreakdown {
  return {
    mode,
    recordCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    meteredCostUsd: 0,
    allocatedCostUsd: 0,
    blendedCostUsd: 0,
    unpricedRecordCount: 0,
  };
}

/**
 * The deterministic accounting core. Classifies every record, computes metered
 * cost for metered rows, allocates each subscription profile's flat cost across
 * the rows it covers, and returns mode-level rollups plus coverage/provenance.
 *
 * Pure: no DB, no clock, no I/O. Same inputs → same outputs, always.
 */
export function computeAccounting(
  records: readonly UsageRecord[],
  ctx: AccountingContext,
): AccountingResult {
  const byMode = new Map<BillingMode, ModeBreakdown>();
  const modeOf = (mode: BillingMode): ModeBreakdown => {
    let b = byMode.get(mode);
    if (!b) {
      b = emptyModeBreakdown(mode);
      byMode.set(mode, b);
    }
    return b;
  };

  // First pass: classify, tally tokens, and accumulate metered cost.
  // Build subscription buckets keyed by the profile that classified each row.
  const subscriptionBuckets = new Map<number, SubscriptionBucket>();
  const appliedAllocationModes = new Set<AllocationMethod>();

  let pricedRecords = 0;
  let unpricedMeteredRecords = 0;
  let meteredRecords = 0;
  let profileClassifiedRecords = 0;

  for (const record of records) {
    const cls = classifyUsage(record, ctx);
    const bucket = modeOf(cls.mode);

    bucket.recordCount += 1;
    bucket.inputTokens += record.inputTokens;
    bucket.outputTokens += record.outputTokens;
    bucket.reasoningTokens += record.reasoningTokens ?? 0;
    if (cls.fromProfile) profileClassifiedRecords += 1;

    if (cls.mode === 'metered_api') {
      meteredRecords += 1;
      const rate = ctx.pricingFor(record);
      const cost = meteredCost(record, rate);
      if (cost == null) {
        unpricedMeteredRecords += 1;
        bucket.unpricedRecordCount += 1;
      } else {
        pricedRecords += 1;
        bucket.meteredCostUsd += cost;
      }
    } else if (cls.mode === 'subscription' && cls.profileId != null) {
      const profile = ctx.profiles.find((p) => p.id === cls.profileId);
      if (profile) {
        const method = ctx.allocationOverride ?? allocationMethodFromBasis(profile.allocationBasis);
        let sub = subscriptionBuckets.get(profile.id);
        if (!sub) {
          sub = { profile, method, records: [] };
          subscriptionBuckets.set(profile.id, sub);
        }
        sub.records.push(record);
      }
    } else {
      // managed / free_local / unknown carry no marginal cost. unknown rows that
      // also lack pricing are surfaced as unpriced for coverage visibility.
      if (cls.mode === 'unknown' && ctx.pricingFor(record) == null) {
        bucket.unpricedRecordCount += 1;
      }
    }
  }

  // Second pass: allocate each subscription bucket's flat cost across its rows.
  let allocatedTotal = 0;
  const subBreakdown = modeOf('subscription');
  for (const sub of subscriptionBuckets.values()) {
    const shares = allocateBucket(sub);
    let bucketAllocated = 0;
    for (const share of shares.values()) bucketAllocated += share;
    allocatedTotal += bucketAllocated;
    subBreakdown.allocatedCostUsd += bucketAllocated;
    if (sub.method !== 'none' && bucketAllocated > 0) {
      appliedAllocationModes.add(sub.method);
    }
  }

  // Finalize blended per mode.
  for (const b of byMode.values()) {
    b.blendedCostUsd = b.meteredCostUsd + b.allocatedCostUsd;
  }

  const meteredTotal = (byMode.get('metered_api')?.meteredCostUsd) ?? 0;
  const totalInputTokens = sumTokens(byMode, 'inputTokens');
  const totalOutputTokens = sumTokens(byMode, 'outputTokens');
  const totalReasoningTokens = sumTokens(byMode, 'reasoningTokens');

  const coverage: CoverageReport = {
    totalRecords: records.length,
    profileClassifiedRecords,
    pricedRecords,
    unpricedRecords: unpricedMeteredRecords,
    pricingCoverage: meteredRecords === 0 ? null : pricedRecords / meteredRecords,
    allocationModes: ALLOCATION_METHODS.filter((m) => appliedAllocationModes.has(m)),
    hasAllocatedCost: allocatedTotal > 0,
    hasBlendedCost: allocatedTotal > 0 && meteredTotal > 0,
  };

  return {
    meteredCostUsd: meteredTotal,
    subscriptionMarginalCostUsd: 0,
    allocatedSubscriptionCostUsd: allocatedTotal,
    blendedEffectiveCostUsd: meteredTotal + allocatedTotal,
    totalInputTokens,
    totalOutputTokens,
    totalReasoningTokens,
    byMode: orderModes(byMode),
    coverage,
  };
}

/**
 * Per-record accounting provenance, emitted one-per-input-record by
 * {@link computeAccountingPerRecord}. This is what audit/export consumers need:
 * for every usage row it states the billing mode that classified it, its real
 * metered marginal cost, the share of subscription cost allocated to it, the
 * blended effective cost (metered + allocated), and exactly which billing
 * profile and allocation basis produced those numbers.
 *
 * The per-record `allocatedSubscriptionCostUsd` values across all records sum to
 * the aggregate {@link AccountingResult.allocatedSubscriptionCostUsd}, and the
 * per-record `meteredCostUsd` values sum to the aggregate metered total, so an
 * export built from this array reconciles exactly with the dashboard totals.
 */
export interface PerRecordAccounting {
  mode: BillingMode;
  /** Billing profile id that classified this record, or null for the heuristic fallback. */
  profileId: number | null;
  /** True when the mode came from an explicit profile, false when heuristic. */
  fromProfile: boolean;
  /** Marginal metered cost for this record (0 for non-metered or unpriced rows). */
  meteredCostUsd: number;
  /** True when this is a metered row that had no usable pricing. */
  unpriced: boolean;
  /** Subscription cost allocated to this record (0 unless subscription-classified). */
  allocatedSubscriptionCostUsd: number;
  /** meteredCostUsd + allocatedSubscriptionCostUsd. */
  blendedEffectiveCostUsd: number;
  /** Allocation method applied to this record (null when not a subscription row). */
  allocationMethod: AllocationMethod | null;
}

/**
 * Like {@link computeAccounting}, but additionally returns a per-record breakdown
 * aligned 1:1 with the input `records` (same order, same length). The aggregate
 * `result` is identical to what `computeAccounting` would return for the same
 * input, and `perRecord[i]` carries the provenance for `records[i]`.
 *
 * This exists so per-row exports and audit surfaces reuse the exact same
 * classification + allocation logic as the dashboard instead of re-deriving cost
 * semantics (which would inevitably drift). Pure: no DB, no clock, no I/O.
 */
export function computeAccountingPerRecord(
  records: readonly UsageRecord[],
  ctx: AccountingContext,
): { result: AccountingResult; perRecord: PerRecordAccounting[] } {
  const result = computeAccounting(records, ctx);

  // Seed each record with its classification and metered cost. Subscription rows
  // get their allocated share filled in by the second pass below, mirroring the
  // bucketing in computeAccounting so the per-record shares reconcile exactly.
  const perRecord: PerRecordAccounting[] = records.map((record) => {
    const cls = classifyUsage(record, ctx);
    let meteredCostUsd = 0;
    let unpriced = false;
    if (cls.mode === 'metered_api') {
      const cost = meteredCost(record, ctx.pricingFor(record));
      if (cost == null) unpriced = true;
      else meteredCostUsd = cost;
    } else if (cls.mode === 'unknown' && ctx.pricingFor(record) == null) {
      unpriced = true;
    }
    return {
      mode: cls.mode,
      profileId: cls.profileId,
      fromProfile: cls.fromProfile,
      meteredCostUsd,
      unpriced,
      allocatedSubscriptionCostUsd: 0,
      blendedEffectiveCostUsd: meteredCostUsd,
      allocationMethod: null,
    };
  });

  // Rebuild the subscription buckets exactly as computeAccounting does, but track
  // the original record index so each allocated share lands on the right row.
  const buckets = new Map<number, { profile: BillingProfile; method: AllocationMethod; indices: number[]; records: UsageRecord[] }>();
  records.forEach((record, index) => {
    const slot = perRecord[index];
    if (slot.mode !== 'subscription' || slot.profileId == null) return;
    const profile = ctx.profiles.find((p) => p.id === slot.profileId);
    if (!profile) return;
    const method = ctx.allocationOverride ?? allocationMethodFromBasis(profile.allocationBasis);
    let bucket = buckets.get(profile.id);
    if (!bucket) {
      bucket = { profile, method, indices: [], records: [] };
      buckets.set(profile.id, bucket);
    }
    bucket.indices.push(index);
    bucket.records.push(record);
    slot.allocationMethod = method;
  });

  for (const bucket of buckets.values()) {
    const shares = allocateBucket({ profile: bucket.profile, method: bucket.method, records: bucket.records });
    shares.forEach((share, localIdx) => {
      const globalIdx = bucket.indices[localIdx];
      const slot = perRecord[globalIdx];
      slot.allocatedSubscriptionCostUsd = share;
      slot.blendedEffectiveCostUsd = slot.meteredCostUsd + share;
    });
  }

  return { result, perRecord };
}

function sumTokens(byMode: Map<BillingMode, ModeBreakdown>, key: keyof ModeBreakdown): number {
  let sum = 0;
  for (const b of byMode.values()) sum += b[key] as number;
  return sum;
}

/** Return mode breakdowns in a stable, presentation-friendly order. */
function orderModes(byMode: Map<BillingMode, ModeBreakdown>): ModeBreakdown[] {
  const order: BillingMode[] = ['metered_api', 'subscription', 'managed', 'free_local', 'unknown'];
  return order.filter((m) => byMode.has(m)).map((m) => byMode.get(m)!);
}
