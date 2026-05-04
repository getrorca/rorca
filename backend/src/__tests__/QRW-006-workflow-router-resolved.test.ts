/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-006: API — GET /api/workflow-router/resolved/:workflowId returns full fallback chain
 *
 * Acceptance criteria:
 *   (1) GET /api/workflow-router/resolved/pipeline_execution returns 200 with ResolvedWorkflowConfig shape
 *   (2) When DB row has explicit values, resolved config returns those (not env var overrides)
 *   (3) apiKey is masked (first 4 + last 4 chars) or null — never returned in full
 *   (4) GET /api/workflow-router/resolved/spec_generation returns runtime: 'native'
 *   (5) GET /api/workflow-router/resolved/invalid returns 404 or 422
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

    let paramIdx = 1;
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

  // SELECT from agent_config (Layer 2 fallback) — no row by default
  if (sql.includes('agent_config')) {
    return undefined;
  }

  return undefined;
});

const mockQuery = jest.fn().mockImplementation(async (sql: string) => {
  if (sql.includes('workflow_configs') && sql.includes('SELECT')) {
    return Object.values(workflowStore).sort((a, b) => a.workflow_id.localeCompare(b.workflow_id));
  }
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

// Vault mock — controlled per-test via mockGetVaultKey
const mockGetVaultKey = jest.fn().mockResolvedValue(null);

jest.mock('../routes/vault', () => ({
  getVaultKey: (...args: unknown[]) => mockGetVaultKey(...args),
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
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  mockGetVaultKey.mockResolvedValue(null);
});

afterAll(() => {
  process.env = originalEnv;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('QRW-006: GET /api/workflow-router/resolved/:workflowId returns full fallback chain', () => {
  let app: express.Application;

  beforeAll(async () => {
    app = await buildApp();
  });

  // ── (1) Response shape ────────────────────────────────────────────────────

  describe('AC1: GET /api/workflow-router/resolved/pipeline_execution returns 200 with ResolvedWorkflowConfig shape', () => {
    it('returns 200 with all required fields present', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('workflowId');
      expect(res.body).toHaveProperty('runtime');
      expect(res.body).toHaveProperty('provider');
      expect(res.body).toHaveProperty('model');
      expect(res.body).toHaveProperty('apiKey');
      expect(res.body).toHaveProperty('baseUrl');
    });

    it('workflowId field equals pipeline_execution', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.workflowId).toBe('pipeline_execution');
    });

    it('runtime is a non-empty string', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(typeof res.body.runtime).toBe('string');
      expect(res.body.runtime.length).toBeGreaterThan(0);
    });

    it('provider is a non-empty string', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(typeof res.body.provider).toBe('string');
      expect(res.body.provider.length).toBeGreaterThan(0);
    });

    it('model is string or null', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.model === null || typeof res.body.model === 'string').toBe(true);
    });

    it('apiKey is string or null', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.apiKey === null || typeof res.body.apiKey === 'string').toBe(true);
    });

    it('baseUrl is string or null', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.baseUrl === null || typeof res.body.baseUrl === 'string').toBe(true);
    });
  });

  // ── (2) DB values take priority over env vars ─────────────────────────────

  describe('AC2: When DB row has explicit values, resolved config returns those (not env var overrides)', () => {
    it('DB runtime=opencode overrides RORCA_AGENT=claude', async () => {
      // Set DB to opencode
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
        updated_at: new Date().toISOString(),
      };
      // Set env to different value
      process.env.RORCA_AGENT = 'claude';
      process.env.RORCA_MODEL = 'anthropic/claude-sonnet-4-5-20250929';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('opencode');
      expect(res.body.provider).toBe('openrouter');
      expect(res.body.model).toBe('openrouter/auto');
    });

    it('DB runtime=codex overrides RORCA_AGENT=opencode', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'codex',
        provider: 'openai-compat',
        model: 'gpt-4o',
        updated_at: new Date().toISOString(),
      };
      process.env.RORCA_AGENT = 'opencode';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('codex');
    });

    it('DB model overrides RORCA_MODEL env var', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v3',
        updated_at: new Date().toISOString(),
      };
      process.env.RORCA_MODEL = 'openai/gpt-4o';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.model).toBe('deepseek/deepseek-v3');
    });

    it('env vars are used as fallback when DB row has seed defaults (claude-cli)', async () => {
      // Default seed has runtime='claude', provider='claude-cli' — env vars fill model gap
      process.env.RORCA_MODEL = 'openai/gpt-4o';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      // DB runtime takes priority
      expect(res.body.runtime).toBe('claude');
      // Model filled from env (DB has null)
      expect(res.body.model).toBe('openai/gpt-4o');
    });

    it('after PUT updates DB row, resolved returns updated values not env defaults', async () => {
      // Simulate what QRW-005 PUT does: update the store
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v3.2-speciale',
        updated_at: new Date().toISOString(),
      };

      // Even with env set to claude, DB wins
      process.env.RORCA_AGENT = 'claude';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('opencode');
      expect(res.body.provider).toBe('openrouter');
      expect(res.body.model).toBe('deepseek/deepseek-v3.2-speciale');
    });

    it('after resetting DB to defaults, env vars are picked up as fallback', async () => {
      // Reset DB to seeded defaults (runtime='claude', provider='claude-cli', model=null)
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'claude',
        provider: 'claude-cli',
        model: null,
        updated_at: new Date().toISOString(),
      };

      // Set env vars — model should come from env since DB has null
      process.env.RORCA_MODEL = 'openai/gpt-4o-mini';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      // DB runtime is claude (default seed)
      expect(res.body.runtime).toBe('claude');
      // Model from env since DB is null
      expect(res.body.model).toBe('openai/gpt-4o-mini');
    });
  });

  // ── (3) apiKey masking ────────────────────────────────────────────────────

  describe('AC3: apiKey is masked or null — never returned in full', () => {
    it('apiKey is null when provider=claude-cli (subscription auth, no key needed)', async () => {
      // Default seed: runtime='claude', provider='claude-cli'
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.apiKey).toBeNull();
    });

    it('apiKey is masked (first 4 + last 4) when resolved from OPENROUTER_API_KEY env var', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: 'openrouter/auto',
        updated_at: new Date().toISOString(),
      };
      // Use env var path (vault requires userId which is absent without auth)
      process.env.OPENROUTER_API_KEY = 'sk-or-test-abcd1234efgh5678';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      // Must not be the full key
      expect(res.body.apiKey).not.toBe('sk-or-test-abcd1234efgh5678');
      // Must be masked (4 chars + ... + 4 chars)
      expect(res.body.apiKey).toBe('sk-o...5678');
    });

    it('apiKey is masked when resolved from env var ANTHROPIC_API_KEY', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'anthropic',
        model: null,
        updated_at: new Date().toISOString(),
      };
      process.env.ANTHROPIC_API_KEY = 'sk-ant-abcdefgh12345678';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      // Must not return the full key
      expect(res.body.apiKey).not.toBe('sk-ant-abcdefgh12345678');
      // Must be a masked string
      expect(typeof res.body.apiKey).toBe('string');
      expect(res.body.apiKey).toMatch(/\.\.\./);
    });

    it('apiKey is masked when resolved from env var OPENROUTER_API_KEY', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: null,
        updated_at: new Date().toISOString(),
      };
      process.env.OPENROUTER_API_KEY = 'sk-or-mykey1234abcd5678';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.apiKey).not.toBe('sk-or-mykey1234abcd5678');
      expect(res.body.apiKey).toMatch(/\.\.\./);
    });

    it('apiKey is null when provider needs a key but no vault or env key exists', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: null,
        updated_at: new Date().toISOString(),
      };
      // No vault key, no env var

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.apiKey).toBeNull();
    });

    it('masked apiKey starts with the first 4 chars of the real key', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: null,
        updated_at: new Date().toISOString(),
      };
      // Use env var path (vault requires userId which is absent without auth middleware)
      process.env.OPENROUTER_API_KEY = 'sk-or-XXXX1234YYYY5678';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.apiKey).toMatch(/^sk-o/);  // first 4 chars
      expect(res.body.apiKey).toMatch(/5678$/);  // last 4 chars
    });

    it('short keys (<= 8 chars) are fully masked as ****', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'anthropic',
        model: null,
        updated_at: new Date().toISOString(),
      };
      // Use env var path — short key
      process.env.ANTHROPIC_API_KEY = 'short';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.apiKey).toBe('****');
    });
  });

  // ── (4) spec_generation returns runtime: 'native' ─────────────────────────

  describe('AC4: GET /api/workflow-router/resolved/spec_generation returns runtime: native', () => {
    it('returns 200 with runtime=native for spec_generation', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/spec_generation');

      expect(res.status).toBe(200);
      expect(res.body.workflowId).toBe('spec_generation');
      expect(res.body.runtime).toBe('native');
    });

    it('spec_generation runtime stays native even when RORCA_AGENT=claude is set', async () => {
      process.env.RORCA_AGENT = 'claude';

      const res = await request(app).get('/api/workflow-router/resolved/spec_generation');

      expect(res.status).toBe(200);
      // DB seed has runtime='native' — DB wins over env
      expect(res.body.runtime).toBe('native');
    });

    it('spec_generation returns correct shape', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/spec_generation');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('workflowId', 'spec_generation');
      expect(res.body).toHaveProperty('runtime');
      expect(res.body).toHaveProperty('provider');
      expect(res.body).toHaveProperty('model');
      expect(res.body).toHaveProperty('apiKey');
      expect(res.body).toHaveProperty('baseUrl');
    });

    it('GET /api/workflow-router/resolved/memory_consolidation returns runtime: native', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/memory_consolidation');

      expect(res.status).toBe(200);
      expect(res.body.workflowId).toBe('memory_consolidation');
      expect(res.body.runtime).toBe('native');
    });

    it('memory_consolidation runtime stays native even when RORCA_AGENT=opencode is set', async () => {
      process.env.RORCA_AGENT = 'opencode';

      const res = await request(app).get('/api/workflow-router/resolved/memory_consolidation');

      expect(res.status).toBe(200);
      expect(res.body.runtime).toBe('native');
    });
  });

  // ── (5) Invalid workflowId returns 404 ───────────────────────────────────

  describe('AC5: GET /api/workflow-router/resolved/invalid returns 404 or 422', () => {
    it('returns 4xx for workflowId=invalid', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/invalid');

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    it('returns 404 specifically for unknown workflowId (route uses NotFoundError)', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/invalid');

      expect(res.status).toBe(404);
    });

    it('error body has an error property for invalid workflowId', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/invalid');

      expect(res.body).toHaveProperty('error');
    });

    it('returns 404 for completely made up workflowId', async () => {
      const res = await request(app).get('/api/workflow-router/resolved/not_a_real_workflow');

      expect(res.status).toBe(404);
    });

    it('returns 404 for sql-injection-style workflowId', async () => {
      const res = await request(app).get(`/api/workflow-router/resolved/${encodeURIComponent("'; DROP TABLE workflow_configs; --")}`);

      expect(res.status).toBe(404);
    });
  });

  // ── Bonus: all three valid workflowIds return 200 ─────────────────────────

  describe('All 3 valid workflowIds return 200', () => {
    it.each(['spec_generation', 'pipeline_execution', 'memory_consolidation'])(
      'GET /api/workflow-router/resolved/%s returns 200',
      async (workflowId) => {
        const res = await request(app).get(`/api/workflow-router/resolved/${workflowId}`);

        expect(res.status).toBe(200);
        expect(res.body.workflowId).toBe(workflowId);
      },
    );
  });

  // ── baseUrl propagation ───────────────────────────────────────────────────

  describe('baseUrl propagation', () => {
    it('baseUrl is null when key is resolved from env var (env path never provides baseUrl)', async () => {
      // Env var path only returns { apiKey, baseUrl: null } — baseUrl requires vault
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openai-compat',
        model: 'gpt-4o',
        updated_at: new Date().toISOString(),
      };
      process.env.OPENAI_API_KEY = 'sk-openai-compat-abc12345xyz67890';

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      // Env var path sets baseUrl to null (vault required for custom baseUrl)
      expect(res.body.baseUrl).toBeNull();
    });

    it('baseUrl is null when provider=claude-cli (no API key path)', async () => {
      // Default seed: runtime='claude', provider='claude-cli'
      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.baseUrl).toBeNull();
    });

    it('baseUrl is null when no key source available', async () => {
      workflowStore['pipeline_execution'] = {
        workflow_id: 'pipeline_execution',
        runtime: 'opencode',
        provider: 'openrouter',
        model: null,
        updated_at: new Date().toISOString(),
      };
      // No vault, no env var

      const res = await request(app).get('/api/workflow-router/resolved/pipeline_execution');

      expect(res.status).toBe(200);
      expect(res.body.baseUrl).toBeNull();
    });
  });
});
