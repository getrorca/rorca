/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';
import * as ageGuard from '../../lib/age-guard';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;
let authId: string;

let workspaceSequence = 0;
let WS_ID = '';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  app = require('../../server').default;
});

beforeEach(async () => {
  workspaceSequence += 1;
  WS_ID = `ws-analytics-${process.pid}-${workspaceSequence}`;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-analytics-test-'));
  authId = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1_000_000_000_000).toString().padStart(12, '0')}`;
  authToken = await getAuthToken(app, { authId });
  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);
  jest.spyOn(ageGuard, 'checkAge').mockResolvedValue(true);

  // Each test owns a fresh workspace identity; append-only run/evidence state
  // is retained rather than globally truncated between requests.
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, 'Analytics WS', $2)`, [WS_ID, wsDir]);
  await execute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2::uuid, 'owner')`,
    [WS_ID, authId],
  );
});

afterEach(async () => {
  jest.restoreAllMocks();
  await execute(
    `UPDATE pipeline_runs SET status = 'failed', finished_at = COALESCE(finished_at, NOW())
      WHERE workspace_id = $1 AND status NOT IN ('done', 'failed', 'cancelled', 'partial_failure')`,
    [WS_ID],
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
});

function get(urlPath: string) {
  return request(app).get(urlPath).set('Authorization', `Bearer ${authToken}`);
}

function put(urlPath: string, body: Record<string, unknown>) {
  return request(app).put(urlPath).set('Authorization', `Bearer ${authToken}`).send(body);
}

function del(urlPath: string) {
  return request(app).delete(urlPath).set('Authorization', `Bearer ${authToken}`);
}

/** Seed a pipeline run + token_usage + story_results for analytics */
async function seedAnalyticsData() {
  const result = await queryOne<{id: number}>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, started_at, finished_at)
     VALUES ('forge/specs/approved/test-analytics.json', $1, 'done', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day') RETURNING id`, [WS_ID]);
  const runId = result!.id;

  // Insert token_usage rows
  for (let i = 1; i <= 3; i++) {
    await execute(`INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, $2, $3, 'claude-sonnet-4-5-20250929', $4, $5, $6, NOW() - ($7 || ' hours')::INTERVAL)`, [runId, `US-${String(i).padStart(3, '0')}`, WS_ID, 10000 * i, 2000 * i, 0.05 * i, i]);
  }

  // Insert story_results rows
  const statuses = ['pass', 'pass', 'fail'];
  for (let i = 1; i <= 3; i++) {
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at, elapsed_seconds, input_tokens, output_tokens)
       VALUES ($1, $2, $3, NOW() - ($4 || ' hours')::INTERVAL, $5, $6, $7)`, [runId, `US-${String(i).padStart(3, '0')}`, statuses[i - 1], i, 60 * i, 10000 * i, 2000 * i]);
  }

  return runId;
}

async function seedOntologyData() {
  const memory1 = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, confidence, related_files, source_type, source, updated_at)
     VALUES ($1, 'Architecture', 'Legacy direction should stay active', 'MOG-001', 'spec-a', 'high', $2::jsonb, 'manual', 'MOG-001', NOW() - INTERVAL '1 day')
     RETURNING id`,
    [WS_ID, JSON.stringify(['backend/src/routes/memory.ts'])],
  );
  const memory2 = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, confidence, related_files, source_type, source, updated_at)
     VALUES ($1, 'Decision', 'New direction conflicts with the legacy rule', 'MOG-009', 'spec-b', 'high', $2::jsonb, 'manual', 'MOG-009', NOW() - INTERVAL '12 hours')
     RETURNING id`,
    [WS_ID, JSON.stringify(['src/panels/MemoryPanel.tsx'])],
  );
  const memory3 = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, confidence, related_files, source_type, source, updated_at)
     VALUES ($1, 'Convention', 'Old cleanup guidance', 'MOG-002', 'spec-a', 'medium', $2::jsonb, 'manual', 'MOG-002', NOW() - INTERVAL '8 hours')
     RETURNING id`,
    [WS_ID, JSON.stringify(['src/panels/MemoryPanel.tsx'])],
  );
  const memory4 = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, source_story_id, source_spec_id, confidence, related_files, source_type, source, updated_at)
     VALUES ($1, 'Convention', 'New cleanup guidance', 'MOG-009', 'spec-a', 'high', $2::jsonb, 'manual', 'MOG-009', NOW() - INTERVAL '2 hours')
     RETURNING id`,
    [WS_ID, JSON.stringify(['src/panels/MemoryPanel.tsx'])],
  );

  await execute(
    `INSERT INTO memory_relations (workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key, status, updated_at)
     VALUES ($1, $2, $3, 'CONFLICTS_WITH', $4, 'active', NOW() - INTERVAL '30 minutes')`,
    [WS_ID, memory1!.id, memory2!.id, `conflict:${memory1!.id}:${memory2!.id}`],
  );
  await execute(
    `INSERT INTO memory_relations (workspace_id, source_memory_id, target_memory_id, relation_type, canonical_key, status, updated_at)
     VALUES ($1, $2, $3, 'SUPERSEDES', $4, 'active', NOW() - INTERVAL '15 minutes')`,
    [WS_ID, memory4!.id, memory3!.id, `supersedes:${memory4!.id}:${memory3!.id}`],
  );
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, actor, payload, ts)
     VALUES ('memory_reviewed', $1, 'spec-a', 'MOG-009', 'user', $2::jsonb, NOW() - INTERVAL '10 minutes')`,
    [WS_ID, JSON.stringify({ memoryId: memory3!.id, action: 'keep', provenance: { sourceSpecId: 'spec-a', relatedFiles: ['src/panels/MemoryPanel.tsx'] } })],
  );
}

