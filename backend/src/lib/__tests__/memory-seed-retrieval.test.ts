/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-014 — Memory & prior-spec seed retrieval.
 *
 * These tests exercise the *pure* selector (`selectSeeds`) and its helpers, so
 * no database or filesystem is required. They lock the four acceptance criteria:
 *   1. durable memories + prior specs are blended into seeds;
 *   2. pending/rejected/etc. candidates are excluded by default (governance gate);
 *   3. memory seeds carry category / title / confidence / trust / reason;
 *   4. memory & spec contributions are capped by BOTH count and token budget.
 */

import {
  CANDIDATE_REVIEW_STATUSES,
  SEED_TRUST_WEIGHT,
  deriveMemoryTrust,
  isCandidateEligible,
  lexicalRelevance,
  mapCandidateTrust,
  normalizeConfidence,
  selectSeeds,
  type DurableMemoryRecord,
  type MemoryCandidateRecord,
  type PriorSpecRecord,
  type SeedRetrievalInputs,
} from '../memory-seed-retrieval';

// ─── Fixture builders ─────────────────────────────────────────────────────────

function memory(overrides: Partial<DurableMemoryRecord> = {}): DurableMemoryRecord {
  return {
    id: overrides.id ?? 'm1',
    category: overrides.category ?? 'Bug Fix',
    content: overrides.content ?? 'Always restart the worker after a spec merge',
    confidence: overrides.confidence ?? 'high',
    sourceType: overrides.sourceType ?? 'synthesis',
    pinned: overrides.pinned ?? false,
    ...overrides,
  };
}

function candidate(overrides: Partial<MemoryCandidateRecord> = {}): MemoryCandidateRecord {
  return {
    id: overrides.id ?? 'c1',
    reviewStatus: overrides.reviewStatus ?? 'pending',
    category: overrides.category ?? 'Decision',
    title: overrides.title ?? 'Captured note',
    rule: overrides.rule ?? 'Prefer native Postgres over Docker on macOS',
    trustTier: overrides.trustTier ?? 'community',
    confidence: overrides.confidence ?? 'medium',
    ...overrides,
  };
}

function spec(overrides: Partial<PriorSpecRecord> = {}): PriorSpecRecord {
  return {
    specId: overrides.specId ?? 'rorca-feature',
    title: overrides.title ?? 'Rorca Feature',
    status: overrides.status ?? 'approved',
    stories: overrides.stories ?? [{ id: 'US-001', title: 'First story' }],
  };
}

function inputs(overrides: Partial<SeedRetrievalInputs> = {}): SeedRetrievalInputs {
  return {
    durableMemories: overrides.durableMemories ?? [],
    memoryCandidates: overrides.memoryCandidates ?? [],
    priorSpecs: overrides.priorSpecs ?? [],
  };
}

// ─── normalizeConfidence ──────────────────────────────────────────────────────

describe('normalizeConfidence', () => {
  it('maps the text enum to numeric bands', () => {
    expect(normalizeConfidence('high')).toBeCloseTo(0.9);
    expect(normalizeConfidence('medium')).toBeCloseTo(0.6);
    expect(normalizeConfidence('low')).toBeCloseTo(0.3);
  });

  it('passes numeric values through, clamped to [0,1]', () => {
    expect(normalizeConfidence(0.42)).toBeCloseTo(0.42);
    expect(normalizeConfidence(5)).toBe(1);
    expect(normalizeConfidence(-1)).toBe(0);
    expect(normalizeConfidence('0.75')).toBeCloseTo(0.75);
  });

  it('falls back to neutral 0.5 for null/unknown', () => {
    expect(normalizeConfidence(null)).toBe(0.5);
    expect(normalizeConfidence(undefined)).toBe(0.5);
    expect(normalizeConfidence('bogus')).toBe(0.5);
  });
});

// ─── trust derivation ─────────────────────────────────────────────────────────

describe('deriveMemoryTrust', () => {
  it('treats pinned and manual memory as authoritative', () => {
    expect(deriveMemoryTrust({ pinned: true, sourceType: 'synthesis' })).toBe('authoritative');
    expect(deriveMemoryTrust({ pinned: false, sourceType: 'manual' })).toBe('authoritative');
  });

  it('treats synthesis/mcp as reviewed and machine-extracted as derived', () => {
    expect(deriveMemoryTrust({ sourceType: 'synthesis' })).toBe('reviewed');
    expect(deriveMemoryTrust({ sourceType: 'mcp' })).toBe('reviewed');
    expect(deriveMemoryTrust({ sourceType: 'auto-extracted' })).toBe('derived');
    expect(deriveMemoryTrust({ sourceType: 'import' })).toBe('derived');
  });

  it('defaults unknown source types to reviewed (durable memory is governed)', () => {
    expect(deriveMemoryTrust({ sourceType: null })).toBe('reviewed');
  });
});

describe('mapCandidateTrust', () => {
  it('bridges the US-004 trust vocabulary onto CIP tiers', () => {
    expect(mapCandidateTrust('authoritative')).toBe('authoritative');
    expect(mapCandidateTrust('trusted')).toBe('reviewed');
    expect(mapCandidateTrust('community')).toBe('derived');
    expect(mapCandidateTrust('unverified')).toBe('unverified');
    expect(mapCandidateTrust(null)).toBe('unverified');
  });
});

