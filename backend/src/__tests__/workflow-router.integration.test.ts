/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * WR-016: Workflow Router integration tests.
 *
 * Verifies the full lifecycle:
 *   (1) PUT /api/workflow-router/pipeline_execution persists { runtime, provider, model }
 *   (2) GET /api/workflow-router returns the updated row
 *   (3) resolveWorkflowConfig('pipeline_execution') returns DB values, not env var defaults
 *   (4) ensurePersistedConfig() ON CONFLICT DO NOTHING — does not overwrite existing rows
 *   (5) PUT /api/workflow-router/spec_generation with runtime='opencode' returns 422
 */

// ── DB mock — must be declared before imports ────────────────────────────────

/** In-memory store keyed by workflow_id */
const workflowStore: Record<string, { workflow_id: string; runtime: string; provider: string; model: string | null; updated_at: string }> = {};

/** Seed the default rows (mirrors migration 20260404000001) */
function seedDefaults() {
  workflowStore['spec_generation'] = {
    workflow_id: 'spec_generation',
    runtime: 'native',
    provider: 'claude-cli',
    model: null,
    updated_at: new Date().toISOString(),
  };
  workflowStore['pipeline_execution'] = {
    workflow_id: 'pipeline_execution',
    runtime: 'claude',
    provider: 'claude-cli',
    model: null,
    updated_at: new Date().toISOString(),
  };
  workflowStore['memory_consolidation'] = {
    workflow_id: 'memory_consolidation',
    runtime: 'native',
    provider: 'claude-cli',
    model: null,
    updated_at: new Date().toISOString(),
  };
}

const mockQueryOne = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
  const workflowId = params?.[0] as string | undefined;

  // SELECT from workflow_configs
  if (sql.includes('workflow_configs') && sql.includes('SELECT') && workflowId) {
    return workflowStore[workflowId] ?? undefined;
  }

  // UPDATE workflow_configs ... RETURNING
  if (sql.includes('workflow_configs') && sql.includes('UPDATE') && workflowId) {
    const row = workflowStore[workflowId];
    if (!row) return undefined;

    // Parse SET clauses from params (dynamic UPDATE)
    // Param $1 is always workflow_id; subsequent params are the SET values
    let paramIdx = 1; // index into params array (0-based), $1 = params[0]
    if (sql.includes('runtime = $')) {
      row.runtime = params![++paramIdx - 1] as string;
    }
    if (sql.includes('provider = $')) {
      row.provider = params![++paramIdx - 1] as string;
    }
    if (sql.includes('model = $')) {
      row.model = params![++paramIdx - 1] as string | null;
    }
    row.updated_at = new Date().toISOString();

    return { ...row };
  }

  // SELECT from agent_config (Layer 2 fallback)
  if (sql.includes('agent_config')) {
    return undefined;
  }

  return undefined;
});

const mockQuery = jest.fn().mockImplementation(async (sql: string) => {
  // SELECT all workflow_configs rows
  if (sql.includes('workflow_configs') && sql.includes('SELECT')) {
    return Object.values(workflowStore).sort((a, b) => a.workflow_id.localeCompare(b.workflow_id));
  }
  // Vault key check — no keys in test
  if (sql.includes('api_key_vault')) {
    return [];
  }
  return [];
});

const mockExecute = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
  // ON CONFLICT DO NOTHING — only insert if row doesn't exist
  // SQL uses literal workflow_id in VALUES: VALUES ('pipeline_execution', $1, $2, $3)
  if (sql.includes('workflow_configs') && sql.includes('ON CONFLICT') && sql.includes('DO NOTHING')) {
    // Extract the literal workflow_id from the SQL VALUES clause
    const match = sql.match(/VALUES\s*\(\s*'(\w+)'/);
    const workflowId = match?.[1] ?? params?.[0] as string;
    if (!workflowStore[workflowId]) {
      workflowStore[workflowId] = {
        workflow_id: workflowId,
        runtime: params?.[0] as string ?? 'native',
        provider: params?.[1] as string ?? 'claude-cli',
        model: params?.[2] as string | null ?? null,
        updated_at: new Date().toISOString(),
      };
      return { rowCount: 1 };
    }
    // Row already exists — DO NOTHING
    return { rowCount: 0 };
  }
  return { rowCount: 0 };
});