async function seedPiProviderData(workspaceId: string, authIdForWorkspace?: string) {
  const workspacePath = path.join(tmpDir, `workspace-${workspaceId}`);
  fs.mkdirSync(workspacePath, { recursive: true });
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [workspaceId, `Workspace ${workspaceId}`, workspacePath],
  );

  if (authIdForWorkspace) {
    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'owner')
       ON CONFLICT (workspace_id, user_auth_id) DO NOTHING`,
      [workspaceId, authIdForWorkspace],
    );
  }

  const piRun = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, finished_at)
     VALUES ('forge/specs/approved/pi-spec.json', $1, 'done', 'pi', 'pi', NOW())
     RETURNING id`,
    [workspaceId],
  );
  const nonPiRun = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, finished_at)
     VALUES ('forge/specs/approved/non-pi-spec.json', $1, 'done', 'claude', 'claude', NOW())
     RETURNING id`,
    [workspaceId],
  );

  await execute(
    `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
     VALUES
       ($1, 'US-001', $2, 'pi/openai/gpt-4.1', 1000, 200, 0, NOW() - INTERVAL '2 hours'),
       ($1, 'US-002', $2, 'pi/openai/gpt-4.1', 500, 100, 0.5, NOW() - INTERVAL '1 hour'),
       ($1, 'US-003', $2, 'pi/omlx/local', 700, 50, 0, NOW() - INTERVAL '30 minutes'),
       ($3, 'US-999', $2, 'claude-sonnet-4-5-20250929', 999, 999, 9.99, NOW())`,
    [piRun!.id, workspaceId, nonPiRun!.id],
  );
}

/** Upsert a model_pricing row using per-1M rates. */
async function seedPricing(modelId: string, provider: string, inputPer1m: number, outputPer1m: number) {
  await execute(
    `INSERT INTO model_pricing (model_id, provider, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m, effective_date)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (model_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       input_cost_per_1m = EXCLUDED.input_cost_per_1m,
       output_cost_per_1m = EXCLUDED.output_cost_per_1m`,
    [modelId, provider, inputPer1m / 1000, outputPer1m / 1000, inputPer1m, outputPer1m],
  );
}

/** Insert a subscription billing profile (global or workspace-scoped). */
async function seedSubscriptionProfile(opts: {
  provider: string;
  modelPattern?: string | null;
  monthlyCostUsd: number;
  allocationBasis?: 'none' | 'even' | 'by_tokens' | 'by_runs';
  workspaceId?: string | null;
}) {
  await execute(
    `INSERT INTO billing_profiles (workspace_id, provider, model_pattern, billing_mode, monthly_cost_usd, allocation_basis, effective_from, enabled)
     VALUES ($1, $2, $3, 'subscription', $4, $5, NOW() - INTERVAL '365 days', TRUE)`,
    [opts.workspaceId === undefined ? WS_ID : opts.workspaceId, opts.provider, opts.modelPattern ?? null, opts.monthlyCostUsd, opts.allocationBasis ?? 'even'],
  );
}

/**
 * Seed a historical FinOps fixture: a run with metered Anthropic usage (priced),
 * subscription OpenAI usage, and an unpriced model — within the date window.
 */
async function seedHistoricalFinOps() {
  const run = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, started_at, finished_at)
     VALUES ('forge/specs/approved/fin-historical.json', $1, 'done', NOW() - INTERVAL '5 days', NOW() - INTERVAL '4 days')
     RETURNING id`,
    [WS_ID],
  );
  const runId = run!.id;

  // Metered, priced Anthropic usage.
  await execute(
    `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
     VALUES ($1, 'US-001', $2, 'claude-opus-4-6', 1000000, 500000, 0, NOW() - INTERVAL '5 days')`,
    [runId, WS_ID],
  );
  // Subscription OpenAI usage (no marginal cost — allocated from the profile).
  await execute(
    `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
     VALUES ($1, 'US-002', $2, 'gpt-4o', 200000, 50000, 0, NOW() - INTERVAL '4 days')`,
    [runId, WS_ID],
  );
  // Unpriced, unclassified model — surfaced via coverage, not as cost.
  await execute(
    `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
     VALUES ($1, 'US-003', $2, 'mystery/local-model', 300000, 100000, 0, NOW() - INTERVAL '3 days')`,
    [runId, WS_ID],
  );

  return runId;
}

// ─── GET /api/analytics/usage ────────────────────────────────────────────────

