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

const WS_ID = 'ws-analytics';

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-analytics-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
process.env.AUTH_REQUIRED = 'true';

  const serverMod = require('../../server');
  app = serverMod.default;
  authId = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1_000_000_000_000).toString().padStart(12, '0')}`;
  authToken = await getAuthToken(app, { authId });

  // Create workspace directory and DB record
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });
  // Clean analytics-specific tables so tests run against a clean state regardless of prior test files
  await execute(`DELETE FROM token_usage WHERE workspace_id = $1`, [WS_ID]);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = $1`, [WS_ID]);
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, 'Analytics WS', $2) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [WS_ID, wsDir]);
  await execute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2::uuid, 'owner')
     ON CONFLICT (workspace_id, user_auth_id) DO NOTHING`,
    [WS_ID, authId],
  );
});

afterEach(async () => {
  // Use require() to get the CURRENT module instance (post-resetModules) for cleanup
  try {
    const db = require('../../db/index');
    await db.execute('TRUNCATE token_usage, story_results, pipeline_runs, workspace_members, workspaces, users CASCADE');
    await db.closePool();
  } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

describe('GET /api/analytics/pi-providers', () => {
  test('returns empty array when no pi runs exist', async () => {
    const res = await get(`/api/analytics/pi-providers?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('aggregates usage by pi provider', async () => {
    await seedPiProviderData(WS_ID, authId);

    const res = await get(`/api/analytics/pi-providers?workspace_id=${WS_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const openai = res.body.find((row: any) => row.provider === 'openai');
    const omlx = res.body.find((row: any) => row.provider === 'omlx');

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
  });

  test('applies workspace RLS via withUserClient', async () => {
    const hiddenWorkspaceId = 'ws-analytics-hidden';
    await seedPiProviderData(WS_ID, authId);
    await seedPiProviderData(hiddenWorkspaceId);

    const res = await get('/api/analytics/pi-providers');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body.find((row: any) => row.provider === 'openai')?.totalStories).toBe(2);
    expect(res.body.find((row: any) => row.provider === 'omlx')?.totalStories).toBe(1);
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