// ─── governance gate ──────────────────────────────────────────────────────────

describe('isCandidateEligible (governance gate)', () => {
  it('excludes every status by default — durable memory only', () => {
    for (const status of CANDIDATE_REVIEW_STATUSES) {
      expect(isCandidateEligible(status, false)).toBe(false);
    }
  });

  it('admits only approved when explicitly opted in', () => {
    expect(isCandidateEligible('approved', true)).toBe(true);
    for (const status of CANDIDATE_REVIEW_STATUSES.filter((s) => s !== 'approved')) {
      expect(isCandidateEligible(status, true)).toBe(false);
    }
  });
});

// ─── lexicalRelevance ─────────────────────────────────────────────────────────

describe('lexicalRelevance', () => {
  it('returns the fraction of brief terms present in the text', () => {
    expect(lexicalRelevance('restart the worker after merge', 'worker merge')).toBeCloseTo(1);
    expect(lexicalRelevance('restart the worker', 'worker merge')).toBeCloseTo(0.5);
    expect(lexicalRelevance('nothing relevant here', 'worker merge')).toBe(0);
  });

  it('is neutral (0.5) when no brief is supplied', () => {
    expect(lexicalRelevance('anything', undefined)).toBe(0.5);
    expect(lexicalRelevance('anything', '   ')).toBe(0.5);
  });
});

// ─── selectSeeds: blending (AC1) ──────────────────────────────────────────────

describe('selectSeeds — blends durable memories and prior specs (AC1)', () => {
  it('produces memory seeds from durable memories and spec seeds from approved specs', () => {
    const result = selectSeeds(
      inputs({
        durableMemories: [memory({ id: 'm1', content: 'worker restart after merge' })],
        priorSpecs: [spec({ specId: 'rorca-worker', title: 'Worker hardening' })],
      }),
      { brief: 'worker merge' },
    );

    expect(result.memorySeeds).toHaveLength(1);
    expect(result.memorySeeds[0].ref).toBe('m1');
    expect(result.specSeeds).toHaveLength(1);
    expect(result.specSeeds[0].specId).toBe('rorca-worker');
    expect(result.specSeeds[0].kind).toBe('spec');
  });

  it('skips durable memories with empty content', () => {
    const result = selectSeeds(inputs({ durableMemories: [memory({ content: '   ' })] }));
    expect(result.memorySeeds).toHaveLength(0);
  });

  it('orders memory seeds by descending score', () => {
    const result = selectSeeds(
      inputs({
        durableMemories: [
          memory({ id: 'low', content: 'unrelated text', confidence: 'low', sourceType: 'import' }),
          memory({ id: 'high', content: 'worker merge worker merge', confidence: 'high', pinned: true }),
        ],
      }),
      { brief: 'worker merge' },
    );
    expect(result.memorySeeds.map((s) => s.id)).toEqual(['high', 'low']);
    expect(result.memorySeeds[0].score).toBeGreaterThan(result.memorySeeds[1].score);
  });
});

// ─── selectSeeds: governance gate (AC2) ───────────────────────────────────────

describe('selectSeeds — excludes pending/rejected candidates by default (AC2)', () => {
  const candidatesAllStatuses = CANDIDATE_REVIEW_STATUSES.map((status, i) =>
    candidate({ id: `c${i}`, reviewStatus: status, rule: `rule for ${status}` }),
  );

  it('excludes ALL candidates by default (full gate to durable memory)', () => {
    const result = selectSeeds(inputs({ memoryCandidates: candidatesAllStatuses }));
    expect(result.memorySeeds).toHaveLength(0);
    expect(result.meta.memoryCandidatesConsidered).toBe(CANDIDATE_REVIEW_STATUSES.length);
    expect(result.meta.memoryCandidatesExcludedByGovernance).toBe(CANDIDATE_REVIEW_STATUSES.length);
    expect(result.meta.excludedReviewStatuses).toEqual(expect.arrayContaining(['pending', 'rejected']));
  });

  it('admits only approved candidates when opted in, still excluding pending/rejected', () => {
    const result = selectSeeds(
      inputs({ memoryCandidates: candidatesAllStatuses }),
      { includeApprovedCandidates: true },
    );
    expect(result.memorySeeds).toHaveLength(1);
    expect(result.memorySeeds[0].ref).toMatch(/^candidate:/);
    expect(result.meta.memoryCandidatesExcludedByGovernance).toBe(CANDIDATE_REVIEW_STATUSES.length - 1);
    expect(result.meta.excludedReviewStatuses).not.toContain('approved');
    expect(result.meta.excludedReviewStatuses).toContain('rejected');
  });

  it('excludes pending/draft specs by default and includes them only when opted in', () => {
    const specs = [spec({ specId: 'a', status: 'approved' }), spec({ specId: 'b', status: 'pending' })];
    const gated = selectSeeds(inputs({ priorSpecs: specs }));
    expect(gated.specSeeds.map((s) => s.specId)).toEqual(['a']);
    expect(gated.meta.specsExcludedByStatus).toBe(1);

    const opened = selectSeeds(inputs({ priorSpecs: specs }), { includeUnapprovedSpecs: true });
    expect(opened.specSeeds.map((s) => s.specId).sort()).toEqual(['a', 'b']);
  });
});