describe('GET /api/analytics/usage', () => {
  test('returns empty data when no token usage exists', async () => {
    const res = await get(`/api/analytics/usage?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.grouped).toEqual([]);
    expect(res.body.timeSeries).toEqual([]);
    expect(res.body.totals).toBeDefined();
    expect(res.body.totals.total_records).toBe(0);
    expect(res.body.dateRange).toBeDefined();
    expect(res.body.groupBy).toBe('model');
  });

  test('returns usage data grouped by model (default)', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/usage?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.grouped).toHaveLength(1);
    expect(res.body.grouped[0].group_key).toBe('claude-sonnet-4-5-20250929');
    expect(res.body.grouped[0].count).toBe(3);
    expect(res.body.grouped[0].total_input_tokens).toBe(60000); // 10k + 20k + 30k
    expect(res.body.grouped[0].total_output_tokens).toBe(12000); // 2k + 4k + 6k
    expect(res.body.timeSeries.length).toBeGreaterThan(0);
    expect(res.body.totals.total_records).toBe(3);
  });

  test('returns 400 for invalid group_by', async () => {
    const res = await get('/api/analytics/usage?group_by=invalid');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('group_by');
  });

  test('groups by story when requested', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/usage?workspace_id=${WS_ID}&group_by=story`);

    expect(res.status).toBe(200);
    expect(res.body.grouped).toHaveLength(3); // US-001, US-002, US-003
    expect(res.body.groupBy).toBe('story');
  });

  test('includes hasActiveRuns flag', async () => {
    const res = await get(`/api/analytics/usage?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.hasActiveRuns).toBe('boolean');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/usage');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/analytics/costs ────────────────────────────────────────────────

describe('GET /api/analytics/costs', () => {
  test('returns empty breakdown when no data exists', async () => {
    const res = await get(`/api/analytics/costs?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toEqual([]);
    expect(res.body.groupBy).toBe('spec');
    expect(res.body.dateRange).toBeDefined();
  });

  test('returns costs grouped by model', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/costs?workspace_id=${WS_ID}&group_by=model`);

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toHaveLength(1);
    expect(res.body.breakdown[0].group_key).toBe('claude-sonnet-4-5-20250929');
    expect(res.body.breakdown[0].story_count).toBe(3);
    expect(res.body.totals).toBeDefined();
    expect(res.body.totals.total_stories).toBe(3);
  });

  test('returns costs grouped by period (weekly)', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/costs?workspace_id=${WS_ID}&group_by=period`);

    expect(res.status).toBe(200);
    expect(res.body.groupBy).toBe('period');
    expect(res.body.periods).toBeDefined();
    expect(Array.isArray(res.body.periods)).toBe(true);
  });

  test('returns 400 for invalid group_by', async () => {
    const res = await get('/api/analytics/costs?group_by=invalid');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('group_by');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/costs');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/analytics/pricing ──────────────────────────────────────────────

describe('GET /api/analytics/pricing', () => {
  test('returns pricing list (may include defaults)', async () => {
    const res = await get('/api/analytics/pricing');

    expect(res.status).toBe(200);
    expect(res.body.pricing).toBeDefined();
    expect(Array.isArray(res.body.pricing)).toBe(true);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/pricing');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/analytics/finops/run/:runId', () => {
  test('returns provider/model rows for running runs before token_usage exists', async () => {
    fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'forge', 'specs', 'approved', 'finops-pending.json'), JSON.stringify({
      title: 'Pending FinOps',
      userStories: [
        { id: 'US-001', title: 'Story one' },
        { id: 'US-002', title: 'Story two' },
      ],
    }), 'utf8');

    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model)
       VALUES ('forge/specs/approved/finops-pending.json', $1, 'running', 'pi', 'pi', 'openrouter/google/gemini-2.5-pro')
       RETURNING id`,
      [WS_ID],
    );

    const res = await get(`/api/analytics/finops/run/${run!.id}`);

    expect(res.status).toBe(200);
    expect(res.body.agentType).toBe('pi');
    expect(res.body.agentModel).toBe('openrouter/google/gemini-2.5-pro');
    expect(res.body.usageAvailable).toBe(false);
    expect(res.body.totals.stories).toBe(2);
    expect(res.body.runSummary[0]).toMatchObject({
      model: 'openrouter/google/gemini-2.5-pro',
      stories: 2,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test('uses live story_token_update WAL events when token_usage is not finalized', async () => {
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model)
       VALUES ('forge/specs/approved/live-finops.json', $1, 'running', 'opencode', 'opencode', 'openai/gpt-4o')
       RETURNING id`,
      [WS_ID],
    );

    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
       VALUES ('story_token_update', $1, 'US-001', $2::jsonb)`,
      [WS_ID, JSON.stringify({ run_id: run!.id, model: 'openai/gpt-4o', input_tokens: 1200, output_tokens: 300, cost_usd: 0.01 })],
    );

    const res = await get(`/api/analytics/finops/run/${run!.id}`);

    expect(res.status).toBe(200);
    expect(res.body.usageAvailable).toBe(true);
    expect(res.body.totals.stories).toBe(1);
    expect(res.body.totals.inputTokens).toBe(1200);
    expect(res.body.totals.outputTokens).toBe(300);
    expect(res.body.perStory[0]).toMatchObject({ storyId: 'US-001', model: 'openai/gpt-4o' });
  });

  // ── FIN-004: accounting-mode-aware per-run FinOps ─────────────────────────
  test('API-only run separates metered spend from blended cost and reports savings', async () => {
    // claude-opus-4-6 priced at $10/1M input, $40/1M output (metered API usage).
    await seedPricing('claude-opus-4-6', 'anthropic', 10, 40);

    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model, started_at, finished_at)
       VALUES ('forge/specs/approved/fin-api-only.json', $1, 'done', 'claude', 'claude', 'claude-opus-4-6', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [WS_ID],
    );
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, 'US-001', $2, 'claude-opus-4-6', 1000000, 500000, 0, NOW() - INTERVAL '2 days')`,
      [run!.id, WS_ID],
    );

    const res = await get(`/api/analytics/finops/run/${run!.id}`);

    expect(res.status).toBe(200);
    expect(res.body.billingMode).toBe('metered_api');
    expect(res.body.isSubscription).toBe(false);
    // Metered: 1M*$10/1M + 0.5M*$40/1M = 10 + 20 = $30.
    expect(res.body.accounting.meteredCostUsd).toBeCloseTo(30, 2);
    expect(res.body.accounting.allocatedSubscriptionCostUsd).toBe(0);
    expect(res.body.accounting.blendedEffectiveCostUsd).toBeCloseTo(30, 2);
    expect(res.body.totals.meteredCostUsd).toBeCloseTo(30, 2);
    // Savings is present (metered run) and compares against the all-Opus baseline.
    expect(res.body.savings).not.toBeNull();
    expect(res.body.savings.actual).toBeCloseTo(30, 2);
    expect(res.body.perStory[0]).toMatchObject({ billingMode: 'metered_api', meteredCost: 30 });
    expect(res.body.provenance.hasMeteredSpend).toBe(true);
    expect(res.body.provenance.pricingCoverage).toBe(1);
  });

  test('subscription-only run shows truthful usage and no invoice-backed per-run spend', async () => {
    // gpt-4o is priced, but a subscription profile overrides its billing mode so
    // it must never report marginal per-run spend.
    await seedPricing('gpt-4o', 'openai', 5, 15);
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 30, allocationBasis: 'by_runs' });

    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model, started_at, finished_at)
       VALUES ('forge/specs/approved/fin-sub-only.json', $1, 'done', 'opencode', 'opencode', 'gpt-4o', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [WS_ID],
    );
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES
         ($1, 'US-001', $2, 'gpt-4o', 100000, 20000, 0, NOW() - INTERVAL '2 days'),
         ($1, 'US-002', $2, 'gpt-4o', 200000, 40000, 0, NOW() - INTERVAL '1 day')`,
      [run!.id, WS_ID],
    );

    const res = await get(`/api/analytics/finops/run/${run!.id}`);

    expect(res.status).toBe(200);
    expect(res.body.billingMode).toBe('subscription');
    expect(res.body.isSubscription).toBe(true);
    // No metered marginal spend — subscription cost is allocated, not invoiced per run.
    expect(res.body.accounting.meteredCostUsd).toBe(0);
    expect(res.body.accounting.allocatedSubscriptionCostUsd).toBeGreaterThan(0);
    expect(res.body.accounting.subscriptionUsage.inputTokens).toBe(300000);
    expect(res.body.accounting.subscriptionUsage.outputTokens).toBe(60000);
    expect(res.body.accounting.subscriptionUsage.recordCount).toBe(2);
    // Subscription-only runs never imply marginal savings.
    expect(res.body.savings).toBeNull();
    // Per-story rows carry zero metered cost but the subscription billing mode.
    expect(res.body.perStory.every((s: any) => s.billingMode === 'subscription' && s.meteredCost === 0)).toBe(true);
    expect(res.body.provenance.hasMeteredSpend).toBe(false);
  });

  test('mixed-provider run aggregates metered + subscription rows across sources', async () => {
    await seedPricing('claude-opus-4-6', 'anthropic', 10, 40);
    await seedPricing('gpt-4o', 'openai', 5, 15);
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 30, allocationBasis: 'even' });

    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model, started_at, finished_at)
       VALUES ('forge/specs/approved/fin-mixed.json', $1, 'done', 'pi', 'pi', 'claude-opus-4-6', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [WS_ID],
    );
    // Metered Anthropic row from token_usage.
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, 'US-001', $2, 'claude-opus-4-6', 1000000, 500000, 0, NOW() - INTERVAL '2 days')`,
      [run!.id, WS_ID],
    );
    // Subscription OpenAI row supplied only via story_results fallback.
    await execute(
      `INSERT INTO story_results (run_id, story_id, status, finished_at, elapsed_seconds, model_used, input_tokens, output_tokens, cost_usd)
       VALUES ($1, 'US-002', 'pass', NOW() - INTERVAL '1 day', 30, 'gpt-4o', 200000, 50000, 0)`,
      [run!.id],
    );

    const res = await get(`/api/analytics/finops/run/${run!.id}`);

    expect(res.status).toBe(200);
    // Metered: claude-opus row = $30. Allocated: single even subscription bucket = $30.
    expect(res.body.accounting.meteredCostUsd).toBeCloseTo(30, 2);
    expect(res.body.accounting.allocatedSubscriptionCostUsd).toBeCloseTo(30, 2);
    expect(res.body.accounting.blendedEffectiveCostUsd).toBeCloseTo(60, 2);
    expect(res.body.totals.blendedEffectiveCostUsd).toBeCloseTo(60, 2);
    // Both rows accounted for; subscription usage is the OpenAI fallback row only.
    expect(res.body.accounting.subscriptionUsage.recordCount).toBe(1);
    expect(res.body.totals.stories).toBe(2);
    const metered = res.body.accounting.byMode.find((m: any) => m.mode === 'metered_api');
    const subscription = res.body.accounting.byMode.find((m: any) => m.mode === 'subscription');
    expect(metered.meteredCostUsd).toBeCloseTo(30, 2);
    expect(subscription.allocatedCostUsd).toBeCloseTo(30, 2);
    expect(res.body.provenance.hasBlendedCost).toBe(true);
  });

  test('in-flight WAL token updates feed the accounting engine for a subscription run', async () => {
    await seedPricing('gpt-4o', 'openai', 5, 15);
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 30, allocationBasis: 'even' });

    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, agent_model)
       VALUES ('forge/specs/approved/fin-live-sub.json', $1, 'running', 'opencode', 'opencode', 'gpt-4o')
       RETURNING id`,
      [WS_ID],
    );
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, story_id, payload)
       VALUES ('story_token_update', $1, 'US-001', $2::jsonb)`,
      [WS_ID, JSON.stringify({ run_id: run!.id, model: 'gpt-4o', input_tokens: 1200, output_tokens: 300, cost_usd: 0 })],
    );

    const res = await get(`/api/analytics/finops/run/${run!.id}`);

    expect(res.status).toBe(200);
    // Live usage is visible immediately and classified as subscription (no spend).
    expect(res.body.usageAvailable).toBe(true);
    expect(res.body.billingMode).toBe('subscription');
    expect(res.body.isSubscription).toBe(true);
    expect(res.body.accounting.meteredCostUsd).toBe(0);
    expect(res.body.accounting.subscriptionUsage.inputTokens).toBe(1200);
    expect(res.body.accounting.subscriptionUsage.outputTokens).toBe(300);
    expect(res.body.savings).toBeNull();
    expect(res.body.perStory[0]).toMatchObject({ storyId: 'US-001', model: 'gpt-4o', billingMode: 'subscription' });
  });
});

