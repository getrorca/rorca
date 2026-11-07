/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-005: API — PUT /api/workflow-router/:workflowId validates and persists
 *
 * Acceptance criteria:
 *   (1) PUT /api/workflow-router/pipeline_execution with valid body returns 200 and persists changes
 *   (2) GET /api/workflow-router reflects the updated pipeline_execution values after PUT
 *   (3) PUT /api/workflow-router/spec_generation with runtime != 'native' returns 422
 *   (4) PUT /api/workflow-router/invalid_workflow returns 422 (invalid workflowId)
 *   (5) Zod validation catches missing/malformed fields and returns structured error
 */

// ── DB mock — must be declared before imports ────────────────────────────────

/** In-memory store keyed by workflow_id */
const workflowStore: Record<string, {
  workflow_id: string;
  runtime: string;
  provider: string;
  model: string | null;
  updated_at: string;
}> = {};

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

jest.mock('../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
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
  Object.keys(workflowStore).forEach((k) => delete workflowStore[k]);
  seedDefaults();
  delete process.env.RORCA_AGENT;
  delete process.env.RORCA_MODEL;
  delete process.env.SPEC_PROVIDER;
});

afterAll(() => {
  process.env = originalEnv;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('QRW-005: PUT /api/workflow-router/:workflowId validates and persists', () => {
  let app: express.Application;

  beforeAll(async () => {
    app = await buildApp();
  });

  // ── (1) PUT returns 200 and persists changes ──────────────────────────────

  describe('AC1: PUT /api/workflow-router/pipeline_execution with valid body returns 200', () => {
    it('returns 200 with updated row matching the sent values', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({
          runtime: 'opencode',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v3.2-speciale',
        });

      expect(res.status).toBe(200);
      expect(res.body.workflowId).toBe('pipeline_execution');
      expect(res.body.runtime).toBe('opencode');
      expect(res.body.provider).toBe('openrouter');
      expect(res.body.model).toBe('deepseek/deepseek-v3.2-speciale');
      expect(res.body.updatedAt).toBeDefined();
    });
  });

  // ── (2) GET reflects updated values ──────────────────────────────────────

  describe('AC2: GET /api/workflow-router reflects updated pipeline_execution after PUT', () => {
    it('GET returns the model set by PUT in the pipeline_execution row', async () => {
      // First, PUT the new values
      const putRes = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({
          runtime: 'opencode',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v3.2-speciale',
        });
      expect(putRes.status).toBe(200);

      // Then GET all configs
      const getRes = await request(app).get('/api/workflow-router');
      expect(getRes.status).toBe(200);
      expect(getRes.body).toBeInstanceOf(Array);
      expect(getRes.body).toHaveLength(3);

      const pipelineRow = getRes.body.find((r: any) => r.workflowId === 'pipeline_execution');
      expect(pipelineRow).toBeDefined();
      expect(pipelineRow.runtime).toBe('opencode');
      expect(pipelineRow.provider).toBe('openrouter');
      expect(pipelineRow.model).toBe('deepseek/deepseek-v3.2-speciale');
    });
  });

  // ── (3) spec_generation rejects non-native runtime ───────────────────────

  describe('AC3: PUT /api/workflow-router/spec_generation with runtime != native returns 422', () => {
    it('returns 422 when spec_generation runtime is opencode', async () => {
      const res = await request(app)
        .put('/api/workflow-router/spec_generation')
        .send({ runtime: 'opencode' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/spec_generation.*only supports runtime.*native/i);
    });

    it('returns 422 when spec_generation runtime is claude', async () => {
      const res = await request(app)
        .put('/api/workflow-router/spec_generation')
        .send({ runtime: 'claude' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/spec_generation.*only supports runtime.*native/i);
    });

    it('returns 422 when spec_generation runtime is codex', async () => {
      const res = await request(app)
        .put('/api/workflow-router/spec_generation')
        .send({ runtime: 'codex' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/spec_generation.*only supports runtime.*native/i);
    });

    it('returns 200 when spec_generation runtime is native (constraint satisfied)', async () => {
      const res = await request(app)
        .put('/api/workflow-router/spec_generation')
        .send({ runtime: 'native', provider: 'anthropic' });

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('native');
    });
  });

  // ── (4) invalid workflowId returns 422 ───────────────────────────────────

  describe('AC4: PUT /api/workflow-router/invalid_workflow returns 422', () => {
    it('returns 422 for invalid_workflow workflowId', async () => {
      const res = await request(app)
        .put('/api/workflow-router/invalid_workflow')
        .send({ runtime: 'native' });

      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/invalid workflowid.*invalid_workflow/i);
    });

    it('returns 422 for arbitrary unknown workflowId strings', async () => {
      const res = await request(app)
        .put('/api/workflow-router/completely_made_up')
        .send({ runtime: 'opencode' });

      expect(res.status).toBe(422);
    });

    it('error body includes the invalid workflowId value', async () => {
      const res = await request(app)
        .put('/api/workflow-router/invalid_workflow')
        .send({ runtime: 'native' });

      expect(res.status).toBe(422);
      expect(res.body).toHaveProperty('error');
      // Should mention the invalid value in the error message
      expect(res.body.error).toContain('invalid_workflow');
    });
  });

  // ── (5) Zod validation catches malformed fields ───────────────────────────

  describe('AC5: Zod validation catches missing/malformed fields', () => {
    it('returns 400 for invalid runtime enum value', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ runtime: 'totally_invalid_runtime' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 400 for empty provider string', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ provider: '' });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 400 for non-string runtime value (number)', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ runtime: 42 });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });

    it('returns 200 for empty body (all fields optional — partial update allowed)', async () => {
      // All fields in UpdateWorkflowConfigSchema are optional, so {} is valid
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({});

      // Empty body is valid (no fields to update, but SET updated_at=NOW() still runs)
      expect(res.status).toBe(200);
    });

    it('returns 400 for boolean runtime (wrong type)', async () => {
      const res = await request(app)
        .put('/api/workflow-router/pipeline_execution')
        .send({ runtime: true });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });
});