// ─── selectSeeds: explainable seed shape (AC3) ────────────────────────────────

describe('selectSeeds — memory seeds carry category/title/confidence/trust/reason (AC3)', () => {
  it('stamps every required explainability field on a memory seed', () => {
    const result = selectSeeds(
      inputs({ durableMemories: [memory({ id: 'm1', category: 'Gotcha', content: 'AGE search_path poisons the pool', pinned: true })] }),
      { brief: 'AGE pool' },
    );
    const seed = result.memorySeeds[0];
    expect(seed.category).toBe('Gotcha');
    expect(seed.title.length).toBeGreaterThan(0);
    expect(seed.confidence).toBeGreaterThanOrEqual(0);
    expect(seed.confidence).toBeLessThanOrEqual(1);
    expect(seed.trust).toBe('authoritative');
    expect(seed.reason).toContain('pinned');
    expect(seed.reason).toContain('trust=authoritative');
    expect(seed.score).toBeGreaterThanOrEqual(0);
    expect(seed.score).toBeLessThanOrEqual(1);
  });

  it('reflects matched brief terms in the reason', () => {
    const result = selectSeeds(
      inputs({ durableMemories: [memory({ content: 'worker merge restart' })] }),
      { brief: 'worker merge' },
    );
    expect(result.memorySeeds[0].reason).toContain('matched 2 brief terms');
  });
});

// ─── selectSeeds: count + token caps (AC4) ────────────────────────────────────

describe('selectSeeds — caps contribution by count and token budget (AC4)', () => {
  const many = Array.from({ length: 20 }, (_, i) =>
    memory({ id: `m${i}`, content: `worker merge note number ${i} `.repeat(3) }),
  );

  it('enforces the count cap and reports the overflow', () => {
    const result = selectSeeds(inputs({ durableMemories: many }), {
      brief: 'worker merge',
      maxMemorySeeds: 5,
      tokenBudget: 1_000_000,
    });
    expect(result.memorySeeds).toHaveLength(5);
    expect(result.meta.memorySeedsDroppedByCount).toBe(15);
  });

  it('enforces the token budget and reports budget drops (no memory dump)', () => {
    const result = selectSeeds(inputs({ durableMemories: many }), {
      brief: 'worker merge',
      maxMemorySeeds: 20,
      tokenBudget: 60, // memory budget = floor(60 * 0.65) = 39 tokens
      memoryBudgetRatio: 0.65,
    });
    expect(result.meta.memoryTokensUsed).toBeLessThanOrEqual(39);
    expect(result.memorySeeds.length).toBeLessThan(many.length);
    expect(result.meta.memorySeedsDroppedByBudget).toBeGreaterThan(0);
  });

  it('splits the token budget between memory and spec sections', () => {
    const result = selectSeeds(
      inputs({
        durableMemories: [memory({ id: 'm1' })],
        priorSpecs: [spec({ specId: 's1' })],
      }),
      { tokenBudget: 1000, memoryBudgetRatio: 0.7 },
    );
    expect(result.meta.tokenBudget).toBe(1000);
    expect(result.meta.memoryTokensUsed).toBeLessThanOrEqual(700);
    expect(result.meta.specTokensUsed).toBeLessThanOrEqual(300);
  });

  it('drops a single oversized seed entirely rather than dumping it', () => {
    const huge = memory({ id: 'huge', content: 'x'.repeat(100_000) });
    const result = selectSeeds(inputs({ durableMemories: [huge] }), { tokenBudget: 50 });
    expect(result.memorySeeds).toHaveLength(0);
    expect(result.meta.memorySeedsDroppedByBudget).toBe(1);
  });

  it('contributes nothing when the token budget is zero', () => {
    const result = selectSeeds(
      inputs({ durableMemories: [memory()], priorSpecs: [spec()] }),
      { tokenBudget: 0 },
    );
    expect(result.memorySeeds).toHaveLength(0);
    expect(result.specSeeds).toHaveLength(0);
  });
});

// ─── trust weight ordering sanity ─────────────────────────────────────────────

describe('SEED_TRUST_WEIGHT', () => {
  it('is monotonically decreasing from authoritative to unverified', () => {
    expect(SEED_TRUST_WEIGHT.authoritative).toBeGreaterThan(SEED_TRUST_WEIGHT.reviewed);
    expect(SEED_TRUST_WEIGHT.reviewed).toBeGreaterThan(SEED_TRUST_WEIGHT.derived);
    expect(SEED_TRUST_WEIGHT.derived).toBeGreaterThan(SEED_TRUST_WEIGHT.captured);
    expect(SEED_TRUST_WEIGHT.captured).toBeGreaterThan(SEED_TRUST_WEIGHT.unverified);
  });
});