describe('GET /api/analytics/pi-providers', () => {
  test('returns empty array when no pi runs exist', async () => {
    const res = await get(`/api/analytics/pi-providers?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('aggregates usage by all execution providers', async () => {
    await seedPiProviderData(WS_ID, authId);

    const res = await get(`/api/analytics/pi-providers?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);

    const openai = res.body.find((row: any) => row.provider === 'openai');
    const omlx = res.body.find((row: any) => row.provider === 'omlx');
    const claude = res.body.find((row: any) => row.provider === 'claude');

    expect(openai).toMatchObject({
      provider: 'openai',
      totalRuns: 1,
      totalStories: 2,
      totalInputTokens: 1500,
      totalOutputTokens: 300,
      totalCost: 0.5,
      avgCostPerStory: 0.25,
    });
    expect(typeof openai.lastUsed).toBe('string');

    expect(omlx).toMatchObject({
      provider: 'omlx',
      totalRuns: 1,
      totalStories: 1,
      totalInputTokens: 700,
      totalOutputTokens: 50,
      totalCost: 0,
      avgCostPerStory: 0,
    });

    expect(claude).toMatchObject({
      provider: 'claude',
      totalRuns: 1,
      totalStories: 1,
      totalInputTokens: 999,
      totalOutputTokens: 999,
      totalCost: 9.99,
    });
    expect(claude.avgCostPerStory).toBeCloseTo(9.99, 5);
  });

  test('applies the explicit workspace scope without leaking another workspace', async () => {
    const hiddenWorkspaceId = `${WS_ID}-hidden`;
    await seedPiProviderData(WS_ID, authId);
    await seedPiProviderData(hiddenWorkspaceId);

    const res = await get(`/api/analytics/pi-providers?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.find((row: any) => row.provider === 'openai')?.totalStories).toBe(2);
    expect(res.body.find((row: any) => row.provider === 'omlx')?.totalStories).toBe(1);
    expect(res.body.find((row: any) => row.provider === 'claude')?.totalStories).toBe(1);
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/pi-providers');
    expect(res.status).toBe(401);
  });
});

// ─── PUT /api/analytics/pricing/:modelId ─────────────────────────────────────

describe('PUT /api/analytics/pricing/:modelId', () => {
  test('creates new pricing entry', async () => {
    const res = await put('/api/analytics/pricing/test-model-v1', {
      provider: 'test-provider',
      input_cost_per_1m_tokens: 3.0,
      output_cost_per_1m_tokens: 15.0,
    });

    expect(res.status).toBe(200);
    expect(res.body.model_id).toBe('test-model-v1');
    expect(res.body.provider).toBe('test-provider');
    expect(res.body.input_cost_per_1m_tokens).toBe(3.0);
    expect(res.body.output_cost_per_1m_tokens).toBe(15.0);
  });

  test('updates existing pricing entry', async () => {
    // Create
    await put('/api/analytics/pricing/test-model-v1', {
      input_cost_per_1m_tokens: 3.0,
      output_cost_per_1m_tokens: 15.0,
    });

    // Update
    const res = await put('/api/analytics/pricing/test-model-v1', {
      input_cost_per_1m_tokens: 5.0,
      output_cost_per_1m_tokens: 20.0,
    });

    expect(res.status).toBe(200);
    expect(res.body.input_cost_per_1m_tokens).toBe(5.0);
    expect(res.body.output_cost_per_1m_tokens).toBe(20.0);
  });

  test('returns 400 when cost fields are missing', async () => {
    const res = await put('/api/analytics/pricing/test-model', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });

  test('returns 400 when cost is negative', async () => {
    const res = await put('/api/analytics/pricing/test-model', {
      input_cost_per_1m_tokens: -1,
      output_cost_per_1m_tokens: 15.0,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('negative');
  });

  test('persists pricing in database', async () => {
    await put('/api/analytics/pricing/db-check-model', {
      input_cost_per_1m_tokens: 2.5,
      output_cost_per_1m_tokens: 10.0,
    });

    const row = await queryOne(`SELECT * FROM model_pricing WHERE model_id = $1`, ['db-check-model']) as any;
    expect(row).toBeDefined();
    expect(row.input_cost_per_1m).toBe(2.5);
    expect(row.output_cost_per_1m).toBe(10.0);
  });
});

// ─── DELETE /api/analytics/pricing/:modelId ──────────────────────────────────

describe('DELETE /api/analytics/pricing/:modelId', () => {
  test('deletes existing pricing entry', async () => {
    await put('/api/analytics/pricing/delete-me', {
      input_cost_per_1m_tokens: 1.0,
      output_cost_per_1m_tokens: 5.0,
    });

    const res = await del('/api/analytics/pricing/delete-me');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe('delete-me');

    // Verify gone from DB
    const row = await queryOne(`SELECT * FROM model_pricing WHERE model_id = $1`, ['delete-me']);
    expect(row).toBeUndefined();
  });

  test('returns 404 when model pricing does not exist', async () => {
    const res = await del('/api/analytics/pricing/nonexistent-model');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });
});

// ─── GET /api/analytics/models ───────────────────────────────────────────────

describe('GET /api/analytics/models', () => {
  test('returns empty models when no data exists', async () => {
    const res = await get(`/api/analytics/models?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([]);
    expect(res.body.dateRange).toBeDefined();
  });

  test('returns model comparison metrics with data', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/models?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.models).toHaveLength(1);

    const model = res.body.models[0];
    expect(model.model).toBe('claude-sonnet-4-5-20250929');
    expect(model.totalStories).toBe(3);
    expect(model.passedStories).toBe(2);
    expect(model.failedStories).toBe(1);
    expect(model.passRate).toBeCloseTo(2 / 3, 2);
    expect(typeof model.avgCostUsd).toBe('number');
    expect(typeof model.avgElapsedSeconds).toBe('number');
    expect(typeof model.insufficientData).toBe('boolean');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/models');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/analytics/velocity ─────────────────────────────────────────────

describe('GET /api/analytics/velocity', () => {
  test('returns empty velocity when no data exists', async () => {
    const res = await get(`/api/analytics/velocity?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.velocity).toEqual([]);
    expect(res.body.availableSpecs).toBeDefined();
    expect(res.body.dateRange).toBeDefined();
  });

  test('returns weekly velocity data', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/velocity?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.velocity.length).toBeGreaterThan(0);

    const week = res.body.velocity[0];
    expect(week.week).toBeDefined();
    expect(typeof week.passed).toBe('number');
    expect(typeof week.failed).toBe('number');
    expect(typeof week.total).toBe('number');
    expect(typeof week.rollingAvg).toBe('number');
  });

  test('includes available specs for filtering', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/velocity?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.availableSpecs)).toBe(true);
    expect(res.body.availableSpecs).toContain('test-analytics');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/velocity');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/analytics/completion-rates ─────────────────────────────────────

describe('GET /api/analytics/completion-rates', () => {
  test('returns completion rate structure when no data exists', async () => {
    const res = await get(`/api/analytics/completion-rates?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.byComplexity).toBeDefined();
    expect(res.body.byTag).toBeDefined();
    expect(res.body.summary).toBeDefined();
    expect(res.body.dateRange).toBeDefined();
  });

  test('returns summary pass/fail/skip counts with data', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/completion-rates?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(typeof res.body.summary.passed).toBe('number');
    expect(typeof res.body.summary.failed).toBe('number');
    expect(typeof res.body.summary.overallPassRate).toBe('number');
  });

  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/completion-rates');
    expect(res.status).toBe(401);
  });
});

