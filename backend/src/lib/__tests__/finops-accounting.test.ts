/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  classifyUsage,
  meteredCost,
  computeAccounting,
  allocationMethodFromBasis,
  isAllocationMethod,
  type AccountingContext,
  type UsageRecord,
  type PricingRate,
} from '../finops-accounting';
import type { BillingProfile } from '../finops-types';

// ─── Test helpers ────────────────────────────────────────────────────────────

function profile(overrides: Partial<BillingProfile> & Pick<BillingProfile, 'id' | 'provider' | 'billingMode'>): BillingProfile {
  return {
    workspaceId: null,
    modelPattern: null,
    monthlyCostUsd: null,
    allocationBasis: 'none',
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    notes: null,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function rec(overrides: Partial<UsageRecord> & Pick<UsageRecord, 'provider' | 'model'>): UsageRecord {
  return { inputTokens: 0, outputTokens: 0, ...overrides };
}

/** Pricing table: anthropic opus + openai gpt-4o; everything else unpriced. */
const PRICES: Record<string, PricingRate> = {
  'claude-opus-4-6': { input: 0.000015, output: 0.000075 },
  'gpt-4o': { input: 0.0000025, output: 0.00001 },
};

function ctxWith(profiles: BillingProfile[], allocationOverride?: AccountingContext['allocationOverride']): AccountingContext {
  return {
    profiles,
    allocationOverride,
    pricingFor: (r) => PRICES[r.model] ?? null,
  };
}

// ─── Allocation method helpers ───────────────────────────────────────────────

describe('allocation method mapping', () => {
  it('maps every persisted basis to itself', () => {
    expect(allocationMethodFromBasis('none')).toBe('none');
    expect(allocationMethodFromBasis('even')).toBe('even');
    expect(allocationMethodFromBasis('by_tokens')).toBe('by_tokens');
    expect(allocationMethodFromBasis('by_runs')).toBe('by_runs');
  });

  it('recognizes the extended accounting methods', () => {
    expect(isAllocationMethod('by_stories')).toBe(true);
    expect(isAllocationMethod('by_active_days')).toBe(true);
    expect(isAllocationMethod('garbage')).toBe(false);
  });
});

// ─── Classification ──────────────────────────────────────────────────────────

describe('classifyUsage', () => {
  it('matches a provider-wide profile case-insensitively', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'Anthropic', billingMode: 'subscription', monthlyCostUsd: 20 })]);
    const cls = classifyUsage(rec({ provider: 'anthropic', model: 'claude-opus-4-6' }), ctx);
    expect(cls.mode).toBe('subscription');
    expect(cls.profileId).toBe(1);
    expect(cls.fromProfile).toBe(true);
  });

  it('honors model_pattern globs', () => {
    const ctx = ctxWith([
      profile({ id: 1, provider: 'anthropic', modelPattern: 'claude-haiku-*', billingMode: 'free_local' }),
      profile({ id: 2, provider: 'anthropic', modelPattern: 'claude-opus-*', billingMode: 'subscription', monthlyCostUsd: 200 }),
    ]);
    expect(classifyUsage(rec({ provider: 'anthropic', model: 'claude-opus-4-6' }), ctx).profileId).toBe(2);
    expect(classifyUsage(rec({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001' }), ctx).mode).toBe('free_local');
  });

  it('takes the first matching profile when several match', () => {
    const ctx = ctxWith([
      profile({ id: 1, provider: 'anthropic', modelPattern: 'claude-opus-*', billingMode: 'subscription', monthlyCostUsd: 20 }),
      profile({ id: 2, provider: 'anthropic', billingMode: 'metered_api' }),
    ]);
    expect(classifyUsage(rec({ provider: 'anthropic', model: 'claude-opus-4-6' }), ctx).profileId).toBe(1);
  });

  it('skips disabled profiles', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 20, enabled: false })]);
    const cls = classifyUsage(rec({ provider: 'anthropic', model: 'claude-opus-4-6' }), ctx);
    expect(cls.fromProfile).toBe(false);
    expect(cls.mode).toBe('metered_api'); // falls back to heuristic; opus is priced
  });

  it('falls back to metered_api for priced models and unknown for unpriced', () => {
    const ctx = ctxWith([]);
    expect(classifyUsage(rec({ provider: 'openai', model: 'gpt-4o' }), ctx).mode).toBe('metered_api');
    expect(classifyUsage(rec({ provider: 'local', model: 'llama-3' }), ctx).mode).toBe('unknown');
  });
});

// ─── Metered cost ────────────────────────────────────────────────────────────

