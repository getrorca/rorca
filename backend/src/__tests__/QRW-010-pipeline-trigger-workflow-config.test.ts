/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-010: Backend integration — TaskManifest broker resolves workflow config
 *
 * Verifies that canonical POST /api/pipeline/task-manifests/trigger execution:
 *   1. Calls resolveWorkflowConfig('pipeline_execution') rather than reading RORCA_AGENT directly
 *   2. Uses wfConfig.runtime as the resolved agent type when no higher authority overrides it
 *   3. Preserves the model chain: request override > manifest/spec metadata > wfConfig.model
 *   4. Persists only opaque execution-boundary credential references in pg-boss payloads
 *   5. Creates isolated worktree/PR execution jobs under immutable TaskManifest lineage
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import supertest from 'supertest';
import type * as DatabaseModule from '../db/index';
import type * as AuthUtilsModule from '../lib/auth-utils';
import { storyLifecycleFixture } from '../lib/__tests__/fixtures/story-execution-manifest.fixture';

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

// Workflow resolution is the contract under test; lifecycle orchestration has
// its own fail-closed suite. Start these dispatches from a current plan state.
jest.mock('../lib/ssdlc-lifecycle-orchestrator', () => ({
  ...jest.requireActual('../lib/ssdlc-lifecycle-orchestrator'),
  assertLifecycleDispatchReady: jest.fn().mockImplementation(async (input: {
    workspaceId: string;
    specId: string;
    canonicalSpec: unknown;
  }) => {
    if (!input.canonicalSpec || typeof input.canonicalSpec !== 'object') {
      throw new Error('Lifecycle fixture requires exact canonical spec bytes');
    }
    const canonicalSpec = input.canonicalSpec as { userStories?: Array<{ id?: string }> };
    const storyIds = canonicalSpec.userStories?.map((story) => story.id).filter((id): id is string => typeof id === 'string') ?? [];
    const storyId = storyIds[0];
    if (!storyId) throw new Error('Lifecycle fixture requires a canonical story identity');
    return {
      workspaceId: input.workspaceId,
      specId: input.specId,
      specHash: `sha256:${'c'.repeat(64)}`,
      compiledPlanId: '103',
      plan: storyLifecycleFixture(input.workspaceId, input.specId, storyId, storyIds).plan,
      phases: [],
      policy: { advanced: [], awaitingHuman: [] },
    };
  }),
}));

jest.mock('../lib/lifecycle-dispatch-claim', () => ({
  claimLifecycleDispatch: jest.fn().mockImplementation(async (input: Record<string, string>) => ({
    schemaVersion: 'lifecycle-dispatch-claim.v1',
    claimId: '33333333-3333-4333-8333-333333333333',
    ...input,
  })),
  parseLifecycleDispatchClaim: jest.fn().mockImplementation((value: unknown) => value),
  assertLifecycleDispatchClaim: jest.fn().mockResolvedValue(undefined),
  withLifecycleDispatchClaimLock: jest.fn().mockImplementation(
    async (_claim: unknown, action: () => unknown) => action(),
  ),
}));

jest.mock('../lib/opencode-detector', () => ({
  detectOpenCode: jest.fn().mockReturnValue({
    opencodeInstalled: true,
    opencodePath: process.execPath,
    opencodeVersion: '1.0.0',
  }),
}));

// Mock pg-boss so pipeline trigger doesn't fail with "getBoss() called before initBoss()"
jest.mock('../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getPgBossSchemaSql: jest.fn(() => '"pgboss"'),
  getBoss: jest.fn().mockReturnValue({
    createQueue: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockImplementation(async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? 'mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
  }),
}));

const QRW_WORKSPACE_ID = 'ws-qrw010';
const QRW_USER_ID = crypto.randomUUID();
const QRW_USER_AUTH_ID = crypto.randomUUID();
const QRW_USER_EMAIL = `qrw010-${process.pid}@test.rorca.local`;
const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
  'PATH',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'RORCA_AGENT',
  'RORCA_MODEL',
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

// The application pool captures this exact workspace before any runtime module is loaded.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = QRW_WORKSPACE_ID;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${QRW_WORKSPACE_ID}`,
});

type WorkflowConfigFixture = {
  id: string;
  workflow_id: string;
  runtime: string;
  provider: string;
  model: string | null;
  updated_at: Date;
};
type AgentConfigFixture = {
  id: string;
  agent_type: string;
  agent_model: string | null;
  updated_at: Date;
};