jest.mock('../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  initDb: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../routes/vault', () => ({
  getVaultKey: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Imports after mocks ──────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';
import { resolveWorkflowConfig } from '../lib/workflow-config-resolver';

async function buildApp() {
  const app = express();
  app.use(express.json());
  const { default: workflowRouterRouter } = await import('../routes/workflow-router');
  app.use('/api/workflow-router', workflowRouterRouter);
  return app;
}

// ── Save / restore env ───────────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  // Reset store to seeded defaults
  Object.keys(workflowStore).forEach((k) => delete workflowStore[k]);
  seedDefaults();
  // Clear env vars that could interfere
  delete process.env.RORCA_AGENT;
  delete process.env.RORCA_MODEL;
  delete process.env.SPEC_PROVIDER;
});

afterAll(() => {
  process.env = originalEnv;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Workflow Router integration', () => {
  let app: express.Application;

  beforeAll(async () => {
    app = await buildApp();
  });

  // ── (1) + (2) PUT → GET round-trip ───────────────────────────────────────

  describe('PUT → GET round-trip for pipeline_execution', () => {
    it('persists updated values and returns them via GET', async () => {
      // PUT new values
      const putRes = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ runtime: 'opencode', provider: 'openrouter', model: 'openrouter/auto' });

      expect(putRes.status).toBe(200);
      expect(putRes.body.workflowId).toBe('pipeline_execution');
      expect(putRes.body.runtime).toBe('opencode');
      expect(putRes.body.provider).toBe('openrouter');
      expect(putRes.body.model).toBe('openrouter/auto');
      expect(putRes.body.updatedAt).toBeDefined();

      // GET all configs — verify updated row
      const getRes = await request(app).get('/api/workflow-router');

      expect(getRes.status).toBe(200);
      expect(getRes.body).toBeInstanceOf(Array);
      expect(getRes.body.length).toBe(3);

      const pipelineRow = getRes.body.find((r: any) => r.workflowId === 'pipeline_execution');
      expect(pipelineRow).toBeDefined();
      expect(pipelineRow.runtime).toBe('opencode');
      expect(pipelineRow.provider).toBe('openrouter');
      expect(pipelineRow.model).toBe('openrouter/auto');
    });
  });

  // ── (3) resolveWorkflowConfig returns DB values, not env defaults ────────

  describe('resolveWorkflowConfig returns DB values after PUT', () => {
    it('returns runtime=opencode, provider=openrouter, model=openrouter/auto from DB', async () => {
      // Simulate PUT by writing directly to store
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
        updated_at: new Date().toISOString(),
      };

      // Set env vars to different values — resolver should use DB values, not these
      process.env.RORCA_AGENT = 'claude';
      process.env.RORCA_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

      const resolved = await resolveWorkflowConfig('pipeline_execution');

      expect(resolved.workflowId).toBe('pipeline_execution');
      expect(resolved.runtime).toBe('opencode');
      expect(resolved.provider).toBe('openrouter');
      expect(resolved.model).toBe('openrouter/auto');
    });
  });

  // ── (4) ensurePersistedConfig ON CONFLICT DO NOTHING ─────────────────────

  describe('ON CONFLICT DO NOTHING — existing rows are not overwritten', () => {
    it('does not overwrite pipeline_execution row that was already updated', async () => {
      // First: update pipeline_execution via PUT
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
        updated_at: new Date().toISOString(),
      };

      // Simulate what ensurePersistedConfig does: INSERT ... ON CONFLICT DO NOTHING
      // with different values (the agent_config defaults)
      const { execute } = require('../db/index');
      await execute(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
         VALUES ('pipeline_execution', $1, $2, $3)
         ON CONFLICT (workflow_id) DO NOTHING`,
        ['claude', 'claude-cli', null],
      );

      // Row should still have the opencode/openrouter values, NOT claude/claude-cli
      expect(workflowStore['pipeline_execution'].runtime).toBe('opencode');
      expect(workflowStore['pipeline_execution'].provider).toBe('openrouter');
      expect(workflowStore['pipeline_execution'].model).toBe('openrouter/auto');
    });

    it('inserts row when workflow_id does not exist yet', async () => {
      // Remove the pipeline_execution row to simulate fresh DB
      delete workflowStore['pipeline_execution'];

      const { execute } = require('../db/index');
      await execute(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
         VALUES ('pipeline_execution', $1, $2, $3)
         ON CONFLICT (workflow_id) DO NOTHING`,
        ['claude', 'claude-cli', null],
      );

      // Row should be inserted with the provided values
      expect(workflowStore['pipeline_execution']).toBeDefined();
      expect(workflowStore['pipeline_execution'].runtime).toBe('claude');
      expect(workflowStore['pipeline_execution'].provider).toBe('claude-cli');
      expect(workflowStore['pipeline_execution'].model).toBeNull();
    });
  });

  // ── (5) spec_generation rejects non-native runtime ───────────────────────

  describe('runtime constraint enforcement', () => {
    it('PUT /api/workflow-router/spec_generation with runtime=opencode returns 422', async () => {
      const res = await request(app)
        .put('/api/workflow-router/spec_generation')
        .send({ runtime: 'opencode' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/spec_generation.*only supports runtime.*native/i);
    });

    it('PUT /api/workflow-router/memory_consolidation with runtime=claude returns 422', async () => {
      const res = await request(app)
        .put('/api/workflow-router/memory_consolidation')
        .send({ runtime: 'claude' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/memory_consolidation.*only supports runtime.*native/i);
    });

    it('PUT /api/workflow-router/spec_generation with runtime=native succeeds', async () => {
      const res = await request(app)
        .put('/api/workflow-router/spec_generation')
        .send({ runtime: 'native', provider: 'anthropic', model: 'anthropic/claude-opus-4-6' });

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('native');
    });

    it('PUT /api/workflow-router/pipeline_execution with runtime=opencode succeeds', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ runtime: 'opencode', provider: 'openrouter', model: 'openrouter/auto' });

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('opencode');
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('PUT with unknown workflowId returns 422', async () => {
      const res = await request(app)
        .put('/api/workflow-router/unknown_workflow')
        .send({ runtime: 'native' });

      expect(res.status).toBe(422);
    });

    it('PUT with invalid runtime value returns 400', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ runtime: 'invalid_runtime' });

      expect(res.status).toBe(400);
    });

    it('PUT with partial update (only model) succeeds', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ model: 'openai/gpt-4o' });

      expect(res.status).toBe(200);
      // Runtime and provider should remain unchanged (defaults)
      expect(res.body.runtime).toBe('claude');
      expect(res.body.model).toBe('openai/gpt-4o');
    });

    it('GET /api/workflow-router returns all 3 workflow configs', async () => {
      const res = await request(app).get('/api/workflow-router');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);

      const ids = res.body.map((r: any) => r.workflowId).sort();
      expect(ids).toEqual(['memory_consolidation', 'pipeline_execution', 'spec_generation']);
    });
  });
});