describe('meteredCost', () => {
  it('computes input*rate + output*rate', () => {
    const cost = meteredCost(rec({ provider: 'a', model: 'm', inputTokens: 1000, outputTokens: 500 }), { input: 0.001, output: 0.002 });
    expect(cost).toBeCloseTo(1000 * 0.001 + 500 * 0.002, 10);
  });

  it('bills reasoning tokens at the output rate', () => {
    const cost = meteredCost(
      rec({ provider: 'a', model: 'm', inputTokens: 0, outputTokens: 100, reasoningTokens: 50 }),
      { input: 0.001, output: 0.002 },
    );
    expect(cost).toBeCloseTo(150 * 0.002, 10);
  });

  it('returns null when unpriced so zero-cost is distinguishable', () => {
    expect(meteredCost(rec({ provider: 'a', model: 'm', inputTokens: 100, outputTokens: 100 }), null)).toBeNull();
  });
});

// ─── Metered aggregation + coverage ──────────────────────────────────────────

describe('computeAccounting — metered + coverage', () => {
  it('sums metered cost from token counts and model pricing', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'openai', billingMode: 'metered_api' })]);
    const res = computeAccounting([
      rec({ provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ], ctx);
    // 1M input * 0.0000025 + 1M output * 0.00001 = 2.5 + 10 = 12.5
    expect(res.meteredCostUsd).toBeCloseTo(12.5, 6);
    expect(res.allocatedSubscriptionCostUsd).toBe(0);
    expect(res.blendedEffectiveCostUsd).toBeCloseTo(12.5, 6);
    expect(res.subscriptionMarginalCostUsd).toBe(0);
  });

  it('reports partial pricing coverage and unpriced counts', () => {
    const ctx = ctxWith([]); // heuristic: priced→metered, unpriced→unknown
    const res = computeAccounting([
      rec({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 }),
      rec({ provider: 'local', model: 'mystery-model', inputTokens: 1000, outputTokens: 1000 }),
    ], ctx);
    // Only the gpt-4o row is metered+priced. The mystery row is unknown/unpriced.
    expect(res.coverage.pricedRecords).toBe(1);
    expect(res.coverage.pricingCoverage).toBe(1); // 1 of 1 *metered* rows priced
    const unknown = res.byMode.find((m) => m.mode === 'unknown');
    expect(unknown?.unpricedRecordCount).toBe(1);
  });

  it('counts unpriced metered rows and reports fractional coverage', () => {
    // Force both rows to metered via profile, but only one is priced.
    const ctx = ctxWith([profile({ id: 1, provider: 'openai', billingMode: 'metered_api' })]);
    const res = computeAccounting([
      rec({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 }),
      rec({ provider: 'openai', model: 'gpt-unpriced', inputTokens: 1000, outputTokens: 1000 }),
    ], ctx);
    expect(res.coverage.pricedRecords).toBe(1);
    expect(res.coverage.unpricedRecords).toBe(1);
    expect(res.coverage.pricingCoverage).toBeCloseTo(0.5, 6);
    expect(res.coverage.hasBlendedCost).toBe(false);
  });

  it('returns null pricingCoverage when there are no metered rows', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 20, allocationBasis: 'even' })]);
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 10, outputTokens: 10 }),
    ], ctx);
    expect(res.coverage.pricingCoverage).toBeNull();
  });
});

// ─── Subscription allocation ─────────────────────────────────────────────────

describe('computeAccounting — subscription allocation', () => {
  it('never lets a subscription add marginal/direct spend', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 100, allocationBasis: 'none' })]);
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ], ctx);
    expect(res.meteredCostUsd).toBe(0); // subscription tokens are NOT direct spend
    expect(res.subscriptionMarginalCostUsd).toBe(0);
    expect(res.allocatedSubscriptionCostUsd).toBe(0); // basis 'none' → not allocated
  });

  it('allocates evenly across rows', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 90, allocationBasis: 'even' })]);
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1 }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1 }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1 }),
    ], ctx);
    expect(res.allocatedSubscriptionCostUsd).toBeCloseTo(90, 6);
    expect(res.blendedEffectiveCostUsd).toBeCloseTo(90, 6);
    expect(res.coverage.allocationModes).toEqual(['even']);
  });

  it('allocates by token weight', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 100, allocationBasis: 'by_tokens' })]);
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 30, outputTokens: 0 }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 10, outputTokens: 0 }),
    ], ctx);
    // weights 30 vs 10 → 75 / 25; total conserved at 100.
    expect(res.allocatedSubscriptionCostUsd).toBeCloseTo(100, 6);
    expect(res.coverage.allocationModes).toEqual(['by_tokens']);
  });

  it('allocates by_runs across distinct runs, splitting within a run', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 100, allocationBasis: 'by_runs' })]);
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1, runId: 'r1' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1, runId: 'r1' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1, runId: 'r2' }),
    ], ctx);
    // Two runs → 50 each. r1 has 2 rows (25 each), r2 has 1 (50). Total 100.
    expect(res.allocatedSubscriptionCostUsd).toBeCloseTo(100, 6);
  });

  it('allocates by_stories and by_active_days using grouping keys', () => {
    // by_stories / by_active_days are accounting-only methods (not persisted bases),
    // so they are driven via the allocation override.
    const stories = ctxWith(
      [profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 60, allocationBasis: 'even' })],
      'by_stories',
    );
    const sres = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', storyId: 'US-1' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', storyId: 'US-2' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', storyId: 'US-3' }),
    ], stories);
    expect(sres.allocatedSubscriptionCostUsd).toBeCloseTo(60, 6);
    expect(sres.coverage.allocationModes).toEqual(['by_stories']);

    const days = ctxWith([profile({ id: 2, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 40, allocationBasis: 'even' })], 'by_active_days');
    const dres = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', day: '2026-06-01T10:00:00Z' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', day: '2026-06-01T22:00:00Z' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', day: '2026-06-02T01:00:00Z' }),
    ], days);
    // Two active days → 20 each regardless of row count within a day. Total 40.
    expect(dres.allocatedSubscriptionCostUsd).toBeCloseTo(40, 6);
  });

  it('honors an allocation override over the profile basis', () => {
    const ctx = ctxWith(
      [profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 100, allocationBasis: 'none' })],
      'even',
    );
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6' }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6' }),
    ], ctx);
    // basis was 'none' but override 'even' forces a 50/50 split.
    expect(res.allocatedSubscriptionCostUsd).toBeCloseTo(100, 6);
    expect(res.coverage.allocationModes).toEqual(['even']);
  });

  it('falls back to even split when by_tokens has all-zero token rows', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 50, allocationBasis: 'by_tokens' })]);
    const res = computeAccounting([
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 0, outputTokens: 0 }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 0, outputTokens: 0 }),
    ], ctx);
    expect(res.allocatedSubscriptionCostUsd).toBeCloseTo(50, 6);
  });
});