let app: Express;
let httpServer: Server;
let tmpDir: string;
let wsDir: string;
let authToken: string;
let queryOne: typeof DatabaseModule.queryOne;
let originalWorkflowConfig: WorkflowConfigFixture | undefined;
let originalAgentConfig: AgentConfigFixture | undefined;
let createdModelPricing = false;

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreMutableEnvironment(): void {
  for (const key of ['PATH', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'RORCA_AGENT', 'RORCA_MODEL'] as const) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function ownerExecute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

async function ownerQueryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function cleanupQrwFixtures(): Promise<void> {
  await ownerExecute(
    'DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [QRW_WORKSPACE_ID],
  );
  await ownerExecute(
    'DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [QRW_WORKSPACE_ID],
  );
  await ownerExecute(
    `UPDATE pipeline_runs
        SET status = 'cancelled', finished_at = COALESCE(finished_at, NOW())
      WHERE workspace_id = $1
        AND status NOT IN ('done', 'failed', 'cancelled', 'partial_failure')`,
    [QRW_WORKSPACE_ID],
  );
  await ownerExecute('DELETE FROM wal_events WHERE workspace_id = $1', [QRW_WORKSPACE_ID]);
  await ownerExecute(
    `DELETE FROM spec_generation_logs
      WHERE context_summary_json->>'workspaceId' = $1`,
    [QRW_WORKSPACE_ID],
  );
  await ownerExecute(
    `DELETE FROM pipeline_runs run
      WHERE run.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM task_manifest_run_lineage lineage WHERE lineage.run_id = run.id)
        AND NOT EXISTS (SELECT 1 FROM task_manifest_dispatch_publications publication WHERE publication.run_id = run.id)`,
    [QRW_WORKSPACE_ID],
  );
}

async function restoreResolverFixtures(): Promise<void> {
  await ownerExecute(`DELETE FROM agent_config WHERE id = 'default'`);
  if (originalAgentConfig) {
    await ownerExecute(
      `INSERT INTO agent_config (id, agent_type, agent_model, updated_at)
       VALUES ($1, $2, $3, $4)`,
      [originalAgentConfig.id, originalAgentConfig.agent_type, originalAgentConfig.agent_model, originalAgentConfig.updated_at],
    );
  }
  await ownerExecute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`);
  if (originalWorkflowConfig) {
    await ownerExecute(
      `INSERT INTO workflow_configs (id, workflow_id, runtime, provider, model, updated_at)
       VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
      [
        originalWorkflowConfig.id,
        originalWorkflowConfig.workflow_id,
        originalWorkflowConfig.runtime,
        originalWorkflowConfig.provider,
        originalWorkflowConfig.model,
        originalWorkflowConfig.updated_at,
      ],
    );
  }
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = QRW_WORKSPACE_ID;
  ({ queryOne } = require('../db/index') as typeof DatabaseModule);
  originalWorkflowConfig = await ownerQueryOne<WorkflowConfigFixture>(
    `SELECT id, workflow_id, runtime, provider, model, updated_at
       FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`,
  );
  originalAgentConfig = await ownerQueryOne<AgentConfigFixture>(
    `SELECT id, agent_type, agent_model, updated_at FROM agent_config WHERE id = 'default'`,
  );
  createdModelPricing = !(await ownerQueryOne<{ model_id: string }>(
    `SELECT model_id FROM model_pricing WHERE model_id = 'claude-sonnet-4-5-20250929'`,
  ));
  await ownerExecute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
     VALUES ($1, $2, 'QRW010 Test User', 'x', $3::uuid, 'admin', 'pro')`,
    [QRW_USER_ID, QRW_USER_EMAIL, QRW_USER_AUTH_ID],
  );
  await ownerExecute(
    `INSERT INTO model_pricing (model_id, input_cost_per_1k, output_cost_per_1k, input_cost_per_1m, output_cost_per_1m)
     VALUES ('claude-sonnet-4-5-20250929', 0.003, 0.015, 3.0, 15.0)
     ON CONFLICT (model_id) DO NOTHING`,
  );

  const { JWT_SECRET } = require('../lib/auth-utils') as typeof AuthUtilsModule;
  authToken = jwt.sign({ sub: QRW_USER_AUTH_ID, email: QRW_USER_EMAIL }, JWT_SECRET, { expiresIn: '15m' });
  const serverMod = require('../server');
  app = serverMod.default;
  httpServer = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    httpServer.once('error', onError);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
});

beforeEach(async () => {
  jest.clearAllMocks();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-qrw010-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'pending'), { recursive: true });
  execSync('git init -b main', { cwd: wsDir, stdio: 'pipe' });
  execSync('git config user.email "qrw010@example.test"', { cwd: wsDir, stdio: 'pipe' });
  execSync('git config user.name "QRW010 Test"', { cwd: wsDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# QRW010\n');
  execSync('git add README.md && git commit -m "fixture"', { cwd: wsDir, stdio: 'pipe' });
  const fixtureBinDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(fixtureBinDir, { recursive: true });
  fs.writeFileSync(path.join(fixtureBinDir, 'opencode'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(fixtureBinDir, 'opencode'), 0o755);
  process.env.PATH = `${fixtureBinDir}${path.delimiter}${originalEnvironment.PATH ?? ''}`;
  process.env.OPENAI_API_KEY = 'test-only-readiness-marker';

  await cleanupQrwFixtures();
  // These legacy global resolver fixtures are owner-controlled and are restored
  // exactly after the suite. Empty rows make the env precedence cases explicit.
  await ownerExecute(`DELETE FROM agent_config WHERE id = 'default'`);
  await ownerExecute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`);
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'QRW010 WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [QRW_WORKSPACE_ID, wsDir],
  );
});

