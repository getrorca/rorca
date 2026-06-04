/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * FIN-009: the FinOps CSV export must preserve the same accounting semantics as
 * the dashboard and per-run views — billing mode, metered cost, allocated
 * subscription cost, blended effective cost, allocation basis, and coverage /
 * provenance identifiers — across metered-only, subscription-only, and mixed
 * datasets. These tests drive the export endpoint with a mocked DB so the
 * accounting columns can be asserted deterministically.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: jest.fn(),
  execute: jest.fn(),
}));

const { query } = require('../../db/index');
const analyticsRouter = require('../analytics').default;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/analytics', analyticsRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || err.status || 500).json({ error: err.message || 'error' });
  });
  return app;
}

/** A token_usage row as returned by the export SQL (joined to its run). */
interface UsageRowFixture {
  run_id: number;
  story_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cost_usd: number;
  recorded_at: string;
  workspace_id: string;
  spec_slug: string;
  agent_type: string;
}

interface PricingFixture {
  model_id: string;
  input_cost_per_1m: number | null;
  output_cost_per_1m: number | null;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

interface ProfileFixture {
  id: string;
  workspace_id: string | null;
  provider: string;
  model_pattern: string | null;
  billing_mode: string;
  monthly_cost_usd: string | null;
  allocation_basis: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Wire the three queries the export endpoint issues to fixtures. */
function mockExportData(opts: {
  usage: UsageRowFixture[];
  pricing?: PricingFixture[];
  profiles?: ProfileFixture[];
}) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM token_usage tu') && sql.includes('JOIN pipeline_runs pr')) {
      return opts.usage;
    }
    if (sql.includes('FROM model_pricing')) {
      return opts.pricing ?? [];
    }
    if (sql.includes('FROM billing_profiles')) {
      return opts.profiles ?? [];
    }
    return [];
  });
}

/** Parse a CSV body into a header array + array of row objects. */
function parseCsv(body: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = body.trim().split('\r\n');
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    // Simple split is sufficient: the fixtures use no embedded commas/quotes.
    const cells = line.split(',');
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
  return { headers, rows };
}

const PRICING_OPUS: PricingFixture = {
  model_id: 'claude-opus-4-6',
  input_cost_per_1m: 15,
  output_cost_per_1m: 75,
  input_cost_per_1k: 0.015,
  output_cost_per_1k: 0.075,
};

