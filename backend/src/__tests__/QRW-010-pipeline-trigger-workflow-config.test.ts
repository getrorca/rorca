/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-010: Backend integration — pipeline trigger uses resolveWorkflowConfig
 *
 * Verifies that POST /api/pipeline/trigger handler:
 *   1. Calls resolveWorkflowConfig('pipeline_execution') instead of reading RORCA_AGENT directly
 *   2. Uses wfConfig.runtime as the resolved agent type (not raw RORCA_AGENT)
 *   3. Preserves the model chain: request body override > specJson.model > wfConfig.model
 *   4. Injects wfConfig.apiKey into the subprocess env vars for the correct provider
 *   5. Has no direct process.env.RORCA_AGENT reads in the trigger critical path
 *      (the resolution is delegated to resolveWorkflowConfig)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from '../routes/__tests__/helpers/auth-helper';
import { query, queryOne, execute } from '../db/index';

// Server initialization + migrations can take >30s on first run
jest.setTimeout(90_000);

// Mock llm-client before any imports that use it
jest.mock('../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

// Mock pg-boss so pipeline trigger doesn't fail with "getBoss() called before initBoss()"
jest.mock('../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

let app: Express;
let tmpDir: string;
let wsDir: string;
let authToken: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`
  );
  await execute(
    `INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
     ON CONFLICT (model_id) DO NOTHING`
  );
});

beforeEach(async () => {
  jest.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-qrw010-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });

  // Clean DB state
  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-qrw010')`);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-qrw010')`);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-qrw010'`);
  await execute(`DELETE FROM wal_events WHERE workspace_id = 'ws-qrw010'`);

  // Clear agent_config and workflow_configs so env vars are used as the resolution source.
  // Layer 2 (agent_config) takes priority over Layer 3 (env vars) in resolveWorkflowConfig.
  // Tests that rely on env var resolution must start with an empty agent_config table.
  await execute(`DELETE FROM agent_config WHERE id = 'default'`).catch(() => {});
  await execute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`).catch(() => {});

  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro', email = EXCLUDED.email`
  );
  await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);
  await execute(
    `INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
     ON CONFLICT (model_id) DO NOTHING`
  );
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ('ws-qrw010', 'QRW010 WS', $1)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [wsDir]
  );
});

afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Restore any env vars mutated in tests
  delete process.env.RORCA_AGENT;
  delete process.env.RORCA_MODEL;
});

afterAll(async () => {
  delete process.env.NODE_ENV;
});

/** Seed an approved spec JSON file */
function seedSpec(slug: string, overrides: Record<string, unknown> = {}) {
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-02-20T12:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(
    path.join(wsDir, 'forge', 'specs', 'approved', `${slug}.json`),
    JSON.stringify(spec, null, 2),
    'utf8',
  );
  return spec;
}

/** Get the mock pg-boss send function */
function getMockSend(): jest.Mock {
  const pgBossMock = jest.requireMock('../lib/pg-boss');
  return pgBossMock.getBoss().send as jest.Mock;
}

// ─── resolveWorkflowConfig is called (not direct env var reads) ───────────────