// ─── GET /api/analytics/ontology-health ──────────────────────────────────────

describe('GET /api/analytics/ontology-health', () => {
  test('returns bounded ontology summary metrics and drilldown data', async () => {
    await seedOntologyData();

    const res = await get(`/api/analytics/ontology-health?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.dataAvailable).toBe(true);
    expect(res.body.summary.activeConflictCount).toBe(1);
    expect(res.body.summary.supersededMemoryCount).toBe(1);
    expect(res.body.summary.hotspotDensityPct).toBeGreaterThan(0);
    expect(res.body.summary.recentCurationCount).toBeGreaterThan(0);
    expect(res.body.drilldowns.conflicts.items[0]).toMatchObject({
      relationId: expect.any(Number),
      sourceMemoryId: expect.any(Number),
      targetMemoryId: expect.any(Number),
      specIds: expect.arrayContaining(['spec-a', 'spec-b']),
    });
    expect(res.body.drilldowns.superseded.items[0]).toMatchObject({
      memoryId: expect.any(Number),
      supersededByMemoryId: expect.any(Number),
      sourceSpecId: 'spec-a',
    });
    expect(res.body.drilldowns.hotspots.items[0]).toMatchObject({
      scopeType: expect.stringMatching(/file|spec/),
      memoryCount: expect.any(Number),
    });
    expect(res.body.drilldowns.recentCuration.items[0]).toMatchObject({
      kind: expect.stringMatching(/review|relation/),
      summary: expect.any(String),
    });
  });

  test('returns explicit fallback metadata when AGE is unavailable', async () => {
    jest.spyOn(ageGuard, 'checkAge').mockResolvedValue(false);
    await seedOntologyData();

    const res = await get(`/api/analytics/ontology-health?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ageAvailable).toBe(false);
    expect(res.body.mode).toBe('bounded-sql-fallback');
    expect(res.body.reason).toMatch(/Apache AGE extension is unavailable/i);
  });

  test('returns explicit no-data copy when ontology data is missing', async () => {
    const res = await get(`/api/analytics/ontology-health?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.dataAvailable).toBe(false);
    expect(res.body.emptyReason).toMatch(/No ontology memories or relations recorded yet/i);
  });
});

// ─── GET /api/analytics/roi ──────────────────────────────────────────────────

describe('GET /api/analytics/roi', () => {
  test('returns 400 when workspace_id is missing', async () => {
    const res = await get('/api/analytics/roi');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspace_id');
  });

  test('returns 404 for nonexistent workspace', async () => {
    const res = await get('/api/analytics/roi?workspace_id=nonexistent');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Workspace not found');
  });

  test('returns ROI with zero stories when no data exists', async () => {
    const res = await get(`/api/analytics/roi?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.total_stories_passed).toBe(0);
    expect(res.body.estimated_hours_saved).toBe(0);
    expect(res.body.total_llm_cost).toBe(0);
    expect(res.body.roi_multiplier).toBe(0);
    expect(res.body.config).toBeDefined();
    expect(res.body.config.hours_per_story).toBe(4); // default
    expect(res.body.config.hourly_rate).toBe(75); // default
    expect(res.body.timeSeries).toEqual([]);
  });

  test('calculates ROI with passed stories and token usage', async () => {
    await seedAnalyticsData();

    const res = await get(`/api/analytics/roi?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.total_stories_passed).toBe(2); // 2 pass, 1 fail
    expect(res.body.estimated_hours_saved).toBe(8); // 2 * 4 hours
    expect(res.body.savings_value).toBe(600); // 8 hours * $75
    expect(res.body.total_llm_cost).toBeGreaterThan(0);
    expect(res.body.net_savings).toBeGreaterThan(0);
    expect(res.body.timeSeries.length).toBeGreaterThan(0);
    expect(res.body.dateRange).toBeDefined();
  });

  test('requires authentication', async () => {
    const res = await request(app).get(`/api/analytics/roi?workspace_id=${WS_ID}`);
    expect(res.status).toBe(401);
  });
});

// ─── PUT /api/analytics/roi/config ───────────────────────────────────────────

describe('PUT /api/analytics/roi/config', () => {
  test('returns 400 when workspace_id is missing', async () => {
    const res = await put('/api/analytics/roi/config', {});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspace_id');
  });

  test('returns 404 for nonexistent workspace', async () => {
    const res = await put('/api/analytics/roi/config', {
      workspace_id: 'nonexistent',
      hours_per_story: 6,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Workspace not found');
  });

  test('updates hours_per_story', async () => {
    const res = await put('/api/analytics/roi/config', {
      workspace_id: WS_ID,
      hours_per_story: 6,
    });

    expect(res.status).toBe(200);
    expect(res.body.hours_per_story).toBe(6);
  });

  test('updates hourly_rate', async () => {
    const res = await put('/api/analytics/roi/config', {
      workspace_id: WS_ID,
      hourly_rate: 120,
    });

    expect(res.status).toBe(200);
    expect(res.body.hourly_rate).toBe(120);
  });

  test('validates hours_per_story range', async () => {
    const res = await put('/api/analytics/roi/config', {
      workspace_id: WS_ID,
      hours_per_story: 150,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('hours_per_story');
  });

  test('validates hourly_rate range', async () => {
    const res = await put('/api/analytics/roi/config', {
      workspace_id: WS_ID,
      hourly_rate: 5000,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('hourly_rate');
  });

  test('persists config change to database', async () => {
    await put('/api/analytics/roi/config', {
      workspace_id: WS_ID,
      hours_per_story: 8,
      hourly_rate: 100,
    });

    const ws = await queryOne(`SELECT roi_hours_per_story, roi_hourly_rate FROM workspaces WHERE id = $1`, [WS_ID]) as any;
    expect(ws.roi_hours_per_story).toBe(8);
    expect(ws.roi_hourly_rate).toBe(100);
  });

  test('updated config affects ROI calculation', async () => {
    await seedAnalyticsData();

    // Set custom config
    await put('/api/analytics/roi/config', {
      workspace_id: WS_ID,
      hours_per_story: 10,
      hourly_rate: 100,
    });

    const res = await get(`/api/analytics/roi?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.config.hours_per_story).toBe(10);
    expect(res.body.config.hourly_rate).toBe(100);
    expect(res.body.estimated_hours_saved).toBe(20); // 2 passed * 10 hours
    expect(res.body.savings_value).toBe(2000); // 20 hours * $100
  });
});