function subscriptionProfile(overrides: Partial<ProfileFixture> = {}): ProfileFixture {
  return {
    id: '1',
    workspace_id: null,
    provider: 'anthropic',
    model_pattern: null,
    billing_mode: 'subscription',
    monthly_cost_usd: '200',
    allocation_basis: 'even',
    effective_from: '2026-01-01T00:00:00.000Z',
    effective_to: null,
    notes: null,
    enabled: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const ACCOUNTING_HEADERS = [
  'run_id', 'story_id', 'spec_slug', 'provider', 'model', 'tier', 'agent_type',
  'billing_mode', 'billing_profile_id', 'classified_by', 'allocation_basis',
  'input_tokens', 'output_tokens', 'reasoning_tokens',
  'cost_usd', 'metered_cost_usd', 'allocated_subscription_cost_usd', 'blended_effective_cost_usd',
  'priced', 'opus_baseline_usd', 'savings_usd',
  'recorded_at', 'workspace_id',
];

describe('GET /api/analytics/finops/export (FIN-009)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits the full accounting header schema', async () => {
    mockExportData({ usage: [] });
    const res = await request(makeApp()).get('/api/analytics/finops/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment.*rorca-finops-.*\.csv/);
    const { headers } = parseCsv(res.text);
    expect(headers).toEqual(ACCOUNTING_HEADERS);
  });

  // ─── Metered-only ──────────────────────────────────────────────────

  it('reports metered rows with metered cost = blended cost and no allocation', async () => {
    mockExportData({
      pricing: [PRICING_OPUS],
      usage: [{
        run_id: 7, story_id: 'US-001', model: 'claude-opus-4-6',
        input_tokens: 1_000_000, output_tokens: 1_000_000, cost_usd: 90,
        recorded_at: '2026-03-01T00:00:00.000Z', workspace_id: 'ws-1',
        spec_slug: 'spec-a', agent_type: 'claude',
      }],
    });

    const res = await request(makeApp()).get('/api/analytics/finops/export');
    expect(res.status).toBe(200);
    const { rows } = parseCsv(res.text);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.billing_mode).toBe('metered_api');
    expect(row.provider).toBe('anthropic');
    expect(row.classified_by).toBe('heuristic'); // no profile, priced → metered
    expect(row.allocation_basis).toBe('');
    expect(row.priced).toBe('true');
    // 1M input @ $15/M + 1M output @ $75/M = $90 metered, $0 allocated, $90 blended.
    expect(Number(row.metered_cost_usd)).toBeCloseTo(90, 4);
    expect(Number(row.allocated_subscription_cost_usd)).toBe(0);
    expect(Number(row.blended_effective_cost_usd)).toBeCloseTo(90, 4);
  });

  it('marks unpriced metered rows as not priced with zero metered cost', async () => {
    mockExportData({
      pricing: [], // no pricing at all
      usage: [{
        run_id: 7, story_id: 'US-001', model: 'mystery-model',
        input_tokens: 1000, output_tokens: 500, cost_usd: 0,
        recorded_at: '2026-03-01T00:00:00.000Z', workspace_id: 'ws-1',
        spec_slug: 'spec-a', agent_type: 'opencode',
      }],
    });

    const res = await request(makeApp()).get('/api/analytics/finops/export');
    const { rows } = parseCsv(res.text);
    expect(rows[0].billing_mode).toBe('unknown');
    expect(rows[0].priced).toBe('false');
    expect(Number(rows[0].metered_cost_usd)).toBe(0);
    expect(Number(rows[0].blended_effective_cost_usd)).toBe(0);
  });

  // ─── Subscription-only ─────────────────────────────────────────────

  it('allocates a flat subscription cost across rows with zero metered cost', async () => {
    mockExportData({
      pricing: [PRICING_OPUS],
      profiles: [subscriptionProfile({ allocation_basis: 'even', monthly_cost_usd: '200' })],
      usage: [
        {
          run_id: 7, story_id: 'US-001', model: 'claude-opus-4-6',
          input_tokens: 1000, output_tokens: 500, cost_usd: 90,
          recorded_at: '2026-03-01T00:00:00.000Z', workspace_id: 'ws-1',
          spec_slug: 'spec-a', agent_type: 'claude',
        },
        {
          run_id: 7, story_id: 'US-002', model: 'claude-opus-4-6',
          input_tokens: 2000, output_tokens: 1000, cost_usd: 90,
          recorded_at: '2026-03-01T01:00:00.000Z', workspace_id: 'ws-1',
          spec_slug: 'spec-a', agent_type: 'claude',
        },
      ],
    });

    const res = await request(makeApp()).get('/api/analytics/finops/export');
    const { rows } = parseCsv(res.text);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.billing_mode).toBe('subscription');
      expect(row.classified_by).toBe('profile');
      expect(row.billing_profile_id).toBe('1');
      expect(row.allocation_basis).toBe('even');
      // Subscription rows never carry marginal metered spend.
      expect(Number(row.metered_cost_usd)).toBe(0);
      // $200 split evenly across 2 rows → $100 each, blended == allocated.
      expect(Number(row.allocated_subscription_cost_usd)).toBeCloseTo(100, 4);
      expect(Number(row.blended_effective_cost_usd)).toBeCloseTo(100, 4);
    }
    // Allocation reconciles exactly to the flat monthly cost.
    const allocatedSum = rows.reduce((s, r) => s + Number(r.allocated_subscription_cost_usd), 0);
    expect(allocatedSum).toBeCloseTo(200, 4);
  });

  it('weights by_tokens allocation by per-row token volume', async () => {
    mockExportData({
      pricing: [PRICING_OPUS],
      profiles: [subscriptionProfile({ allocation_basis: 'by_tokens', monthly_cost_usd: '300' })],
      usage: [
        {
          run_id: 7, story_id: 'US-001', model: 'claude-opus-4-6',
          input_tokens: 100, output_tokens: 0, cost_usd: 0,
          recorded_at: '2026-03-01T00:00:00.000Z', workspace_id: 'ws-1',
          spec_slug: 'spec-a', agent_type: 'claude',
        },
        {
          run_id: 7, story_id: 'US-002', model: 'claude-opus-4-6',
          input_tokens: 200, output_tokens: 0, cost_usd: 0,
          recorded_at: '2026-03-01T01:00:00.000Z', workspace_id: 'ws-1',
          spec_slug: 'spec-a', agent_type: 'claude',
        },
      ],
    });

    const res = await request(makeApp()).get('/api/analytics/finops/export');
    const { rows } = parseCsv(res.text);
    // 100 vs 200 tokens → $300 splits as $100 / $200.
    expect(Number(rows[0].allocated_subscription_cost_usd)).toBeCloseTo(100, 4);
    expect(Number(rows[1].allocated_subscription_cost_usd)).toBeCloseTo(200, 4);
    expect(rows.every((r) => r.allocation_basis === 'by_tokens')).toBe(true);
  });

  // ─── Mixed metered + subscription ──────────────────────────────────

  it('keeps metered and subscription rows distinct in a mixed dataset', async () => {
    mockExportData({
      pricing: [PRICING_OPUS, {
        model_id: 'gpt-4o', input_cost_per_1m: 2.5, output_cost_per_1m: 10,
        input_cost_per_1k: 0.0025, output_cost_per_1k: 0.01,
      }],
      // Subscription only applies to the anthropic provider; openai stays metered.
      profiles: [subscriptionProfile({ provider: 'anthropic', allocation_basis: 'even', monthly_cost_usd: '50' })],
      usage: [
        {
          run_id: 7, story_id: 'US-001', model: 'claude-opus-4-6',
          input_tokens: 1000, output_tokens: 500, cost_usd: 90,
          recorded_at: '2026-03-01T00:00:00.000Z', workspace_id: 'ws-1',
          spec_slug: 'spec-a', agent_type: 'claude',
        },
        {
          run_id: 8, story_id: 'US-002', model: 'gpt-4o',
          input_tokens: 1_000_000, output_tokens: 1_000_000, cost_usd: 12.5,
          recorded_at: '2026-03-01T01:00:00.000Z', workspace_id: 'ws-1',
          spec_slug: 'spec-b', agent_type: 'pi',
        },
      ],
    });

    const res = await request(makeApp()).get('/api/analytics/finops/export');
    const { rows } = parseCsv(res.text);
    expect(rows).toHaveLength(2);

    const sub = rows.find((r) => r.model === 'claude-opus-4-6')!;
    expect(sub.billing_mode).toBe('subscription');
    expect(sub.provider).toBe('anthropic');
    expect(Number(sub.metered_cost_usd)).toBe(0);
    expect(Number(sub.allocated_subscription_cost_usd)).toBeCloseTo(50, 4);
    expect(Number(sub.blended_effective_cost_usd)).toBeCloseTo(50, 4);

    const metered = rows.find((r) => r.model === 'gpt-4o')!;
    expect(metered.billing_mode).toBe('metered_api');
    expect(metered.provider).toBe('openai');
    // 1M @ $2.5 + 1M @ $10 = $12.5 metered, $0 allocated, $12.5 blended.
    expect(Number(metered.metered_cost_usd)).toBeCloseTo(12.5, 4);
    expect(Number(metered.allocated_subscription_cost_usd)).toBe(0);
    expect(Number(metered.blended_effective_cost_usd)).toBeCloseTo(12.5, 4);
  });

  it('preserves audit identifiers (run_id, story_id, spec_slug) for every row', async () => {
    mockExportData({
      pricing: [PRICING_OPUS],
      usage: [{
        run_id: 99, story_id: 'US-042', model: 'claude-opus-4-6',
        input_tokens: 10, output_tokens: 5, cost_usd: 0,
        recorded_at: '2026-03-01T00:00:00.000Z', workspace_id: 'ws-7',
        spec_slug: 'audit-spec', agent_type: 'claude',
      }],
    });

    const res = await request(makeApp()).get('/api/analytics/finops/export');
    const { rows } = parseCsv(res.text);
    expect(rows[0].run_id).toBe('99');
    expect(rows[0].story_id).toBe('US-042');
    expect(rows[0].spec_slug).toBe('audit-spec');
    expect(rows[0].workspace_id).toBe('ws-7');
  });
});