afterEach(async () => {
  await restoreResolverFixtures();
  await cleanupQrwFixtures();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreMutableEnvironment();
});

afterAll(async () => {
  try {
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
    await restoreResolverFixtures();
    if (createdModelPricing) {
      await ownerExecute(
        `DELETE FROM model_pricing WHERE model_id = 'claude-sonnet-4-5-20250929'`,
      );
    }
    await ownerExecute('DELETE FROM users WHERE id = $1', [QRW_USER_ID]);
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
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

function releaseOneTaskManifestRequest(legacyBody: Record<string, any>): Record<string, any> {
  const fixturePath = path.join(__dirname, '..', 'lib', '__tests__', 'fixtures', 'hermes-task-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, any>;
  const sourceSpecPath = String(legacyBody.specPath);
  const sourceSpecId = path.basename(sourceSpecPath, '.json');
  const sourceSpec = JSON.parse(fs.readFileSync(path.join(wsDir, sourceSpecPath), 'utf8')) as {
    agentOverride?: unknown;
    model?: unknown;
    userStories?: Array<{ id?: unknown; acceptanceCriteria?: unknown }>;
  };

  manifest.manifestId = crypto.randomUUID();
  manifest.idempotencyKey = crypto.randomUUID();
  manifest.workspaceId = legacyBody.workspaceId;
  manifest.source = {
    rorca: {
      specId: sourceSpecId,
      storyId: String(sourceSpec.userStories?.[0]?.id ?? 'US-001'),
      specPath: sourceSpecPath,
    },
  };
  manifest.boundedScope.allowedPaths = [...new Set([
    ...manifest.boundedScope.allowedPaths,
    sourceSpecPath,
  ])];
  manifest.tasks[0].taskId = String(sourceSpec.userStories?.[0]?.id ?? 'US-001');
  manifest.tasks[0].targetPaths = [sourceSpecPath];
  manifest.tasks[0].acceptanceCriteria = Array.isArray(sourceSpec.userStories?.[0]?.acceptanceCriteria)
    ? sourceSpec.userStories[0].acceptanceCriteria
    : ['The bounded TaskManifest execution completes'];
  if (typeof sourceSpec.agentOverride === 'string') manifest.execution.agentOverride = sourceSpec.agentOverride;
  else delete manifest.execution.agentOverride;
  if (typeof sourceSpec.model === 'string') manifest.execution.modelOverride = sourceSpec.model;
  else delete manifest.execution.modelOverride;
  manifest.policy.dryRun = false;
  manifest.policy.branchPrOnly = true;
  manifest.policy.autoMerge = false;
  manifest.execution.mergeStrategy = 'draft-pr';

  return {
    ...legacyBody,
    workspaceId: QRW_WORKSPACE_ID,
    manifest,
    idempotencyKey: manifest.idempotencyKey,
    autoWorktree: true,
    autoMerge: false,
    mergeStrategy: 'draft-pr',
    queue: false,
  };
}

async function seedTaskManifestReadiness(manifestId: string): Promise<void> {
  await ownerExecute(
    `INSERT INTO spec_generation_logs
       (spec_slug, model, provider, duration_ms, context_summary, enriched, retrieval_method,
        context_summary_json, status, save_generation)
     VALUES ($1, 'claude-sonnet-4-5-20250929', 'api', 0, 'test', false, 'none', $2, 'persisted', 1)`,
    [
      `hermes-task-manifest-${manifestId}`,
      JSON.stringify({
        workspaceId: QRW_WORKSPACE_ID,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context' },
        postSaveStages: {
          enrich: { requested: true, status: 'completed', reason: 'job_completed' },
          matchSkills: { requested: true, status: 'completed', reason: 'job_completed' },
        },
      }),
    ],
  );
}

/** Preserve the integration assertions while routing every mutation through the canonical TaskManifest ingress. */
function request(_target: Express) {
  return {
    post: (_legacyPath: string) => {
      let test = supertest(httpServer).post('/api/pipeline/task-manifests/trigger');
      const routeRequest = {
        set(name: string, value: string) {
          test = test.set(name, value);
          return routeRequest;
        },
        async send(body: Record<string, any>) {
          const releaseRequest = releaseOneTaskManifestRequest(body);
          await seedTaskManifestReadiness(releaseRequest.manifest.manifestId);
          return test.send(releaseRequest);
        },
      };
      return routeRequest;
    },
  };
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

    // Upsert a workflow_configs row that overrides the env var.
    await ownerExecute(`INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
     VALUES ('pipeline_execution', 'claude', 'claude-cli', NULL)
     ON CONFLICT (workflow_id) DO UPDATE
       SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`);

    seedSpec('db-overrides-env');

    const res = await request(app)
      .post('/api/pipeline/trigger')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ specPath: 'forge/specs/approved/db-overrides-env.json', workspaceId: 'ws-qrw010' });

    expect(res.status).toBe(201);
    // DB row sets claude — must take priority over RORCA_AGENT=opencode
    expect(res.body.agentType).toBe('claude');

    // Cleanup
    await ownerExecute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`);
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

// ─── Credential references remain opaque in the durable job ─────────────────

describe('QRW-010: workflow provider credentials use execution-boundary references', () => {
  test('anthropic vault material is not persisted in pg-boss envOverrides', async () => {
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

    await ownerExecute(`INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
     VALUES ('pipeline_execution', 'opencode', 'anthropic', NULL)
     ON CONFLICT (workflow_id) DO UPDATE
       SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`);

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
    expect(jobPayload.envOverrides).toBeDefined();
    expect(jobPayload.envOverrides).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(JSON.stringify(jobPayload)).not.toContain('sk-ant-vault-test-key');
    expect(jobPayload.secretReferences).toEqual(expect.objectContaining({
      workspaceId: 'ws-qrw010',
      providers: expect.arrayContaining(['anthropic']),
    }));

    vaultSpy.mockRestore();
    await ownerExecute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`);
  });

  test('openrouter vault material is not persisted in pg-boss envOverrides', async () => {
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

    await ownerExecute(`INSERT INTO workflow_configs (workflow_id, runtime, provider, model)
     VALUES ('pipeline_execution', 'opencode', 'openrouter', NULL)
     ON CONFLICT (workflow_id) DO UPDATE
       SET runtime = EXCLUDED.runtime, provider = EXCLUDED.provider, model = EXCLUDED.model`);

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
    expect(jobPayload.envOverrides).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(JSON.stringify(jobPayload)).not.toContain('sk-or-vault-test-key');
    expect(jobPayload.secretReferences).toEqual(expect.objectContaining({
      workspaceId: 'ws-qrw010',
      providers: expect.arrayContaining(['openrouter']),
    }));

    vaultSpy.mockRestore();
    await ownerExecute(`DELETE FROM workflow_configs WHERE workflow_id = 'pipeline_execution'`);
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
        worktreePath: expect.any(String),
      }),
      expect.any(Object),
    );
  });

  test('worktree-isolated job payload uses the isolated execution queue', async () => {
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
    expect(jobPayload.specPath).toMatch(/^forge\/task-manifests\/[0-9a-f-]+\/hermes-task-manifest-[0-9a-f-]+\.json$/);
    expect(jobPayload.workspacePath).toBe(wsDir);
  });
});