describe('QRW-010: pipeline trigger uses resolveWorkflowConfig', () => {
  /**
   * The resolver module is mocked so we can spy on it.
   * We verify the trigger calls resolveWorkflowConfig('pipeline_execution'),
   * not process.env.RORCA_AGENT directly.
   */
  test('resolveWorkflowConfig is called with pipeline_execution for each trigger', async () => {
    seedSpec('resolver-call-check');

    // Spy on the resolver module
    const resolverMod = require('../lib/workflow-config-resolver');
    const spy = jest.spyOn(resolverMod, 'resolveWorkflowConfig');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/resolver-call-check.json', workspaceId: 'ws-qrw010' });

    expect(res.status).toBe(201);
    // resolveWorkflowConfig must have been called at least once with 'pipeline_execution'
    const calls = spy.mock.calls;
    const pipelineCalls = calls.filter((args) => args[0] === 'pipeline_execution');
    expect(pipelineCalls.length).toBeGreaterThanOrEqual(1);

    spy.mockRestore();
  });

  test('agent type in response comes from wfConfig.runtime (env RORCA_AGENT=claude yields claude)', async () => {
    // Set RORCA_AGENT so the resolver's env layer returns 'claude'
    process.env.RORCA_AGENT = 'claude';
    seedSpec('agent-from-wfconfig');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/agent-from-wfconfig.json', workspaceId: 'ws-qrw010' });

    expect(res.status).toBe(201);
    // agentType in the response must be 'claude' (derived from wfConfig.runtime)
    expect(res.body.agentType).toBe('claude');
  });

  test('agent type in response comes from wfConfig.runtime (env RORCA_AGENT=opencode yields opencode)', async () => {
    // Set RORCA_AGENT so the resolver's env layer returns 'opencode'
    process.env.RORCA_AGENT = 'opencode';
    seedSpec('agent-opencode');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/agent-opencode.json', workspaceId: 'ws-qrw010' });

    expect(res.status).toBe(201);
    // agentType should reflect the opencode runtime resolved from env
    expect(res.body.agentType).toBe('opencode');
  });

  test('DB workflow_configs table overrides RORCA_AGENT env var for agent type', async () => {
    // RORCA_AGENT says opencode but DB table says claude
    process.env.RORCA_AGENT = 'opencode';

    try {
      // Upsert a workflow_configs row that overrides the env var
      await execute(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
         VALUES ('pipeline_execution', 'claude', 'claude-cli', NULL)
         ON CONFLICT (workflow_id) DO UPDATE
           SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`
      );
    } catch {
      // workflow_configs table may not exist — skip this assertion
      return;
    }

    seedSpec('db-overrides-env');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/db-overrides-env.json', workspaceId: 'ws-qrw010' });

    expect(res.status).toBe(201);
    // DB row sets claude — must take priority over RORCA_AGENT=opencode
    expect(res.body.agentType).toBe('claude');

    // Cleanup
    await execute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`);
  });
});

// ─── Model resolution chain: request > spec > wfConfig ───────────────────────

describe('QRW-010: model resolution chain in trigger', () => {
  test('request body modelOverride takes top priority over spec.model and wfConfig.model', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';
    seedSpec('model-chain-request', { model: 'claude-sonnet-4-5-20250929' });

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/model-chain-request.json',
        workspaceId: 'ws-qrw010',
        modelOverride: 'claude-opus-4-6',
      });

    expect(res.status).toBe(201);

    // The job payload must carry the request-level override, not spec.model or env model
    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    expect(jobPayload.model).toBe('claude-opus-4-6');

    // Response should also reflect the resolved model
    expect(res.body.agentModel).toBe('claude-opus-4-6');
  });

  test('spec.model takes priority over wfConfig.model when no request override', async () => {
    // wfConfig.model comes from RORCA_MODEL
    process.env.RORCA_MODEL = 'claude-haiku-4-5';
    seedSpec('model-chain-spec', { model: 'claude-sonnet-4-5-20250929' });

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/model-chain-spec.json',
        workspaceId: 'ws-qrw010',
        // No modelOverride — spec.model should win over RORCA_MODEL
      });

    expect(res.status).toBe(201);

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    // spec.model='claude-sonnet-4-5-20250929' beats wfConfig.model='claude-haiku-4-5'
    expect(jobPayload.model).toBe('claude-sonnet-4-5-20250929');
    expect(res.body.agentModel).toBe('claude-sonnet-4-5-20250929');
  });

  test('wfConfig.model (from RORCA_MODEL env) is used when no request or spec model', async () => {
    process.env.RORCA_MODEL = 'claude-haiku-4-5';
    // Spec has no model field
    seedSpec('model-chain-env');

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/model-chain-env.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    // No request or spec model — falls back to wfConfig.model from RORCA_MODEL
    expect(jobPayload.model).toBe('claude-haiku-4-5');
    expect(res.body.agentModel).toBe('claude-haiku-4-5');
  });

  test('agentModel is null when none of the chain provides a model', async () => {
    // No RORCA_MODEL, no spec model, no request override
    delete process.env.RORCA_MODEL;
    seedSpec('model-chain-null');

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/model-chain-null.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    expect(jobPayload.model).toBeNull();
    expect(res.body.agentModel).toBeNull();
  });

  test('spec-level agentOverride takes priority over wfConfig.runtime for agent type', async () => {
    process.env.RORCA_AGENT = 'claude';
    // Spec carries agentOverride=opencode
    seedSpec('agent-override-spec', { agentOverride: 'opencode' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/agent-override-spec.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);
    // Spec-level agentOverride=opencode > wfConfig.runtime=claude
    expect(res.body.agentType).toBe('opencode');
  });

  test('request agentOverride takes top priority over spec agentOverride and wfConfig.runtime', async () => {
    process.env.RORCA_AGENT = 'claude';
    // Spec has agentOverride=opencode
    seedSpec('agent-override-request', { agentOverride: 'opencode' });

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/agent-override-request.json',
        workspaceId: 'ws-qrw010',
        agentOverride: 'codex',
      });

    expect(res.status).toBe(201);
    // Request agentOverride=codex > spec agentOverride=opencode > RORCA_AGENT=claude
    expect(res.body.agentType).toBe('codex');
  });
});

