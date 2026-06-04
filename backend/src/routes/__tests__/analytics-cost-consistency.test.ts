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
import { execute, queryOne } from '../../db/index';

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
let authToken: string;
let authId: string;

const WS_ALPHA = 'workspace-alpha';
const WS_RORCA = 'rorca';

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-analytics-costs-'));
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';

  const serverMod = require('../../server');
  app = serverMod.default;
  authId = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1_000_000_000_000).toString().padStart(12, '0')}`;
  authToken = await getAuthToken(app, { authId });

  await execute(`DELETE FROM token_usage WHERE workspace_id IN ($1, $2)`, [WS_ALPHA, WS_RORCA]);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id IN ($1, $2))`, [WS_ALPHA, WS_RORCA]);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id IN ($1, $2)`, [WS_ALPHA, WS_RORCA]);
  await execute(`DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)`, [WS_ALPHA, WS_RORCA]);
  await execute(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [WS_ALPHA, WS_RORCA]);

  for (const workspaceId of [WS_ALPHA, WS_RORCA]) {
    const workspacePath = path.join(tmpDir, workspaceId);
    fs.mkdirSync(workspacePath, { recursive: true });
    await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`, [workspaceId, workspaceId, workspacePath]);
    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'owner')
       ON CONFLICT (workspace_id, user_auth_id) DO NOTHING`,
      [workspaceId, authId],
    );
  }

  await execute(
    `INSERT INTO model_pricing (model_id, provider, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES
       ('claude-sonnet-4-5-20250929', 'anthropic', 0.003, 0.015, 3.0, 15.0),
       ('pi/openai/gpt-5.4', 'openai-codex', 0.002, 0.008, 2.0, 8.0)
     ON CONFLICT (model_id) DO UPDATE
       SET provider = EXCLUDED.provider,
           input_cost_per_1k = EXCLUDED.input_cost_per_1k,
           output_cost_per_1k = EXCLUDED.output_cost_per_1k,
           input_cost_per_1m = EXCLUDED.input_cost_per_1m,
           output_cost_per_1m = EXCLUDED.output_cost_per_1m`
  );

  for (let i = 1; i <= 25; i++) {
    const specSlug = `workspace-alpha-spec-${String(i).padStart(2, '0')}`;
    const finishedAt = new Date(Date.UTC(2026, 4, i, 12, 0, 0)).toISOString();
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, finished_at)
       VALUES ($1, $2, 'done', $3, $4, $5)
       RETURNING id`,
      [`forge/specs/approved/${specSlug}.json`, WS_ALPHA, i % 2 === 0 ? 'claude' : 'pi', i % 2 === 0 ? 'claude' : 'pi', finishedAt],
    );
    const model = i % 2 === 0 ? 'claude-sonnet-4-5-20250929' : 'pi/openai/gpt-5.4';
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, 'US-001', $2, $3, $4, $5, 0, $6)`,
      [run!.id, WS_ALPHA, model, 1000 * i, 200 * i, finishedAt],
    );
  }

  for (let i = 1; i <= 3; i++) {
    const specSlug = `rorca-spec-${String(i).padStart(2, '0')}`;
    const finishedAt = new Date(Date.UTC(2026, 5, i, 12, 0, 0)).toISOString();
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, agent, agent_type, finished_at)
       VALUES ($1, $2, 'done', 'pi', 'pi', $3)
       RETURNING id`,
      [`forge/specs/approved/${specSlug}.json`, WS_RORCA, finishedAt],
    );
    await execute(
      `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd, recorded_at)
       VALUES ($1, 'US-001', $2, 'pi/openai/gpt-5.4', $3, $4, 0, $5)`,
      [run!.id, WS_RORCA, 2000 * i, 500 * i, finishedAt],
    );
  }
});

afterEach(async () => {
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

describe('analytics cost consistency', () => {
  test('usage totals compute cost from pricing even when raw cost_usd is zero', async () => {
    const res = await get(`/api/analytics/usage?workspace_id=${WS_ALPHA}&from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.999Z`);

    expect(res.status).toBe(200);
    expect(res.body.totals.total_cost_usd).toBeGreaterThan(0);
  });

  test('cost breakdown by spec returns the last 20 specs newest-first for workspace alpha', async () => {
    const res = await get(`/api/analytics/costs?workspace_id=${WS_ALPHA}&group_by=spec&from=2026-05-01T00:00:00.000Z&to=2026-05-31T23:59:59.999Z`);

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toHaveLength(20);
    expect(res.body.breakdown[0].group_key).toBe('workspace-alpha-spec-25');
    expect(res.body.breakdown[19].group_key).toBe('workspace-alpha-spec-06');
    expect(res.body.breakdown[0].total_cost_usd).toBeGreaterThan(0);
  });

  test('cost breakdown stays workspace-scoped for rorca and includes pi/provider-computed cost', async () => {
    const res = await get(`/api/analytics/costs?workspace_id=${WS_RORCA}&group_by=spec&from=2026-06-01T00:00:00.000Z&to=2026-06-30T23:59:59.999Z`);

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toHaveLength(3);
    expect(res.body.breakdown.map((row: any) => row.group_key)).toEqual([
      'rorca-spec-03',
      'rorca-spec-02',
      'rorca-spec-01',
    ]);
    expect(res.body.totals.total_cost_usd).toBeGreaterThan(0);
  });
});