// ─── GET /api/analytics/finops/historical (FIN-003) ──────────────────────────

describe('GET /api/analytics/finops/historical', () => {
  test('requires authentication', async () => {
    const res = await request(app).get('/api/analytics/finops/historical');
    expect(res.status).toBe(401);
  });

  test('returns empty accounting + null coverage fraction when no usage exists', async () => {
    const res = await get(`/api/analytics/finops/historical?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.accounting).toBeDefined();
    expect(res.body.accounting.meteredCostUsd).toBe(0);
    expect(res.body.accounting.allocatedSubscriptionCostUsd).toBe(0);
    expect(res.body.accounting.blendedEffectiveCostUsd).toBe(0);
    expect(res.body.accounting.coverage.totalRecords).toBe(0);
    // No metered rows → pricing coverage is null, not a misleading 1.0/0.
    expect(res.body.accounting.coverage.pricingCoverage).toBeNull();
    expect(res.body.dailyTrend).toEqual([]);
    expect(res.body.byProvider).toEqual([]);
    expect(res.body.dateRange).toBeDefined();
  });

  test('separates metered API spend, allocated subscription cost, and blended effective cost', async () => {
    // claude-opus-4-6 priced at $10/1M input, $40/1M output (metered).
    await seedPricing('claude-opus-4-6', 'anthropic', 10, 40);
    // gpt-4o is priced too, but a subscription profile overrides its billing mode.
    await seedPricing('gpt-4o', 'openai', 5, 15);
    // OpenAI runs under a $30/mo subscription, allocated evenly.
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 30, allocationBasis: 'even' });

    await seedHistoricalFinOps();

    const res = await get(`/api/analytics/finops/historical?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    const acct = res.body.accounting;

    // Metered: claude-opus row = 1M*$10/1M + 0.5M*$40/1M = 10 + 20 = $30.
    expect(acct.meteredCostUsd).toBeCloseTo(30, 2);
    // Subscription cost is allocated from the $30/mo profile (single bucket → $30).
    expect(acct.allocatedSubscriptionCostUsd).toBeCloseTo(30, 2);
    // Blended = metered + allocated.
    expect(acct.blendedEffectiveCostUsd).toBeCloseTo(60, 2);

    // Subscription usage volume is reported separately, never as direct spend.
    expect(acct.subscriptionUsage.inputTokens).toBe(200000);
    expect(acct.subscriptionUsage.outputTokens).toBe(50000);
    expect(acct.subscriptionUsage.recordCount).toBe(1);

    // byMode carries metered + subscription rollups.
    const metered = acct.byMode.find((m: any) => m.mode === 'metered_api');
    const subscription = acct.byMode.find((m: any) => m.mode === 'subscription');
    expect(metered.meteredCostUsd).toBeCloseTo(30, 2);
    expect(metered.allocatedCostUsd).toBe(0);
    expect(subscription.allocatedCostUsd).toBeCloseTo(30, 2);
    expect(subscription.meteredCostUsd).toBe(0);

    expect(acct.coverage.hasAllocatedCost).toBe(true);
    expect(acct.coverage.hasBlendedCost).toBe(true);
    expect(acct.coverage.allocationModes).toContain('even');
  });

  test('reports coverage/provenance for unpriced and profile-classified rows', async () => {
    await seedPricing('claude-opus-4-6', 'anthropic', 10, 40);
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 30, allocationBasis: 'even' });

    await seedHistoricalFinOps();

    const res = await get(`/api/analytics/finops/historical?workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);
    const cov = res.body.accounting.coverage;

    expect(cov.totalRecords).toBe(3);
    // gpt-4o classified by profile (subscription); the other two via heuristic.
    expect(cov.profileClassifiedRecords).toBe(1);
    // claude-opus priced (metered); gpt-4o unpriced here but subscription (not
    // counted as unpriced-metered); mystery model is unknown + unpriced.
    expect(cov.pricedRecords).toBe(1);
    // Only the claude-opus row is a metered row, and it is priced → coverage 1.0.
    expect(cov.pricingCoverage).toBe(1);
  });

  test('keeps run/story counts from execution rows when token history is incomplete', async () => {
    // No pricing and no profiles: cost stays explicit (zero metered), but the
    // run/story counts must still come from the execution rows themselves.
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, started_at, finished_at)
       VALUES ('forge/specs/approved/fin-sparse.json', $1, 'done', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day')
       RETURNING id`,
      [WS_ID],
    );
    // Two stories with ZERO token columns — incomplete token history.
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES
         ($1, 'US-001', $2, 'claude-opus-4-6', 0, 0, 0, NOW() - INTERVAL '2 days'),
         ($1, 'US-002', $2, 'claude-opus-4-6', 0, 0, 0, NOW() - INTERVAL '1 day')`,
      [run!.id, WS_ID],
    );

    const res = await get(`/api/analytics/finops/historical?workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);

    // Cost provenance stays explicit: no priced tokens → zero metered cost.
    expect(res.body.accounting.meteredCostUsd).toBe(0);
    expect(res.body.accounting.blendedEffectiveCostUsd).toBe(0);

    // Counts still populated from execution rows despite zero tokens.
    const ws = res.body.byWorkspace.find((w: any) => w.workspaceId === WS_ID);
    expect(ws).toBeDefined();
    expect(ws.runCount).toBe(1);
    const month = res.body.byMonth[0];
    expect(month.storyCount).toBe(2);
    expect(month.runCount).toBe(1);
  });

  test('provider, spec, and month aggregations carry billing mode + coverage', async () => {
    await seedPricing('claude-opus-4-6', 'anthropic', 10, 40);
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 30, allocationBasis: 'even' });

    await seedHistoricalFinOps();

    const res = await get(`/api/analytics/finops/historical?workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);

    const anthropic = res.body.byProvider.find((p: any) => p.provider === 'anthropic');
    const openai = res.body.byProvider.find((p: any) => p.provider === 'openai');
    expect(anthropic.billingMode).toBe('metered_api');
    expect(anthropic.meteredCostUsd).toBeCloseTo(30, 2);
    expect(openai.billingMode).toBe('subscription');
    expect(openai.allocatedSubscriptionCostUsd).toBeCloseTo(30, 2);
    expect(openai.coverage).toBeDefined();

    // Spec aggregation carries the blended figure and coverage.
    const spec = res.body.bySpec.find((s: any) => s.specSlug === 'fin-historical');
    expect(spec).toBeDefined();
    expect(spec.blendedEffectiveCostUsd).toBeCloseTo(60, 2);
    expect(spec.coverage.totalRecords).toBe(3);

    // Month aggregation likewise separates accounting modes.
    const month = res.body.byMonth.find((m: any) => m.blendedEffectiveCostUsd > 0);
    expect(month.meteredCostUsd).toBeGreaterThan(0);
    expect(month.allocatedSubscriptionCostUsd).toBeGreaterThan(0);
    expect(Array.isArray(month.byMode)).toBe(true);
  });

  test('all-provider aggregation stays compatible and reports allSubscription only when no metered spend', async () => {
    // Pure subscription window: OpenAI subscription usage with no metered rows.
    await seedSubscriptionProfile({ provider: 'openai', monthlyCostUsd: 20, allocationBasis: 'even' });
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, finished_at)
       VALUES ('forge/specs/approved/fin-sub-only.json', $1, 'done', NOW())
       RETURNING id`,
      [WS_ID],
    );
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, 'US-001', $2, 'gpt-4o', 100000, 20000, 0, NOW() - INTERVAL '1 day')`,
      [run!.id, WS_ID],
    );

    const res = await get(`/api/analytics/finops/historical?workspace_id=${WS_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.allSubscription).toBe(true);
    expect(res.body.savings).toBeNull();
    expect(res.body.accounting.meteredCostUsd).toBe(0);
    expect(res.body.accounting.allocatedSubscriptionCostUsd).toBeCloseTo(20, 2);
  });
});