// ─── Mixed providers / blended ───────────────────────────────────────────────

describe('computeAccounting — mixed providers and blended cost', () => {
  it('blends metered API spend with allocated subscription cost', () => {
    const ctx = ctxWith([
      profile({ id: 1, provider: 'openai', billingMode: 'metered_api' }),
      profile({ id: 2, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 100, allocationBasis: 'even' }),
    ]);
    const res = computeAccounting([
      // metered: 1M in, 1M out gpt-4o → 12.5
      rec({ provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 1_000_000 }),
      // subscription: one row gets the full $100 allocation
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 5, outputTokens: 5 }),
    ], ctx);

    expect(res.meteredCostUsd).toBeCloseTo(12.5, 6);
    expect(res.allocatedSubscriptionCostUsd).toBeCloseTo(100, 6);
    expect(res.blendedEffectiveCostUsd).toBeCloseTo(112.5, 6);
    expect(res.coverage.hasBlendedCost).toBe(true);
    expect(res.coverage.hasAllocatedCost).toBe(true);

    const metered = res.byMode.find((m) => m.mode === 'metered_api');
    const sub = res.byMode.find((m) => m.mode === 'subscription');
    expect(metered?.blendedCostUsd).toBeCloseTo(12.5, 6);
    expect(sub?.meteredCostUsd).toBe(0);
    expect(sub?.allocatedCostUsd).toBeCloseTo(100, 6);
  });

  it('keeps free_local and managed at zero cost', () => {
    const ctx = ctxWith([
      profile({ id: 1, provider: 'local', billingMode: 'free_local' }),
      profile({ id: 2, provider: 'bedrock', billingMode: 'managed' }),
    ]);
    const res = computeAccounting([
      rec({ provider: 'local', model: 'llama-3', inputTokens: 1000, outputTokens: 1000 }),
      rec({ provider: 'bedrock', model: 'claude-via-bedrock', inputTokens: 1000, outputTokens: 1000 }),
    ], ctx);
    expect(res.meteredCostUsd).toBe(0);
    expect(res.allocatedSubscriptionCostUsd).toBe(0);
    expect(res.blendedEffectiveCostUsd).toBe(0);
    expect(res.coverage.pricingCoverage).toBeNull(); // no metered rows
  });

  it('aggregates token totals across all modes', () => {
    const ctx = ctxWith([
      profile({ id: 1, provider: 'openai', billingMode: 'metered_api' }),
      profile({ id: 2, provider: 'anthropic', billingMode: 'subscription', monthlyCostUsd: 10, allocationBasis: 'even' }),
    ]);
    const res = computeAccounting([
      rec({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 200, reasoningTokens: 50 }),
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 10, outputTokens: 20, reasoningTokens: 5 }),
    ], ctx);
    expect(res.totalInputTokens).toBe(110);
    expect(res.totalOutputTokens).toBe(220);
    expect(res.totalReasoningTokens).toBe(55);
  });

  it('reports profileClassifiedRecords vs heuristic records', () => {
    const ctx = ctxWith([profile({ id: 1, provider: 'openai', billingMode: 'metered_api' })]);
    const res = computeAccounting([
      rec({ provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }), // profile
      rec({ provider: 'anthropic', model: 'claude-opus-4-6', inputTokens: 1, outputTokens: 1 }), // heuristic
    ], ctx);
    expect(res.coverage.totalRecords).toBe(2);
    expect(res.coverage.profileClassifiedRecords).toBe(1);
  });
});