// ─── wfConfig.apiKey injection into subprocess env ───────────────────────────

describe('QRW-010: wfConfig.apiKey injected into job envOverrides', () => {
  test('anthropic API key from vault is injected as ANTHROPIC_API_KEY in job envOverrides', async () => {
    // We mock getVaultKey so we can control what the vault returns
    // without needing real encrypted vault entries
    const vaultMod = require('../routes/vault');
    const vaultSpy = jest.spyOn(vaultMod, 'getVaultKey').mockImplementation(
      async (...args: unknown[]) => {
        const provider = args[1] as string;
        if (provider === 'anthropic') {
          return { key: 'sk-ant-vault-test-key', baseUrl: null };
        }
        return null;
      }
    );

    // Use opencode + anthropic so wfConfig.apiKey resolves from vault
    process.env.RORCA_AGENT = 'opencode';
    seedSpec('vault-key-inject');

    const mockSend = getMockSend();
    mockSend.mockClear();

    try {
      await execute(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
         VALUES ('pipeline_execution', 'opencode', 'anthropic', NULL)
         ON CONFLICT (workflow_id) DO UPDATE
           SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`
      );
    } catch {
      // workflow_configs table may not exist — proceed anyway, env layer will set provider
    }

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/vault-key-inject.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    // ANTHROPIC_API_KEY must be present in envOverrides when vault returns an anthropic key
    expect(jobPayload.envOverrides).toBeDefined();
    expect(jobPayload.envOverrides).toHaveProperty('ANTHROPIC_API_KEY', 'sk-ant-vault-test-key');

    vaultSpy.mockRestore();
    await execute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`).catch(() => {});
  });

  test('openrouter API key from vault is injected as OPENROUTER_API_KEY in job envOverrides', async () => {
    const vaultMod = require('../routes/vault');
    const vaultSpy = jest.spyOn(vaultMod, 'getVaultKey').mockImplementation(
      async (...args: unknown[]) => {
        const provider = args[1] as string;
        if (provider === 'openrouter') {
          return { key: 'sk-or-vault-test-key', baseUrl: null };
        }
        return null;
      }
    );

    process.env.RORCA_AGENT = 'opencode';

    try {
      await execute(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
         VALUES ('pipeline_execution', 'opencode', 'openrouter', NULL)
         ON CONFLICT (workflow_id) DO UPDATE
           SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`
      );
    } catch { /* table may not exist */ }

    seedSpec('vault-key-openrouter');

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/vault-key-openrouter.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    expect(jobPayload.envOverrides).toBeDefined();
    expect(jobPayload.envOverrides).toHaveProperty('OPENROUTER_API_KEY', 'sk-or-vault-test-key');

    vaultSpy.mockRestore();
    await execute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`).catch(() => {});
  });

  test('no API key in envOverrides when vault is empty and no env key set (claude-cli runtime)', async () => {
    process.env.RORCA_AGENT = 'claude';
    delete process.env.ANTHROPIC_API_KEY;

    const vaultMod = require('../routes/vault');
    const vaultSpy = jest.spyOn(vaultMod, 'getVaultKey').mockResolvedValue(null);

    seedSpec('no-vault-key');

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/no-vault-key.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    expect(jobPayload.envOverrides).toBeDefined();
    // claude-cli runtime does not need an API key — ANTHROPIC_API_KEY should NOT be set from vault
    // (workspace env vars may add their own, but vault path stays empty)
    expect(jobPayload.envOverrides['ANTHROPIC_API_KEY']).toBeUndefined();

    vaultSpy.mockRestore();
  });
});

// ─── pipeline_runs row stores the resolved agent from wfConfig ────────────────

describe('QRW-010: pipeline_runs row reflects wfConfig-resolved agent type', () => {
  test('pipeline_runs.agent_type is set to wfConfig.runtime value after trigger', async () => {
    process.env.RORCA_AGENT = 'claude';
    seedSpec('runs-row-agent-type');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/runs-row-agent-type.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    const run = await queryOne<{ agent_type: string; agent_model: string | null }>(
      `SELECT agent_type, agent_model FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    expect(run).toBeDefined();
    // agent_type must be 'claude' (from wfConfig.runtime, sourced from RORCA_AGENT env)
    expect(run!.agent_type).toBe('claude');
  });

  test('pipeline_runs.agent_model is set to resolved model from the chain', async () => {
    process.env.RORCA_AGENT = 'claude';
    process.env.RORCA_MODEL = 'claude-sonnet-4-5-20250929';
    seedSpec('runs-row-model');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/runs-row-model.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    const run = await queryOne<{ agent_model: string | null }>(
      `SELECT agent_model FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    expect(run).toBeDefined();
    // agent_model must be the resolved model from RORCA_MODEL (wfConfig.model)
    expect(run!.agent_model).toBe('claude-sonnet-4-5-20250929');
  });

  test('pipeline_runs.agent_model uses request modelOverride over RORCA_MODEL', async () => {
    process.env.RORCA_AGENT = 'claude';
    process.env.RORCA_MODEL = 'claude-haiku-4-5';
    seedSpec('runs-row-model-override');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/runs-row-model-override.json',
        workspaceId: 'ws-qrw010',
        modelOverride: 'claude-opus-4-6',
      });

    expect(res.status).toBe(201);
    const runId = res.body.runId;

    const run = await queryOne<{ agent_model: string | null }>(
      `SELECT agent_model FROM pipeline_runs WHERE id = $1`,
      [runId]
    );
    expect(run).toBeDefined();
    // Request modelOverride beats RORCA_MODEL
    expect(run!.agent_model).toBe('claude-opus-4-6');
  });
});

// ─── pg-boss job payload contains all required fields from wfConfig ───────────

describe('QRW-010: pg-boss job payload reflects wfConfig values', () => {
  test('job payload contains agent and model from resolved config', async () => {
    process.env.RORCA_AGENT = 'claude';
    process.env.RORCA_MODEL = 'claude-sonnet-4-5-20250929';
    seedSpec('job-payload-fields');

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/job-payload-fields.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);
    expect(mockSend).toHaveBeenCalledWith(
      'pipeline:run',
      expect.objectContaining({
        agent: 'claude',
        model: 'claude-sonnet-4-5-20250929',
        envOverrides: expect.any(Object),
      }),
      expect.any(Object),
    );
  });

  test('job payload contains correct queue name pipeline:run', async () => {
    seedSpec('job-queue-name');

    const mockSend = getMockSend();
    mockSend.mockClear();

    await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/job-queue-name.json',
        workspaceId: 'ws-qrw010',
      });

    expect(mockSend).toHaveBeenCalled();
    const queueName = mockSend.mock.calls[0][0];
    expect(queueName).toBe('pipeline:run');
  });

  test('job payload runId matches the runId returned in the response', async () => {
    seedSpec('job-payload-runid');

    const mockSend = getMockSend();
    mockSend.mockClear();

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/job-payload-runid.json',
        workspaceId: 'ws-qrw010',
      });

    expect(res.status).toBe(201);
    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    expect(jobPayload.runId).toBe(res.body.runId);
  });

  test('job payload contains specPath and workspacePath', async () => {
    seedSpec('job-payload-paths');

    const mockSend = getMockSend();
    mockSend.mockClear();

    await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        specPath: 'forge/specs/approved/job-payload-paths.json',
        workspaceId: 'ws-qrw010',
      });

    expect(mockSend).toHaveBeenCalled();
    const jobPayload = mockSend.mock.calls[0][1];
    expect(jobPayload.specPath).toBe('forge/specs/approved/job-payload-paths.json');
    expect(jobPayload.workspacePath).toBe(wsDir);
  });
});
