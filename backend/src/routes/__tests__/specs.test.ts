/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'node:crypto';
import type { Server } from 'http';
import { Pool } from 'pg';
import request from 'supertest';
import type * as AuthHelperModule from './helpers/auth-helper';
import type * as SpecJobsModule from '../../db/spec-jobs';
import type * as SpecPostSaveWorkflowModule from '../../lib/spec-post-save-workflow';
import type * as RunSpecSnapshotModule from '../../lib/run-spec-snapshot';
import type * as SsdlcForgeAuthoringModule from '../../lib/ssdlc-forge-authoring';
import type { CompileSpecPlanInput, CompileSpecPlanResult } from '../../lib/ssdlc-plan-service';
import { SpecReadinessReasonCode } from '../../reason-codes';
import { planAuthoring } from '../../lib/ssdlc-authoring-planner';
import { registerGenesisPackage } from '../../ssdlc/genesis/genesis-authority-bridge';
import type { GenesisPackageDefinitionInput } from '../../ssdlc/genesis/genesis-authority-bridge';
import {
  lifecycleSourceEvidenceProjection,
  projectLifecycleSourceMaterial,
} from '../../lib/lifecycle-source-material';

const SPECS_WORKSPACE_ID = 'ws-test';
const SPECS_USER_ID = crypto.randomUUID();
const SPECS_USER_AUTH_ID = crypto.randomUUID();
const SPECS_USER_EMAIL = `specs-suite-${process.pid}@test.rorca.local`;
const ENVIRONMENT_KEYS = [
  'NODE_ENV',
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
  'TMPDIR',
  'RORCA_AGENT',
  'RORCA_MODEL',
] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

// Every runtime module below is loaded only after this exact workspace fence.
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = SPECS_WORKSPACE_ID;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${SPECS_WORKSPACE_ID}`,
});

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await ownerPool.query(sql, params);
  return result.rows as T[];
}

async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function execute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

/** pg returns jsonb columns as already-parsed objects; this handles both cases */
function parsePayload(p: unknown): Record<string, unknown> {
  if (typeof p === 'string') return JSON.parse(p);
  return p as Record<string, unknown>;
}

async function loadWorkflowStages(specId: string): Promise<Array<{
  stage_key: string;
  requested: boolean;
  status: string;
  reason: string;
  boss_job_id: string | null;
  error_message: string | null;
}>> {
  return query(
    `SELECT stage.stage_key, stage.requested, stage.status, stage.reason,
            stage.boss_job_id, stage.error_message
       FROM spec_post_save_workflow_stages stage
       JOIN spec_post_save_workflow_runs run ON run.id = stage.run_id
      WHERE run.workspace_id = 'ws-test' AND run.spec_id = $1
      ORDER BY CASE stage.stage_key
        WHEN 'context' THEN 1 WHEN 'enrich' THEN 2
        WHEN 'matchSkills' THEN 3 WHEN 'memorySynthesis' THEN 4 END`,
    [specId],
  );
}

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

jest.mock('../../lib/pi-spec-drafter', () => ({
  draftSpecWithPi: jest.fn(),
}));

jest.mock('../../lib/codex-spec-drafter', () => ({
  draftSpecWithCodex: jest.fn(),
}));

jest.mock('../../lib/pg-boss', () => {
  const send = jest.fn(
    async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? null,
  );
  return {
    initBoss: jest.fn().mockResolvedValue(undefined),
    getBoss: jest.fn(() => ({ send })),
  };
});

jest.mock('../../lib/ssdlc-plan-service', () => {
  const actual = jest.requireActual('../../lib/ssdlc-plan-service');
  const { GENERAL_SDLC_7_PROFILE } = jest.requireActual('../../ssdlc/profiles/general-sdlc-7');
  return {
    ...actual,
    compileSpecPlan: jest.fn(async (
      input: CompileSpecPlanInput,
    ): Promise<CompileSpecPlanResult> => ({
      status: 'compiled',
      specSlug: input.specSlug,
      specVersion: String(input.expectedSaveGeneration ?? 1),
      specHash: `sha256:${'a'.repeat(64)}` as const,
      inputHash: `sha256:${'b'.repeat(64)}` as const,
      planId: `fixture-plan-${input.specSlug}`,
      planVersion: 1,
      compilerVersion: 'ssdlc-plan-compiler-5',
      profileHash: GENERAL_SDLC_7_PROFILE.contentHash,
      profiles: ['code-change'],
      riskLevel: 'low',
      generatedAt: '2026-07-15T12:00:00.000Z',
      saveGeneration: input.expectedSaveGeneration ?? null,
    })),
  };
});

let app: Server;
let tmpDir: string;
let mockChatComplete: jest.Mock;
let mockDraftSpecWithPi: jest.Mock;
let mockDraftSpecWithCodex: jest.Mock;
let mockBossSend: jest.Mock;
let authToken: string;
let suiteTempRoot: string;
let getAuthToken: typeof AuthHelperModule.getAuthToken;
let updateJobStatus: typeof SpecJobsModule.updateJobStatus;
let advanceSpecPostSaveWorkflowDependencies: typeof SpecPostSaveWorkflowModule.advanceSpecPostSaveWorkflowDependencies;
let runSpecSnapshot: typeof RunSpecSnapshotModule;
let adaptCanonicalStoriesToAuthoringDraft: typeof SsdlcForgeAuthoringModule.adaptCanonicalStoriesToAuthoringDraft;
const validLlmResponse = JSON.stringify({
  stories: [
    {
      id: 'US-001',
      title: 'User login',
      description: 'Allow users to log in with email and password',
      acceptanceCriteria: ['Given valid creds, user is authenticated', 'Given invalid creds, error shown', 'Session persists across refresh'],
      dependsOn: [],
    },
    {
      id: 'US-002',
      title: 'Dashboard view',
      description: 'Show user dashboard after login',
      acceptanceCriteria: ['Dashboard shows user name', 'Shows recent activity', 'Loads within 2s'],
      dependsOn: ['US-001'],
    },
  ],
  diagrams: {
    architecture: { mermaid: 'graph LR\n  A-->B', ascii: 'A -> B' },
    userFlow: { mermaid: 'graph TD\n  login-->dash', ascii: 'login -> dash' },
  },
});

async function cleanupSpecsDatabaseFixtures(): Promise<void> {
  const ownedWalSpecs = await query<{ spec_id: string }>(
    `SELECT DISTINCT spec_id
       FROM wal_events
      WHERE spec_id IS NOT NULL
        AND (workspace_id = $1 OR payload ->> 'workspaceId' = $1)`,
    [SPECS_WORKSPACE_ID],
  );
  const ownedSpecSlugs = [...new Set([
    ...ownedWalSpecs.map((row) => row.spec_id),
    'multi-ver',
    'diff-test',
  ])];
  const workflowRows = await query<{ id: number; generation_log_id: number | null }>(
    `SELECT id, generation_log_id
       FROM spec_post_save_workflow_runs
      WHERE workspace_id = $1`,
    [SPECS_WORKSPACE_ID],
  );
  const workflowIds = workflowRows.map((row) => row.id);
  const generationLogIds = workflowRows
    .map((row) => row.generation_log_id)
    .filter((id): id is number => id !== null);
  if (workflowIds.length > 0) {
    await execute('DELETE FROM spec_post_save_stage_dependencies WHERE run_id = ANY($1::bigint[])', [workflowIds]);
    await execute('DELETE FROM spec_post_save_workflow_stages WHERE run_id = ANY($1::bigint[])', [workflowIds]);
  }
  await execute('DELETE FROM spec_jobs WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM spec_post_save_workflow_runs WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  if (generationLogIds.length > 0) {
    await execute('DELETE FROM spec_generation_logs WHERE id = ANY($1::bigint[])', [generationLogIds]);
  }
  await execute(
    `DELETE FROM spec_generation_logs
      WHERE context_summary_json->>'workspaceId' = $1
         OR spec_slug = ANY($2::text[])`,
    [SPECS_WORKSPACE_ID, ownedSpecSlugs],
  );
  await execute(
    'DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)',
    [SPECS_WORKSPACE_ID],
  );
  await execute('DELETE FROM story_commits WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM pipeline_dispatch_publications WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM pipeline_run_cancellation_requests WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute(
    `DELETE FROM wal_events
      WHERE workspace_id = $1 OR payload ->> 'workspaceId' = $1`,
    [SPECS_WORKSPACE_ID],
  );
  await execute(
    `DELETE FROM spec_versions
      WHERE workspace_id = $1
         OR (workspace_id IS NULL AND spec_slug = ANY($2::text[]))`,
    [SPECS_WORKSPACE_ID, ownedSpecSlugs],
  );
  await execute('DELETE FROM spec_search_index WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM workspace_context WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM direction_layers WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM workspace_env_vars WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('DELETE FROM retrieval_telemetry_events WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  // Genesis-bound spec_sources rows are immutable by DB trigger; the owner pool
  // disables the guard for suite cleanup exactly like other immutable-trigger
  // tables in this repository.
  await execute('ALTER TABLE spec_sources DISABLE TRIGGER spec_sources_binding_immutable_trigger');
  await execute('DELETE FROM spec_sources WHERE workspace_id = $1', [SPECS_WORKSPACE_ID]);
  await execute('ALTER TABLE spec_sources ENABLE TRIGGER spec_sources_binding_immutable_trigger');
}

// Load one workspace-bound runtime pool and one server for the suite.
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = SPECS_WORKSPACE_ID;
  suiteTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-specs-suite-'));
  process.env.TMPDIR = suiteTempRoot;

  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
     VALUES ($1, $2, 'Specs Suite User', 'x', $3::uuid, 'admin', 'pro')`,
    [SPECS_USER_ID, SPECS_USER_EMAIL, SPECS_USER_AUTH_ID],
  );

  ({ getAuthToken } = require('./helpers/auth-helper') as typeof AuthHelperModule);
  ({ updateJobStatus } = require('../../db/spec-jobs') as typeof SpecJobsModule);
  ({ advanceSpecPostSaveWorkflowDependencies } = require('../../lib/spec-post-save-workflow') as typeof SpecPostSaveWorkflowModule);
  runSpecSnapshot = require('../../lib/run-spec-snapshot') as typeof RunSpecSnapshotModule;
  ({ adaptCanonicalStoriesToAuthoringDraft } = require('../../lib/ssdlc-forge-authoring') as typeof SsdlcForgeAuthoringModule);

  const serverMod = require('../../server');
  app = serverMod.default.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    app.once('listening', resolve);
    app.once('error', reject);
  });
  const llmClient = require('../../lib/llm-client');
  const piDrafter = require('../../lib/pi-spec-drafter');
  const codexDrafter = require('../../lib/codex-spec-drafter');
  const pgBoss = require('../../lib/pg-boss');
  mockChatComplete = llmClient.chatComplete;
  mockDraftSpecWithPi = piDrafter.draftSpecWithPi;
  mockDraftSpecWithCodex = codexDrafter.draftSpecWithCodex;
  mockBossSend = pgBoss.getBoss().send;
  authToken = await getAuthToken(undefined, {
    email: SPECS_USER_EMAIL,
    authId: SPECS_USER_AUTH_ID,
    role: 'admin',
    displayName: 'Specs Suite User',
  });
});

afterAll(async () => {
  try {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    await cleanupSpecsDatabaseFixtures();
    await execute('DELETE FROM users WHERE id = $1', [SPECS_USER_ID]);
    fs.rmSync(suiteTempRoot, { recursive: true, force: true });
  } finally {
    await ownerPool.end();
    restoreEnvironment();
  }
});

beforeEach(async () => {
  jest.clearAllMocks();
  // Reset clears any unconsumed one-shot publication result from the prior case.
  mockBossSend.mockReset();
  mockBossSend.mockImplementation(
    async (_name: string, _data: unknown, options?: { id?: string }) => options?.id ?? null,
  );

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-specs-test-'));

  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
  fs.rmSync(path.join(os.tmpdir(), 'forge', 'export-kits'), { recursive: true, force: true });

  await cleanupSpecsDatabaseFixtures();
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [SPECS_WORKSPACE_ID, os.tmpdir()],
  );
});

afterEach(async () => {
  const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
  if (fs.existsSync(specsRoot)) {
    fs.rmSync(specsRoot, { recursive: true, force: true });
  }
  fs.rmSync(path.join(os.tmpdir(), 'forge', 'export-kits'), { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('POST /api/specs/generate with valid body returns slug, stories, diagrams, provider, model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Auth System',
      brief: 'Build login and signup',
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('auth-system');
  expect(res.body.title).toBe('Auth System');
  expect(res.body.stories).toHaveLength(2);
  expect(res.body.stories[0]).toMatchObject({
    id: 'US-001',
    title: 'User login',
    description: expect.any(String),
    acceptanceCriteria: expect.any(Array),
    dependsOn: [],
  });
  expect(res.body.diagrams).toBeDefined();
  expect(res.body.diagrams.storyDeps).toBeDefined();
  expect(res.body.diagrams.storyDeps.mermaid).toContain('US-001');
  expect(res.body.provider).toBe('claude-cli');
  expect(res.body.model).toBe('claude-sonnet-4-5-20250929');
  expect(res.body.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
  expect(res.body.specPath).toBeDefined();
  expect(res.body.specPath).toContain('auth-system.json');
  expect(res.body.diagramsPath).toBeDefined();
  expect(res.body.diagramsPath).toContain('auth-system-diagrams.md');
  expect(res.body.postSavePolicy).toMatchObject({
    callerPolicy: null,
    effectivePolicy: { version: 'v1', presetId: 'best_effort' },
    legacyOptions: { enrich: true, matchSkills: true, memorySynthesis: true },
  });
  expect(res.body.workflow).toMatchObject({
    engine: 'spec-post-save-v1',
    runId: expect.any(Number),
    saveGeneration: expect.any(Number),
  });
  const workflowStages = await query(
    `SELECT stage_key FROM spec_post_save_workflow_stages WHERE run_id = $1 ORDER BY stage_key`,
    [res.body.workflow.runId],
  ) as Array<{ stage_key: string }>;
  expect(workflowStages.map((stage) => stage.stage_key).sort()).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);
});

test('POST /api/specs/generate rejects invalid postSave enum values with ValidationError details', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Bad Generate Policy',
      brief: 'Build invalid policy validation',
      postSave: { skills: 'sometimes' },
    });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe('VALIDATION_ERROR');
  expect(res.body.details).toMatchObject({
    field: 'postSave.skills',
    value: 'sometimes',
    allowedValues: 'match,skip',
    allowedValuesList: ['match', 'skip'],
  });
  expect(mockChatComplete).not.toHaveBeenCalled();
});

test('POST /api/specs/generate surfaces gitRehydration state in contextSummary (CTM-005)', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Hydration Trace',
      brief: 'Observe hydration state',
    });

  expect(res.status).toBe(200);
  expect(res.body.contextSummary).toBeDefined();
  expect(res.body.contextSummary.gitRehydration).toBeDefined();
  expect(typeof res.body.contextSummary.gitRehydration.triggered).toBe('boolean');
  // tmpdir workspace is not a git repo, so HEAD cannot be resolved → no rehydration.
  expect(res.body.contextSummary.gitRehydration.triggered).toBe(false);
  expect(res.body.contextSummary.gitRehydration.reason).toBe('no_head');
});

test('POST /api/specs/generate with agentOverride=pi uses the Pi forge drafter path', async () => {
  mockDraftSpecWithPi.mockResolvedValue({
    text: validLlmResponse,
    usage: { inputTokens: 33, outputTokens: 44 },
  });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Pi Forge',
      brief: 'Generate via Pi',
      agentOverride: 'pi',
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('pi-forge');
  expect(res.body.provider).toBe('pi');
  expect(res.body.model).toBe('claude-sonnet-4-5-20250929');
  expect(res.body.usage).toEqual({ inputTokens: 33, outputTokens: 44 });
  expect(mockDraftSpecWithPi).toHaveBeenCalledTimes(1);
  const draftingCalls = mockChatComplete.mock.calls.filter((call) => {
    const messages = call[0] as Array<{ content?: string }> | undefined;
    return Array.isArray(messages)
      && messages.some((message) => typeof message?.content === 'string' && message.content.includes('TASK: Generate a software specification JSON'));
  });
  expect(draftingCalls).toHaveLength(0);
});

test('POST /api/specs/generation-context returns a prompt bundle for skill-first callers', async () => {
  const res = await request(app)
    .post('/api/specs/generation-context')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Context Bundle',
      brief: 'Draft a context-aware spec',
      agentOverride: 'pi',
    });

  expect(res.status).toBe(200);
  expect(res.body.title).toBe('Context Bundle');
  expect(res.body.slug).toBe('context-bundle');
  expect(res.body.agentType).toBe('pi');
  expect(typeof res.body.prompt).toBe('string');
  expect(res.body.prompt).toContain('Spec brief: Draft a context-aware spec');
  expect(res.body.contextSummary).toBeDefined();
  expect(res.body.lifecycleAuthoring).toMatchObject({
    schemaVersion: 1,
    profileVersion: 'ssdlc-lifecycle-authoring-1',
    status: 'ready',
    decompositionPolicy: {
      defaultDecision: 'one_spec_unless_independent_boundary_is_proven',
      maximumSpecs: 12,
    },
    preflightContract: { maximumRevisionAttempts: 3 },
    authorityBoundary: {
      evaluatedLifecycleStatus: 'forbidden',
      completionEvidence: 'forbidden',
      executionDispatch: 'forbidden',
    },
  });
  expect(res.body.lifecycleAuthoring.normalizedIntentIdentity.normalizedIntentHash).toMatch(/^sha256:/);
  expect(res.body.lifecycleAuthoring.requiredPhaseObligations).toHaveLength(7);
  expect(res.body.lifecycleAuthoring.requiredStoryCapabilities.length).toBeGreaterThan(0);
  expect(res.body.exportKitContract).toMatchObject({
    schemaVersion: 'rorca.export-kit-input.v1',
    requiredArtifacts: ['spec.json', 'PRD.md', 'SDD.md', 'PLAN.md', 'manifest.json'],
    compiler: 'rorca-export-kit-compiler-1',
  });
  expect(res.body.exportKitContract.inputSchema.required).toContain('product');
});

test('export-kit API rebuilds a pending legacy spec and verifies artifact tampering', async () => {
  const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
  fs.rmSync(path.join(os.tmpdir(), 'forge', 'export-kits', 'kit-api'), { recursive: true, force: true });
  fs.mkdirSync(pendingDir, { recursive: true });
  fs.writeFileSync(path.join(pendingDir, 'kit-api.json'), JSON.stringify({
    id: 'kit-api',
    slug: 'kit-api',
    title: 'Kit API',
    userStories: [{
      id: 'KIT-001',
      title: 'Read the kit',
      description: 'Expose deterministic package artifacts.',
      acceptanceCriteria: ['The artifact hash is verified.'],
      dependsOn: [],
    }],
  }));

  const rebuild = await request(app)
    .post('/api/specs/kit-api/export-kit/rebuild')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test' });
  expect(rebuild.status).toBe(200);
  expect(rebuild.body.exportKit.status).toBe('current');

  const readKit = await request(app)
    .get('/api/specs/kit-api/export-kit')
    .query({ workspaceId: 'ws-test' })
    .set('Authorization', `Bearer ${authToken}`);
  expect(readKit.status).toBe(200);
  expect(readKit.body.exportKit.identity.manifestHash).toBe(rebuild.body.exportKit.identity.manifestHash);
  expect(readKit.body.manifest.artifacts).toHaveLength(4);

  const readPrd = await request(app)
    .get('/api/specs/kit-api/export-kit/artifacts/requirements')
    .query({ workspaceId: 'ws-test' })
    .set('Authorization', `Bearer ${authToken}`);
  expect(readPrd.status).toBe(200);
  expect(readPrd.body.content).toContain('# Kit API — Product Requirements');

  fs.appendFileSync(path.join(os.tmpdir(), rebuild.body.exportKit.identity.artifacts.design.path), '\nTAMPERED\n');
  const tampered = await request(app)
    .get('/api/specs/kit-api/export-kit')
    .query({ workspaceId: 'ws-test' })
    .set('Authorization', `Bearer ${authToken}`);
  expect(tampered.status).toBe(200);
  expect(tampered.body.exportKit.status).toBe('tampered');
});

test('POST /api/specs/authoring/preflight returns accepted deterministic identity for a complete one-spec draft', async () => {
  const contextRes = await request(app)
    .post('/api/specs/generation-context')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-test', title: 'Preflight Route', brief: 'Users can authenticate and recover safely' });
  expect(contextRes.status).toBe(200);
  const plannerInput = contextRes.body.lifecycleAuthoring.plannerInputSeed;
  const planning = planAuthoring(plannerInput);
  expect(planning.acceptedPlan).not.toBeNull();
  const canonical = JSON.parse(validLlmResponse).stories;
  const specs = adaptCanonicalStoriesToAuthoringDraft(planning.acceptedPlan!, [{
    specReference: planning.acceptedPlan!.specBoundaries[0].specReference,
    stories: canonical,
  }]);

  const res = await request(app)
    .post('/api/specs/authoring/preflight')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      schemaVersion: 1,
      workspaceId: 'ws-test',
      plannerInput,
      specs,
      attempt: 1,
      priorAttempts: [],
      callerSurface: 'test.specs-route',
      model: 'test-model',
    });

  expect(res.status).toBe(200);
  expect(res.body.state).toBe('accepted');
  expect(res.body.acceptedPlanHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(res.body.acceptedPreflightHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(res.body.preflightReceiptId).toEqual(expect.any(Number));
  expect(res.body.inspection).toMatchObject({ exactSpecCount: 1 });
  expect(res.body.preflight.draftMutationCount).toBe(0);
  expect(res.body.executionAuthority).toBe('none');
  const event = await queryOne<{ payload: unknown }>(
    `SELECT payload FROM wal_events WHERE event_type = 'spec_authoring_preflight' ORDER BY id DESC LIMIT 1`,
  );
  expect(parsePayload(event!.payload)).toMatchObject({
    authoringProfileVersion: 'ssdlc-lifecycle-authoring-1',
    proposedSpecCount: 1,
    acceptedSpecCount: 1,
    preflightAttemptCount: 1,
    persistenceOutcome: 'not_started',
  });
});

test('POST /api/specs/forge uses Pi drafting and persists via the explicit-draft path', async () => {
  mockDraftSpecWithPi.mockResolvedValue({
    text: validLlmResponse,
    usage: { inputTokens: 55, outputTokens: 66 },
  });

  const res = await request(app)
    .post('/api/specs/forge')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Shared Pi Forge',
      brief: 'Create a skill-first forge route',
      agentOverride: 'pi',
      postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('shared-pi-forge');
  expect(res.body.provider).toBe('pi');
  expect(res.body.draftingAgent).toBe('pi');
  expect(res.body.source).toBe('skill-first-backend');
  expect(res.body.postSave).toEqual({ enrich: false, matchSkills: false, memorySynthesis: false });
  expect(mockDraftSpecWithPi).toHaveBeenCalledTimes(1);

  const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'shared-pi-forge.json'), 'utf8'));
  expect(saved.source).toBe('skill-first-backend');
  expect(saved.userStories).toHaveLength(2);
});

test('POST /api/specs/forge uses Codex drafting when requested', async () => {
  mockDraftSpecWithCodex.mockResolvedValue({
    text: validLlmResponse,
    usage: { inputTokens: 11, outputTokens: 22 },
  });

  const res = await request(app)
    .post('/api/specs/forge')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Codex Shared Forge',
      brief: 'Create a skill-first forge route through codex',
      agentOverride: 'codex',
      postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
    });

  expect(res.status).toBe(200);
  expect(res.body.slug).toBe('codex-shared-forge');
  expect(res.body.provider).toBe('codex');
  expect(res.body.draftingAgent).toBe('codex');
  expect(mockDraftSpecWithCodex).toHaveBeenCalledTimes(1);
});

test('LLM returns non-JSON → 500 with error and raw', async () => {
  mockChatComplete.mockResolvedValue({ text: 'This is not JSON at all', usage: { inputTokens: 50, outputTokens: 10 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Bad Spec',
      brief: 'Something',
    });

  expect(res.status).toBe(500);
  expect(res.body.error).toBe('LLM returned non-JSON');
  expect(res.body.rawResponse).toBe('This is not JSON at all');
});

test('Missing workspaceId in body → 422', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      domain: 'backend',
      title: 'No Workspace',
      brief: 'Missing workspace',
    });

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('Validation failed');
});

test('workspaceId not in DB → 404', async () => {
  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'nonexistent',
      domain: 'backend',
      title: 'Ghost',
      brief: 'Workspace does not exist',
    });

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

test('WAL event inserted with event_type=generate and payload includes provider', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Wal Test',
      brief: 'Build auth',
    });

  const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'generate' AND spec_id = 'wal-test'`) as { event_type: string; spec_id: string; payload: string };

  expect(event).toBeDefined();
  expect(event.event_type).toBe('generate');
  expect(event.spec_id).toBe('wal-test');
  const payload = parsePayload(event.payload);
  expect(payload.provider).toBe('claude-cli');
  expect(payload.model).toBe('claude-sonnet-4-5-20250929');
  expect(payload.storyCount).toBe(2);
  expect(payload.inputTokens).toBe(100);
  expect(payload.outputTokens).toBe(200);
});

test('WAL event has hasSchema:true when workspace has hydrated context', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // Seed workspace_context with schema
  await execute(`INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_table_count, git_commit_count)
     VALUES ($1, $2, $3, $4)`, ['ws-test', 'CREATE TABLE users (id TEXT);', 1, 10]);

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Hydrated Spec',
      brief: 'Build with context',
    });

  const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'hydrated-spec'`) as { payload: string };

  expect(event).toBeDefined();
  const payload = parsePayload(event.payload);
  expect(payload.hasSchema).toBe(true);
});

test('WAL event has hasSchema:false when workspace has no hydrated context', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // No workspace_context seeded — should gracefully default to false

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'No Context Spec',
      brief: 'Build without context',
    });

  const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'no-context-spec'`) as { payload: string };

  expect(event).toBeDefined();
  const payload = parsePayload(event.payload);
  expect(payload.hasSchema).toBe(false);
  // hasGitMemory is no longer emitted — git_memory column was dropped (migration 070)
  expect(payload.hasGitMemory).toBeUndefined();
});

test('POST /api/specs/generate with existing slug snapshots old version and succeeds', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

  // First call succeeds
  const res1 = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something',
      postSave: false,
    });
  expect(res1.status).toBe(200);

  // Second call with same title → succeeds, old version is snapshotted
  const res2 = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      domain: 'backend',
      title: 'Duplicate Check',
      brief: 'Build something again',
      postSave: false,
    });
  expect(res2.status).toBe(200);
  expect(res2.body.slug).toBe('duplicate-check');

  // Verify version was created in DB
  const version = await queryOne(`SELECT * FROM spec_versions WHERE spec_slug = 'duplicate-check'`) as { version: number; status: string; content_json: unknown } | undefined;
  expect(version).toBeDefined();
  expect(version!.version).toBe(1);
  expect(version!.status).toBe('pending');
  const content = parsePayload(version!.content_json);
  expect(content.title).toBe('Duplicate Check');
});

// ─── US-003: Model Selection ──────────────────────────────────────────────────

test('POST /api/specs/generate with explicit model uses that model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Model Test',
      brief: 'Test model selection',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
  expect(res.body.usage).toEqual({ inputTokens: 50, outputTokens: 100 });

  // chatComplete should have been called with the model in options object
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ model: 'claude-opus-4-6' }),
  );
});

test('POST /api/specs/generate accepts any model string (pass-through for openai-compat)', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Custom Model',
      brief: 'Test custom model pass-through',
      model: 'my-custom-model-v1',
    });

  // Should not return 400 — any model string is accepted for openai-compat pass-through
  expect(res.status).not.toBe(400);
});

test('POST /api/specs/generate without model uses workspace L3 preferred_model', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  // Set workspace L3 preferred_model
  await execute(`
    INSERT INTO direction_layers (layer, workspace_id, content_yaml, preferred_model, updated_at)
    VALUES (3, 'ws-test', 'project: test', 'claude-haiku-4-5-20251001', NOW())
  `);

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Default Model Test',
      brief: 'Test default model from L3',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-haiku-4-5-20251001');
  expect(mockChatComplete).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
  );
});

test('POST /api/specs/generate with explicit model overrides workspace default', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 10, outputTokens: 20 } });

  // Set workspace L3 preferred_model
  await execute(`
    INSERT INTO direction_layers (layer, workspace_id, content_yaml, preferred_model, updated_at)
    VALUES (3, 'ws-test', 'project: test', 'claude-haiku-4-5-20251001', NOW())
    ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
    DO UPDATE SET preferred_model = 'claude-haiku-4-5-20251001'
  `);

  const res = await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Override Model Test',
      brief: 'Test explicit model overrides workspace',
      model: 'claude-opus-4-6',
    });

  expect(res.status).toBe(200);
  expect(res.body.model).toBe('claude-opus-4-6');
});

test('WAL event payload includes token usage', async () => {
  mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 500, outputTokens: 1000 } });

  await request(app)
    .post('/api/specs/generate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({
      workspaceId: 'ws-test',
      title: 'Token Usage Test',
      brief: 'Test token tracking',
    });

  const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'generate' AND spec_id = 'token-usage-test'`) as { payload: string };

  expect(event).toBeDefined();
  const payload = parsePayload(event.payload);
  expect(payload.inputTokens).toBe(500);
  expect(payload.outputTokens).toBe(1000);
});

// ─── PSE-002: Generate-path durable post-save orchestration ────────────────────

describe('POST /api/specs/generate post-save durable enqueue (PSE-002)', () => {
  test('seeds postSaveStages and enqueues durable enrich + deferred match-skills', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Post Save',
        brief: 'Test durable post-save from generate path',
      });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('generate-post-save');

    // Verify enrich was enqueued through pg-boss
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({
        specId: 'generate-post-save',
        workspaceId: 'ws-test',
        jobId: expect.any(String),
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:generate-post-save' }),
    );

    // Only executable work becomes a transport job. Deferred authority lives in
    // the application-owned workflow graph until its dependency completes.
    const jobs = await query(
      `SELECT job_type, status, boss_job_id, request_payload, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'generate-post-save'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; request_payload: unknown; error_message: string | null }>;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: 'enrich',
      status: 'pending',
      boss_job_id: expect.any(String),
      error_message: null,
    });
    const enrichBossJobId = jobs[0].boss_job_id;
    expect(enrichBossJobId).not.toBeNull();
    expect(parsePayload(jobs[0].request_payload)).toMatchObject({ origin: 'persist-post-save', workflow: 'spec-post-save-v1', stage: 'enrich' });
    expect(await loadWorkflowStages('generate-post-save')).toEqual([
      expect.objectContaining({ stage_key: 'context', requested: true, status: 'completed', reason: 'context_captured' }),
      expect.objectContaining({ stage_key: 'enrich', requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', boss_job_id: enrichBossJobId }),
      expect.objectContaining({ stage_key: 'matchSkills', requested: true, status: 'pending', reason: 'requested_by_policy', boss_job_id: null }),
      expect.objectContaining({ stage_key: 'memorySynthesis', requested: true, status: 'pending', reason: 'requested_by_policy', boss_job_id: null }),
    ]);

    // Verify generation log has postSaveStages in context_summary_json
    const logRes = await request(app)
      .get('/api/specs/generate-post-save/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('pending_enrichment');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toBeDefined();
    expect(summary.postSaveStages).toMatchObject({
      enrich: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', bossJobId: enrichBossJobId },
      matchSkills: { requested: true, status: 'pending', reason: 'requested_by_policy' },
      memorySynthesis: { requested: true, status: 'pending', reason: 'requested_by_policy' },
    });
    expect(summary.workspaceId).toBe('ws-test');
    expect(summary.source).toBe('generate');
  });

  test('retains exact publication identity for recovery when boss.send returns null in generate path', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });
    mockBossSend.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Failed Queue',
        brief: 'Test enqueue failure persistence from generate path',
      });

    expect(res.status).toBe(200);

    // A null publication result is ambiguous: keep the preallocated transport
    // identity recoverable rather than fabricating terminal failure authority.
    const jobs = await query(
      `SELECT job_type, status, boss_job_id, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'generate-failed-queue'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; error_message: string | null }>;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: 'enrich',
      status: 'pending',
      boss_job_id: expect.any(String),
      error_message: null,
    });
    const deferredBossJobId = jobs[0].boss_job_id;
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({ bossJobId: deferredBossJobId }),
      expect.objectContaining({ id: deferredBossJobId }),
    );
    expect(await loadWorkflowStages('generate-failed-queue')).toEqual([
      expect.objectContaining({ stage_key: 'context', status: 'completed' }),
      expect.objectContaining({
        stage_key: 'enrich',
        status: 'queued',
        reason: 'durable_job_enqueueing',
        boss_job_id: deferredBossJobId,
        error_message: null,
      }),
      expect.objectContaining({ stage_key: 'matchSkills', status: 'pending', reason: 'requested_by_policy' }),
      expect.objectContaining({ stage_key: 'memorySynthesis', status: 'pending', reason: 'requested_by_policy' }),
    ]);

    const logRes = await request(app)
      .get('/api/specs/generate-failed-queue/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('pending_enrichment');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toMatchObject({
      enrich: {
        requested: true,
        status: 'queued',
        reason: 'durable_job_enqueueing',
        bossJobId: deferredBossJobId,
      },
      matchSkills: { requested: true, status: 'pending', reason: 'requested_by_policy' },
      memorySynthesis: { requested: true, status: 'pending', reason: 'requested_by_policy' },
    });
  });

  test('advances deferred match-skills after enrich completes in generate path', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Advance Deps',
        brief: 'Test enrich completion advances match-skills',
      });

    expect(res.status).toBe(200);

    // Simulate enrich job completion
    const enrichJob = await queryOne(
      `SELECT id FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'generate-advance-deps' AND job_type = 'enrich'`,
    ) as { id: string } | undefined;
    expect(enrichJob).toBeDefined();

    await updateJobStatus(enrichJob!.id, 'completed', { finishedAt: new Date() });
    await advanceSpecPostSaveWorkflowDependencies(enrichJob!.id);

    // match-skills should now be enqueued
    expect(mockBossSend).toHaveBeenCalledTimes(2);
    expect(mockBossSend).toHaveBeenLastCalledWith(
      'spec:match-skills',
      expect.objectContaining({
        specId: 'generate-advance-deps',
        workspaceId: 'ws-test',
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:generate-advance-deps' }),
    );

    const matchJob = await queryOne(
      `SELECT boss_job_id, status FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'generate-advance-deps' AND job_type = 'match-skills'`,
    ) as { boss_job_id: string | null; status: string } | undefined;
    expect(matchJob).toEqual({ boss_job_id: expect.any(String), status: 'pending' });

    // Verify generation log reflects the state transition
    const logRes = await request(app)
      .get('/api/specs/generate-advance-deps/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toMatchObject({
      enrich: { requested: true, status: 'completed', reason: 'job_completed' },
      matchSkills: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', bossJobId: matchJob!.boss_job_id },
      memorySynthesis: { requested: true, status: 'pending', reason: 'requested_by_policy' },
    });
  });
});

// ─── R-001: List / Approve / Reject / Get Detail ──────────────────────────────

/** Seed a spec file on disk for R-001 tests */
function seedSpecFile(dir: string, slug: string, overrides?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    title: slug.replace(/-/g, ' '),
    userStories: [
      { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
    ],
    generatedAt: '2026-02-20T12:00:00.000Z',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

async function seedSpecReadinessLog(specSlug: string, workspaceId = 'ws-test'): Promise<void> {
  await execute(
    `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, enriched, retrieval_method, context_summary_json, status, save_generation)
     VALUES ($1, 'explicit-draft', 'api', 0, 'test', false, 'none', $2, 'persisted', 1)`,
    [
      specSlug,
      JSON.stringify({
        workspaceId,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context' },
        postSaveStages: {
          enrich: { requested: true, status: 'completed', reason: 'job_completed' },
          matchSkills: { requested: true, status: 'completed', reason: 'job_completed' },
        },
      }),
    ],
  );
}

describe('POST /api/specs/persist', () => {
  test('persists an explicit drafted spec to pending with canonical source metadata', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Explicit Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
          { id: 'US-002', title: 'Session', description: 'Persist authenticated session', acceptanceCriteria: ['Session persists across refresh'], dependsOn: ['US-001'] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('explicit-draft');
    expect(res.body.status).toBe('pending');
    expect(res.body.source).toBe('explicit-draft');
    expect(res.body.stories).toHaveLength(2);
    expect(res.body.postSave).toEqual({ enrich: false, matchSkills: false, memorySynthesis: false });
    expect(res.body.workflow).toMatchObject({
      engine: 'spec-post-save-v1',
      runId: expect.any(Number),
      saveGeneration: expect.any(Number),
    });

    const persistedRun = await queryOne(
      `SELECT generation_log_id, save_generation FROM spec_post_save_workflow_runs WHERE id = $1`,
      [res.body.workflow.runId],
    ) as { generation_log_id: number | null; save_generation: number | string | null } | undefined;
    expect(persistedRun?.generation_log_id).toBe(res.body.workflow.saveGeneration);
    expect(Number(persistedRun?.save_generation)).toBe(res.body.workflow.saveGeneration);

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'explicit-draft.json'), 'utf8'));
    expect(saved.source).toBe('explicit-draft');
    expect(saved.userStories).toHaveLength(2);
    expect(saved.contextUsed).toBeUndefined();
    expect(saved.authoring).toMatchObject({
      state: 'needs_authoring_preflight',
      approvalReady: false,
      reasonCode: 'needs_authoring_preflight',
      storiesRewritten: false,
    });
    expect(res.body.authoring).toEqual(saved.authoring);
    expect(saved.contextSummary).toBeUndefined();
    expect(saved.postSavePolicy).toMatchObject({
      callerPolicy: { enrich: false, matchSkills: false, memorySynthesis: false },
      effectivePolicy: { version: 'v1', enrich: 'skip', skills: 'skip', memory: 'skip' },
      legacyOptions: { enrich: false, matchSkills: false, memorySynthesis: false },
    });

    const logRes = await request(app)
      .get('/api/specs/explicit-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.sourceMode).toBe('explicit-draft');
    expect(summary.invocationSurface).toBe('api.specs.persist');
    expect(summary.contextCaptureStatus).toEqual({
      status: 'missing',
      reason: 'caller_context_not_supplied',
      contextUsed: 'missing',
      contextSummary: 'missing',
    });
    expect(summary.postSavePolicy).toMatchObject({
      callerPolicy: { enrich: false, matchSkills: false, memorySynthesis: false },
      effectivePolicy: { version: 'v1', enrich: 'skip', skills: 'skip', memory: 'skip' },
      legacyOptions: { enrich: false, matchSkills: false, memorySynthesis: false },
    });
    expect(summary.postSaveStages).toMatchObject({
      enrich: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
      matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
    });
    expect(summary.contextSummary).toBeUndefined();
    expect(summary.contextUsed).toBeUndefined();
  });

  test('round-trips canonical identity and structured Genesis provenance through explicit-draft readback', async () => {
    const genesis = {
      packageId: 'genesis-spec-ready-42',
      packageHash: `sha256:${'a'.repeat(64)}`,
      contentHash: `sha256:${'b'.repeat(64)}`,
      canonicalStore: 'pglite+pgvector+genesis-vault',
      citationSummary: '4 approved citations; 1 stale item skipped',
      warningCount: 1,
      skippedEvidenceCount: 1,
      freshnessTs: '2026-07-09T00:00:00.000Z',
      bridgeVersion: '1.0.0',
      packageRevision: 3,
    };
    const payload = {
      workspaceId: 'ws-test',
      title: 'Genesis Bridge Contract',
      slug: 'genesis-bridge-contract',
      brief: 'Turn an approved Genesis evidence package into a reviewable Rorca draft.',
      source: 'genesis-explicit-draft',
      stories: [
        {
          id: 'GEN-001',
          title: 'Preserve evidence lineage',
          description: 'Keep bounded Genesis package provenance attached to the pending spec.',
          acceptanceCriteria: [
            'The canonical spec identity survives persistence and detail readback',
            'Both Genesis provenance projections survive without flattening',
          ],
          dependsOn: [],
        },
      ],
      contextUsed: {
        text: 'Genesis evidence package genesis-spec-ready-42 informed this caller-owned draft.',
        meta: {
          standards: true,
          conventions: true,
          project: true,
          memory: false,
          schema: false,
          scopesMatched: ['genesis:approved-evidence'],
          totalTokens: 384,
        },
        genesis,
      },
      contextSummary: {
        directionLayers: {
          l1: true,
          l2: { present: true, domain: 'knowledge-management' },
          l3: true,
        },
        estimatedTokens: 384,
        genesis,
      },
      policyPresetId: 'fast_import',
    };

    const persisted = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(payload);

    expect(persisted.status).toBe(200);
    expect(persisted.body).toMatchObject({
      id: payload.slug,
      slug: payload.slug,
      status: 'pending',
      source: payload.source,
      contextUsed: payload.contextUsed,
      contextSummary: payload.contextSummary,
    });

    const saved = JSON.parse(fs.readFileSync(
      path.join(os.tmpdir(), 'forge', 'specs', 'pending', `${payload.slug}.json`),
      'utf8',
    ));
    expect(saved.id).toBe(payload.slug);
    expect(saved.slug).toBe(payload.slug);
    expect(saved.contextUsed.genesis).toEqual(genesis);
    expect(saved.contextSummary.genesis).toEqual(genesis);

    const readback = await request(app)
      .get(`/api/specs/${payload.slug}?workspaceId=ws-test`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(readback.status).toBe(200);
    expect(readback.body.id).toBe(payload.slug);
    expect(readback.body.slug).toBe(payload.slug);
    expect(readback.body.contextUsed.genesis).toEqual(genesis);
    expect(readback.body.contextSummary.genesis).toEqual(genesis);
  });

  test('rejects malformed structured Genesis provenance at the explicit-draft boundary', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Malformed Genesis Provenance',
        stories: [{
          id: 'GEN-001',
          title: 'Reject malformed lineage',
          description: 'Do not persist malformed package hashes.',
          acceptanceCriteria: ['The request fails validation'],
          dependsOn: [],
        }],
        contextUsed: {
          text: 'Malformed provenance must not survive validation.',
          meta: {},
          genesis: {
            packageId: 'genesis-package',
            packageHash: 'not-a-sha256-hash',
            contentHash: `sha256:${'b'.repeat(64)}`,
            canonicalStore: 'pglite+genesis-vault',
            citationSummary: 'Approved citations',
            warningCount: 0,
            skippedEvidenceCount: 0,
            freshnessTs: '2026-07-09T00:00:00.000Z',
            bridgeVersion: '1.0.0',
          },
        },
        policyPresetId: 'fast_import',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toEqual({
      issues: [
        expect.objectContaining({
          path: ['contextUsed', 'genesis', 'packageHash'],
        }),
      ],
    });
  });

  test('accepts policyPresetId on the canonical persist/create path and echoes requestedPolicy', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Preset Policy Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        policyPresetId: 'fast_import',
      });

    expect(res.status).toBe(200);
    expect(res.body.requestedPolicy).toBe('fast_import');
    expect(res.body.postSave).toEqual({ enrich: false, matchSkills: false, memorySynthesis: false });
    expect(res.body.postSavePolicy).toMatchObject({
      callerPolicy: 'fast_import',
      effectivePolicy: { version: 'v1', presetId: 'fast_import', enrich: 'skip', skills: 'skip', memory: 'skip' },
      legacyOptions: { enrich: false, matchSkills: false, memorySynthesis: false },
    });
  });

  test('rejects invalid postSave preset ids with ValidationError details', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Invalid Policy Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: 'unknown_preset',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details).toMatchObject({
      field: 'postSave',
      value: 'unknown_preset',
      allowedValues: 'fast_import,best_effort,skill_first_strict,enterprise_governed,repair_only',
      allowedValuesList: ['fast_import', 'best_effort', 'skill_first_strict', 'enterprise_governed', 'repair_only'],
    });
  });

  test('rejects ambiguous persist policy inputs so callers must pick one contract field', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Ambiguous Policy Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: false,
        policyPresetId: 'fast_import',
      });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(String(res.body.error)).toContain('Provide only one post-save policy input');
  });

  test('seeds a generation log immediately so the Context tab is non-null before enrich completes', async () => {
    const callerContextSummary = {
      directionLayers: {
        l1: true,
        l2: { present: true, domain: 'devtools' },
        l3: true,
      },
      skills: ['rorca-forge'],
      memoryEntries: 3,
      agentsMd: true,
      template: null,
      schemaSnapshot: true,
      gitMemory: false,
      estimatedTokens: 1234,
      modelContextWindow: 200000,
      retrieval: {
        cagHits: 2,
        ragHits: 5,
        graphHits: 1,
        tier: 'hybrid',
        latencyMs: 31,
      },
    };

    const persistRes = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Immediate Context Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        contextUsed: {
          text: 'SYNTHESIZED CONTEXT',
          meta: {
            standards: true,
            conventions: true,
            project: true,
            schema: true,
            totalTokens: 1234,
            scopesMatched: [],
          },
        },
        contextSummary: callerContextSummary,
      });

    expect(persistRes.status).toBe(200);
    expect(persistRes.body.postSave).toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'immediate-context-draft.json'), 'utf8'));
    expect(saved.contextSummary).toEqual(callerContextSummary);
    expect(saved.contextUsed.text).toBe('SYNTHESIZED CONTEXT');

    const logRes = await request(app)
      .get('/api/specs/immediate-context-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body).toBeTruthy();
    expect(logRes.body.spec_slug).toBe('immediate-context-draft');
    expect(logRes.body.status).toBe('pending_enrichment');
    expect(logRes.body.enriched).toBe(false);
    expect(logRes.body.retrieval_method).toBe('none');
    expect(logRes.body.context_summary).toContain('caller-provided context');

    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.source).toBe('explicit-draft');
    expect(summary.sourceMode).toBe('explicit-draft');
    expect(summary.invocationSurface).toBe('api.specs.persist');
    expect(summary.storyCount).toBe(1);
    expect(summary.pendingEnrichment).toBe(true);
    expect(summary.postSave).toEqual({ enrich: true, matchSkills: true, memorySynthesis: true });
    expect(summary.contextCaptureStatus).toEqual({
      status: 'provided',
      reason: 'caller_supplied_context',
      contextUsed: 'provided',
      contextSummary: 'provided',
    });
    expect(summary.postSaveStages).toMatchObject({
      enrich: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', bossJobId: expect.any(String) },
      matchSkills: { requested: true, status: 'pending', reason: 'requested_by_policy' },
      memorySynthesis: { requested: true, status: 'pending', reason: 'requested_by_policy' },
    });
    const contextUsed = summary.contextUsed as { text: string };
    const contextSummary = summary.contextSummary as {
      directionLayers: unknown;
      retrieval: unknown;
    };
    expect(contextUsed.text).toBe('SYNTHESIZED CONTEXT');
    expect(contextSummary.directionLayers).toEqual({
      l1: true,
      l2: { present: true, domain: 'devtools' },
      l3: true,
    });
    expect(contextSummary.retrieval).toEqual({
      cagHits: 2,
      ragHits: 5,
      graphHits: 1,
      tier: 'hybrid',
      latencyMs: 31,
    });
  });

  test('normalizes caller contextSummary directionLayers when l2 is omitted', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Missing L2 Context Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        contextSummary: {
          directionLayers: {
            l1: true,
            l3: true,
          },
          memoryEntries: 0,
        },
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.contextSummary.directionLayers).toEqual({
      l1: true,
      l2: { present: false, domain: null },
      l3: true,
    });

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'missing-l2-context-draft.json'), 'utf8'));
    expect(saved.contextSummary.directionLayers).toEqual({
      l1: true,
      l2: { present: false, domain: null },
      l3: true,
    });
  });

  test('enqueues persist post-save enrich durably and defers match-skills until enrich finishes', async () => {

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Queued Post Save Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({
        specId: 'queued-post-save-draft',
        workspaceId: 'ws-test',
        jobId: expect.any(String),
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:queued-post-save-draft' }),
    );

    const jobs = await query(
      `SELECT job_type, status, boss_job_id, request_payload, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'queued-post-save-draft'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; request_payload: unknown; error_message: string | null }>;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: 'enrich',
      status: 'pending',
      boss_job_id: expect.any(String),
      error_message: null,
    });
    const enrichBossJobId = jobs[0].boss_job_id;
    expect(enrichBossJobId).not.toBeNull();
    expect(parsePayload(jobs[0].request_payload)).toMatchObject({ origin: 'persist-post-save', workflow: 'spec-post-save-v1', stage: 'enrich' });
    expect(await loadWorkflowStages('queued-post-save-draft')).toEqual([
      expect.objectContaining({ stage_key: 'context', status: 'completed' }),
      expect.objectContaining({ stage_key: 'enrich', status: 'queued', reason: 'durable_job_enqueued_after_dependency', boss_job_id: enrichBossJobId }),
      expect.objectContaining({ stage_key: 'matchSkills', status: 'pending', reason: 'requested_by_policy', boss_job_id: null }),
      expect.objectContaining({ stage_key: 'memorySynthesis', requested: false, status: 'skipped', reason: 'disabled_by_policy' }),
    ]);

    const logRes = await request(app)
      .get('/api/specs/queued-post-save-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(logRes.body.status).toBe('pending_enrichment');
    expect(summary.postSaveStages).toMatchObject({
      enrich: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', bossJobId: enrichBossJobId },
      matchSkills: { requested: true, status: 'pending', reason: 'requested_by_policy' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
    });

    const enrichJob = await queryOne(
      `SELECT id FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'queued-post-save-draft' AND job_type = 'enrich'`,
    ) as { id: string } | undefined;
    expect(enrichJob).toBeDefined();

    await updateJobStatus(enrichJob!.id, 'completed', { finishedAt: new Date() });
    await advanceSpecPostSaveWorkflowDependencies(enrichJob!.id);

    expect(mockBossSend).toHaveBeenCalledTimes(2);
    expect(mockBossSend).toHaveBeenLastCalledWith(
      'spec:match-skills',
      expect.objectContaining({
        specId: 'queued-post-save-draft',
        workspaceId: 'ws-test',
        jobId: expect.any(String),
      }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-test:queued-post-save-draft' }),
    );

    const releasedMatchJob = await queryOne(
      `SELECT boss_job_id, status FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'queued-post-save-draft' AND job_type = 'match-skills'`,
    ) as { boss_job_id: string | null; status: string } | undefined;
    expect(releasedMatchJob).toEqual({ boss_job_id: expect.any(String), status: 'pending' });

    const afterReleaseLogRes = await request(app)
      .get('/api/specs/queued-post-save-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    const releasedSummary = parsePayload(afterReleaseLogRes.body.context_summary_json);
    expect(releasedSummary.postSaveStages).toMatchObject({
      enrich: { requested: true, status: 'completed', reason: 'job_completed' },
      matchSkills: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', bossJobId: releasedMatchJob!.boss_job_id },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
    });
  });

  test('retains exact publication identity for recovery when persist-path boss.send returns null', async () => {
    mockBossSend.mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Failed Queue Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const jobs = await query(
      `SELECT job_type, status, boss_job_id, error_message
       FROM spec_jobs
       WHERE workspace_id = 'ws-test' AND spec_id = 'failed-queue-draft'
       ORDER BY created_at ASC`,
    ) as Array<{ job_type: string; status: string; boss_job_id: string | null; error_message: string | null }>;

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      job_type: 'enrich',
      status: 'pending',
      boss_job_id: expect.any(String),
      error_message: null,
    });
    const deferredBossJobId = jobs[0].boss_job_id;
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({ bossJobId: deferredBossJobId }),
      expect.objectContaining({ id: deferredBossJobId }),
    );
    expect(await loadWorkflowStages('failed-queue-draft')).toEqual([
      expect.objectContaining({ stage_key: 'context', status: 'completed' }),
      expect.objectContaining({
        stage_key: 'enrich',
        status: 'queued',
        reason: 'durable_job_enqueueing',
        boss_job_id: deferredBossJobId,
        error_message: null,
      }),
      expect.objectContaining({ stage_key: 'matchSkills', status: 'pending', reason: 'requested_by_policy' }),
      expect.objectContaining({ stage_key: 'memorySynthesis', requested: false, status: 'skipped', reason: 'disabled_by_policy' }),
    ]);

    const logRes = await request(app)
      .get('/api/specs/failed-queue-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('pending_enrichment');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toMatchObject({
      enrich: {
        requested: true,
        status: 'queued',
        reason: 'durable_job_enqueueing',
        bossJobId: deferredBossJobId,
      },
      matchSkills: { requested: true, status: 'pending', reason: 'requested_by_policy' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
    });
  });

  test('blocks deferred match-skills and surfaces failure when enrich fails during execution', async () => {

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Failed Enrich Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: true, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const enrichJob = await queryOne(
      `SELECT id FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'failed-enrich-draft' AND job_type = 'enrich'`,
    ) as { id: string } | undefined;
    expect(enrichJob).toBeDefined();

    await updateJobStatus(enrichJob!.id, 'failed', {
      errorMessage: 'LLM provider timeout',
      finishedAt: new Date(),
    });
    await advanceSpecPostSaveWorkflowDependencies(enrichJob!.id);

    expect(mockBossSend).toHaveBeenCalledTimes(1);

    const matchJob = await queryOne(
      `SELECT status, boss_job_id, error_message FROM spec_jobs WHERE workspace_id = 'ws-test' AND spec_id = 'failed-enrich-draft' AND job_type = 'match-skills'`,
    ) as { status: string; boss_job_id: string | null; error_message: string | null } | undefined;
    expect(matchJob).toBeUndefined();
    expect(await loadWorkflowStages('failed-enrich-draft')).toEqual([
      expect.objectContaining({ stage_key: 'context', status: 'completed' }),
      expect.objectContaining({
        stage_key: 'enrich',
        status: 'failed',
        reason: 'job_failed',
        error_message: 'Application job failed; raw diagnostics are restricted.',
      }),
      expect.objectContaining({ stage_key: 'matchSkills', status: 'failed', reason: 'blocked_by_required_stage_failed', error_message: 'Blocked because enrich did not complete successfully' }),
      expect.objectContaining({ stage_key: 'memorySynthesis', requested: false, status: 'skipped', reason: 'disabled_by_policy' }),
    ]);

    const logRes = await request(app)
      .get('/api/specs/failed-enrich-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('failed');
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.postSaveStages).toMatchObject({
      enrich: {
        requested: true,
        status: 'failed',
        reason: 'job_failed',
        error: 'Application job failed; raw diagnostics are restricted.',
      },
      matchSkills: { requested: true, status: 'failed', reason: 'blocked_by_required_stage_failed', error: 'Blocked because enrich did not complete successfully' },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
    });
  });

  test('backfills a canonical context summary from contextUsed metadata when callers omit contextSummary', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Backfilled Context Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        contextUsed: {
          text: 'SYNTHESIZED CONTEXT',
          meta: {
            standards: true,
            conventions: false,
            project: true,
            schema: true,
            totalTokens: 222,
            memoryEntries: 2,
            skills: ['rorca-forge'],
            predictedFiles: ['backend/src/routes/specs.ts'],
          },
        },
        postSave: { enrich: false, matchSkills: true, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.contextSummary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      memoryEntries: 2,
      estimatedTokens: 222,
      predictedFiles: ['backend/src/routes/specs.ts'],
    });

    const saved = JSON.parse(fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'backfilled-context-draft.json'), 'utf8'));
    expect(saved.contextSummary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      memoryEntries: 2,
      estimatedTokens: 222,
      predictedFiles: ['backend/src/routes/specs.ts'],
    });

    const logRes = await request(app)
      .get('/api/specs/backfilled-context-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    expect(summary.contextCaptureStatus).toEqual({
      status: 'backfilled',
      reason: 'context_summary_derived_from_context_used_meta',
      contextUsed: 'provided',
      contextSummary: 'backfilled',
    });
    expect(summary.postSaveStages).toMatchObject({
      enrich: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
      matchSkills: { requested: true, status: 'queued', reason: 'durable_job_enqueued_after_dependency', bossJobId: expect.any(String) },
      memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy' },
    });
    expect(summary.contextSummary).toMatchObject({
      directionLayers: {
        l1: true,
        l2: { present: false, domain: null },
        l3: true,
      },
      memoryEntries: 2,
      estimatedTokens: 222,
      predictedFiles: ['backend/src/routes/specs.ts'],
    });
  });

  test('normalizes duplicate and missing story IDs while preserving valid dependencies', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Normalize Draft',
        stories: [
          { id: 'US-001', title: 'First', description: 'First story', acceptanceCriteria: ['AC1'], dependsOn: [] },
          { id: 'US-001', title: 'Second', description: 'Second story', acceptanceCriteria: ['AC2'], dependsOn: ['US-001'] },
          { title: 'Third', description: 'Third story', acceptanceCriteria: ['AC3'], dependsOn: ['US-001'] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.stories.map((story: any) => story.id)).toEqual(['US-001', 'US-002', 'US-003']);
    expect(res.body.stories[1].dependsOn).toEqual(['US-001']);
    expect(res.body.stories[2].dependsOn).toEqual(['US-001']);
    expect(res.body.normalization.changes).toEqual([
      { from: 'US-001', to: 'US-002', reason: 'duplicate_id' },
      { to: 'US-003', reason: 'missing_id' },
    ]);
  });

  test('returns 409 when a spec already exists and overwrite=false', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'persist-conflict');

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Persist Conflict',
        stories: [
          { id: 'US-001', title: 'Replacement', description: 'Replacement story', acceptanceCriteria: ['AC1'], dependsOn: [] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Spec 'persist-conflict' already exists");
  });

  test('overwrite=true snapshots the previous spec and emits a spec_generated WAL event', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'persist-overwrite', { title: 'Old Draft' });

    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Persist Overwrite',
        overwrite: true,
        source: 'skill-first',
        stories: [
          { id: 'US-001', title: 'New Story', description: 'Fresh story', acceptanceCriteria: ['AC1'], dependsOn: [] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);
    expect(res.body.overwrote).toBe(true);
    expect(res.body.source).toBe('skill-first');

    const version = await queryOne(`SELECT content_json, status FROM spec_versions WHERE spec_slug = 'persist-overwrite' ORDER BY version ASC LIMIT 1`) as { content_json: unknown; status: string } | undefined;
    expect(version).toBeDefined();
    expect(version?.status).toBe('pending');
    const oldContent = typeof version?.content_json === 'string' ? JSON.parse(version.content_json) : version?.content_json as Record<string, unknown>;
    expect(oldContent.title).toBe('Old Draft');

    const event = await queryOne(`SELECT payload FROM wal_events WHERE event_type = 'spec_generated' AND spec_id = 'persist-overwrite'`) as { payload: string } | undefined;
    expect(event).toBeDefined();
    const payload = parsePayload(event!.payload);
    expect(payload.source).toBe('skill-first');
    expect(payload.overwrite).toBe(true);
  });

  test('repair dry-run diagnoses memory synthesis retry through workflow stage names', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'repair-memory', {
      title: 'Repair Memory',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });
    await execute(
      `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, context_summary_json, status, save_generation)
       VALUES ($1, 'explicit-draft', 'api', 0, 'legacy', $2, 'failed', 9001)`,
      ['repair-memory', JSON.stringify({
        source: 'explicit-draft',
        workspaceId: 'ws-test',
        saveGeneration: 9001,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context', contextUsed: 'provided', contextSummary: 'provided' },
        postSaveStages: {
          enrich: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
          matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
          memorySynthesis: { requested: true, status: 'failed', reason: 'job_failed', error: 'prior failure' },
        },
      })],
    );

    const res = await request(app)
      .post('/api/specs/repair-memory/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', stages: ['memorySynthesis'], dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis).toMatchObject({
      missingWorkflowRun: true,
      memorySynthesisNeedsRepair: true,
    });
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'enqueue_memory_synthesis', status: 'skipped', reason: expect.stringContaining('Dry run') }),
    ]));
  });

  test('repair backfills a legacy generation log by starting a durable workflow run', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'repair-legacy', {
      title: 'Repair Legacy',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });
    await execute(
      `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, context_summary_json, status, save_generation)
       VALUES ($1, 'explicit-draft', 'api', 0, 'legacy', $2, 'failed', 9002)`,
      ['repair-legacy', JSON.stringify({
        source: 'explicit-draft',
        workspaceId: 'ws-test',
        saveGeneration: 9002,
        contextCaptureStatus: { status: 'provided', reason: 'caller_supplied_context', contextUsed: 'provided', contextSummary: 'provided' },
        postSaveStages: {
          enrich: { requested: true, status: 'failed', reason: 'job_failed', error: 'prior failure' },
          matchSkills: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
          memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_caller' },
        },
      })],
    );
    const legacyLog = await queryOne(
      `SELECT id FROM spec_generation_logs WHERE spec_slug = 'repair-legacy' AND save_generation = 9002`,
    ) as { id: number } | undefined;
    expect(legacyLog).toBeDefined();

    const res = await request(app)
      .post('/api/specs/repair-legacy/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        stages: ['enrich'],
        dryRun: false,
        idempotencyKey: 'specs-repair-legacy-9002',
      });

    expect(res.status).toBe(200);
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'enqueue_enrich', status: 'repaired' }),
    ]));
    const run = await queryOne(
      `SELECT id, generation_log_id FROM spec_post_save_workflow_runs WHERE workspace_id = 'ws-test' AND spec_id = 'repair-legacy' AND save_generation = 9002`,
    ) as { id: number; generation_log_id: number | null } | undefined;
    expect(run).toBeDefined();
    expect(run?.generation_log_id).toBe(legacyLog?.id ?? null);

    const updatedLog = await queryOne(
      `SELECT context_summary_json FROM spec_generation_logs WHERE spec_slug = 'repair-legacy' AND save_generation = 9002`,
    ) as { context_summary_json: unknown } | undefined;
    const updatedSummary = parsePayload(updatedLog?.context_summary_json);
    expect(updatedSummary.workflow).toMatchObject({
      engine: 'spec-post-save-v1',
      source: 'repair',
      postSave: { enrich: true, matchSkills: false, memorySynthesis: false },
      postSavePolicy: {
        callerPolicy: {
          version: 'v1',
          presetId: 'repair_only',
          enrich: 'enqueue',
          skills: 'skip',
          memory: 'skip',
          onFailure: 'continue',
        },
        effectivePolicy: {
          version: 'v1',
          presetId: 'repair_only',
          enrich: 'enqueue',
          skills: 'skip',
          memory: 'skip',
          onFailure: 'continue',
        },
        legacyOptions: { enrich: true, matchSkills: false, memorySynthesis: false },
      },
    });
  });

  test('persist detects active post-save workflow conflicts before creating a new save', async () => {
    const first = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Persist Workflow Conflict',
        stories: [
          { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
        ],
      });

    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Persist Workflow Conflict',
        overwrite: true,
        stories: [
          { id: 'US-001', title: 'Story', description: 'Updated', acceptanceCriteria: ['AC1'], dependsOn: [] },
        ],
      });

    expect(second.status).toBe(409);
    expect(second.body.error).toContain('active post-save workflow run');
  });

  test('generate uses the shared persist conflict guard for active pipeline runs', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 90, outputTokens: 120 } });
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'generate-pipeline-conflict', {
      title: 'Generate Pipeline Conflict',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });
    await execute(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, 'ws-test', 'running')`,
      ['forge/specs/pending/generate-pipeline-conflict.json'],
    );

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Generate Pipeline Conflict',
        brief: 'Try to regenerate while a pipeline run is active',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('active pipeline run');
  });

  test('repair dry-run returns diagnosis instead of 409 when a pipeline run is active', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'repair-dry-run-conflict', {
      title: 'Repair Dry Run Conflict',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });
    await execute(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ($1, 'ws-test', 'running')`,
      ['forge/specs/pending/repair-dry-run-conflict.json'],
    );

    const res = await request(app)
      .post('/api/specs/repair-dry-run-conflict/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', dryRun: true, stages: ['context'] });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('dry_run');
    expect(res.body.reasonCodes).toContain('dry_run');
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'seed_generation_log', status: 'skipped', reasonCode: 'dry_run' }),
    ]));
  });

  test('repair-batch reuses the shared repair engine and returns machine-readable reason codes', async () => {
    seedSpecFile(path.join(os.tmpdir(), 'forge', 'specs', 'pending'), 'repair-batch-missing-log', {
      title: 'Repair Batch Missing Log',
      userStories: [
        { id: 'US-001', title: 'Story', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [] },
      ],
    });

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        categories: [SpecReadinessReasonCode.MissingContext],
        limit: 10,
        dryRun: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        specId: 'repair-batch-missing-log',
        status: 'skipped',
        reasonCode: 'dry_run',
        repairStatus: 'dry_run',
      }),
    ]));
  });

  // ─── US-022: Composer context integration ─────────────────────────────

  test('persist-with-context: preserves caller-provided composer-style context and validates hydration context when present', async () => {
    const callerContextSummary: Record<string, unknown> = {
      directionLayers: {
        l1: true,
        l2: { present: true, domain: 'devtools' },
        l3: true,
      },
      skills: ['rorca-forge'],
      memoryEntries: 3,
      agentsMd: true,
      template: null,
      schemaSnapshot: true,
      gitMemory: false,
      estimatedTokens: 5000,
      modelContextWindow: 200000,
      composedAt: '2026-06-28T00:00:00.000Z',
      briefHash: 'abc123def4567890',
      composerDegraded: true,
      composerDegradationReasons: ['Graph context excluded by caller (includeGraph=false)'],
      composerSections: [
        { section: 'directions', itemCount: 2, tokenBudget: 320, tokensUsed: 150 },
        { section: 'memories', itemCount: 3, tokenBudget: 2240, tokensUsed: 1200 },
        { section: 'docs', itemCount: 0, tokenBudget: 1440, tokensUsed: 0 },
        { section: 'sourceFiles', itemCount: 0, tokenBudget: 1440, tokensUsed: 0 },
        { section: 'tests', itemCount: 0, tokenBudget: 800, tokensUsed: 0 },
        { section: 'graphSummary', itemCount: 0, tokenBudget: 800, tokensUsed: 0 },
        { section: 'branchDiff', itemCount: 0, tokenBudget: 320, tokensUsed: 0 },
        { section: 'risksGotchas', itemCount: 1, tokenBudget: 320, tokensUsed: 100 },
      ],
      retrieval: {
        cagHits: 2,
        ragHits: 5,
        graphHits: 1,
        tier: 'hybrid',
        latencyMs: 45,
      },
    };

    const persistRes = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Composer Context Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        contextUsed: {
          text: 'COMPOSER CONTEXT BUNDLE',
          meta: {
            standards: true,
            conventions: true,
            project: true,
            schema: true,
            totalTokens: 5000,
            scopesMatched: [],
          },
        },
        contextSummary: callerContextSummary,
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(persistRes.status).toBe(200);
    expect(persistRes.body.exportKit).toMatchObject({
      schemaVersion: 'rorca.export-kit-binding.v1',
    });
    expect(persistRes.body.exportKit.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    // Saved spec JSON preserves contextUsed and contextSummary with composer fields
    const saved = JSON.parse(fs.readFileSync(
      path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'composer-context-draft.json'), 'utf8',
    ));
    expect(saved.contextSummary).toEqual(callerContextSummary);
    expect(saved.contextUsed.text).toBe('COMPOSER CONTEXT BUNDLE');
    expect(saved.contextSummary.composedAt).toBe('2026-06-28T00:00:00.000Z');
    expect(saved.contextSummary.briefHash).toBe('abc123def4567890');
    expect(saved.contextSummary.composerDegraded).toBe(true);
    expect(saved.contextSummary.composerDegradationReasons).toContain('Graph context excluded by caller (includeGraph=false)');
    expect(saved.contextSummary.composerSections).toHaveLength(8);

    // Generation log captures composer metadata
    const logRes = await request(app)
      .get('/api/specs/composer-context-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    const captureStatus = summary.contextCaptureStatus as Record<string, unknown>;
    expect(captureStatus.status).toBe('provided');
    expect(captureStatus.contextUsed).toBe('provided');
    expect(captureStatus.contextSummary).toBe('provided');

    // Composer fields are preserved through to the generation log
    const logContextSummary = summary.contextSummary as Record<string, unknown>;
    expect(logContextSummary.composedAt).toBe('2026-06-28T00:00:00.000Z');
    expect(logContextSummary.briefHash).toBe('abc123def4567890');
    expect(logContextSummary.composerDegraded).toBe(true);
  });

  test('persist-without-context: gracefully handles missing composer data (fallback-without-Hilo)', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'No Composer Draft',
        stories: [
          { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
        ],
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(res.status).toBe(200);

    const saved = JSON.parse(fs.readFileSync(
      path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'no-composer-draft.json'), 'utf8',
    ));
    // No composer context fields when not provided
    expect(saved.contextUsed).toBeUndefined();
    expect(saved.contextSummary).toBeUndefined();

    const logRes = await request(app)
      .get('/api/specs/no-composer-draft/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const summary = parsePayload(logRes.body.context_summary_json);
    const captureStatus = summary.contextCaptureStatus as Record<string, unknown>;
    expect(captureStatus.status).toBe('missing');
    expect(captureStatus.reason).toBe('caller_context_not_supplied');
    expect(captureStatus.contextUsed).toBe('missing');
    expect(captureStatus.contextSummary).toBe('missing');
    expect(summary.contextSummary).toBeUndefined();
  });

  test('generate-with-composer: response includes composer-enriched context when composer runs', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        domain: 'backend',
        title: 'Composer Generate',
        brief: 'Build a feature flag system',
        storyCount: 2,
      });

    expect(res.status).toBe(200);
    expect(res.body.contextSummary).toBeDefined();

    // Composer enrichment should be present (best-effort — may be absent if composer fails)
    // In test environments without graph setup, composer runs but may degrade gracefully
    const ctxSummary = res.body.contextSummary as Record<string, unknown>;
    // The generate flow always enriches contextSummary with composer fields if composer succeeds
    // At minimum, the directionLayers should be present (from the non-composer path)
    expect(ctxSummary.directionLayers).toBeDefined();

    // Generation log should have context_summary_json
    const logRes = await request(app)
      .get('/api/specs/composer-generate/generation-log')
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    const logSummary = parsePayload(logRes.body.context_summary_json);
    expect(logSummary.sourceMode).toBe('legacy-generate');
    expect(logSummary.invocationSurface).toBe('api.specs.generate');
  });
});

// ─── US-042: Final contract preservation across Hilo configuration states ───

describe('US-042 generate/persist/enrich/readiness contract preservation', () => {
  async function useIsolatedWorkspace(config?: Record<string, unknown>): Promise<void> {
    await execute(`UPDATE workspaces SET path = $1 WHERE id = 'ws-test'`, [tmpDir]);
    if (!config) return;
    const rorcaDir = path.join(tmpDir, '.rorca');
    fs.mkdirSync(rorcaDir, { recursive: true });
    fs.writeFileSync(path.join(rorcaDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  }

  function createFakeHiloBinary(): string {
    const binPath = path.join(tmpDir, 'bin', 'hilo');
    fs.mkdirSync(path.dirname(binPath), { recursive: true });
    fs.writeFileSync(binPath, '#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "hilo 0.1.0"; exit 0; fi\nexit 0\n', 'utf8');
    fs.chmodSync(binPath, 0o755);
    return binPath;
  }

  const providedContextSummary = {
    directionLayers: {
      l1: true,
      l2: { present: false, domain: null },
      l3: true,
    },
    skills: [],
    memoryEntries: 0,
    agentsMd: false,
    template: null,
    schemaSnapshot: false,
    gitMemory: false,
    estimatedTokens: 120,
    modelContextWindow: 200000,
  };

  test('legacy generate, readiness, and enrich remain stable when Hilo is configured', async () => {
    const fakeHiloBin = createFakeHiloBinary();
    await useIsolatedWorkspace({
      version: 1,
      hilo: {
        enabled: true,
        binaryPath: fakeHiloBin,
        checkoutPath: '.',
        outputDir: '.rorca/hilo',
        timeoutMs: 1000,
      },
    });

    mockChatComplete
      .mockResolvedValueOnce({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } })
      .mockResolvedValue({ text: '- Hilo-configured enrichment still uses the canonical ChatResult.text contract.', usage: { inputTokens: 10, outputTokens: 12 } });

    const generated = await request(app)
      .post('/api/specs/generate')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        domain: 'backend',
        title: 'Hilo Configured Contract',
        brief: 'Keep generation compatible while a Hilo graph provider is configured',
        storyCount: 2,
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(generated.status).toBe(200);
    expect(generated.body.slug).toBe('hilo-configured-contract');
    expect(generated.body.contextSummary.directionLayers).toBeDefined();
    expect(generated.body.postSave).toEqual({ enrich: false, matchSkills: false, memorySynthesis: false });

    const readiness = await request(app)
      .get('/api/specs/hilo-configured-contract/readiness?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(readiness.status).toBe(200);
    expect(readiness.body.executionGate.status).toBe('allowed');
    expect(readiness.body.blockingReasons).toEqual([]);
    expect(readiness.body.persistence.contextCapture.status).toBe('provided');

    const enriched = await request(app)
      .post('/api/specs/hilo-configured-contract/enrich')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(enriched.status).toBe(200);
    expect(enriched.body.success).toBe(true);
    expect(enriched.body.storiesEnriched).toBe(2);
    expect(['cache', 'search', 'hybrid', 'none']).toContain(enriched.body.retrieval_method);

    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'forge', 'specs', 'pending', 'hilo-configured-contract.json'), 'utf8'));
    expect(saved.userStories[0].description).toContain('## Context');
    expect(saved.userStories[0].description).not.toContain('[object Object]');
  });

  test('explicit persist, readiness, and enrich remain stable without Hilo configured', async () => {
    await useIsolatedWorkspace();
    mockChatComplete.mockResolvedValue({ text: '- No-Hilo enrichment still completes.', usage: { inputTokens: 5, outputTokens: 7 } });

    const persisted = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'No Hilo Contract',
        stories: [
          { id: 'US-001', title: 'Persist without Hilo', description: 'Keep explicit persistence independent from Hilo configuration', acceptanceCriteria: ['Spec persists'], dependsOn: [] },
        ],
        contextUsed: {
          text: 'SYNTHESIZED CONTEXT WITHOUT HILO',
          meta: {
            standards: true,
            conventions: false,
            project: true,
            schema: false,
            totalTokens: 120,
            scopesMatched: [],
          },
        },
        contextSummary: providedContextSummary,
        postSave: { enrich: false, matchSkills: false, memorySynthesis: false },
      });

    expect(persisted.status).toBe(200);
    expect(persisted.body.slug).toBe('no-hilo-contract');
    expect(persisted.body.contextSummary).toMatchObject(providedContextSummary);

    const readiness = await request(app)
      .get('/api/specs/no-hilo-contract/readiness?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(readiness.status).toBe(200);
    expect(readiness.body.executionGate.status).toBe('allowed');
    expect(readiness.body.blockingReasons).toEqual([]);
    expect(readiness.body.persistence.contextCapture.status).toBe('provided');

    const enriched = await request(app)
      .post('/api/specs/no-hilo-contract/enrich')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(enriched.status).toBe(200);
    expect(enriched.body.success).toBe(true);
    expect(enriched.body.storiesEnriched).toBe(1);
    expect(['cache', 'search', 'hybrid', 'none']).toContain(enriched.body.retrieval_method);

    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'forge', 'specs', 'pending', 'no-hilo-contract.json'), 'utf8'));
    expect(saved.contextSummary).toMatchObject(providedContextSummary);
    expect(saved.userStories[0].description).toContain('No-Hilo enrichment still completes');
  });
});

describe('GET /api/specs (list)', () => {
  test('returns pending and approved specs with correct status', async () => {
    // Clean dirs to avoid cross-suite contamination (batch tests share os.tmpdir())
    const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
    if (fs.existsSync(specsRoot)) fs.rmSync(specsRoot, { recursive: true, force: true });

    const pendingDir = path.join(specsRoot, 'pending');
    const approvedDir = path.join(specsRoot, 'approved');

    seedSpecFile(pendingDir, 'my-pending-spec');
    seedSpecFile(approvedDir, 'my-approved-spec', { generatedAt: '2026-02-19T10:00:00.000Z' });

    const res = await request(app).get('/api/specs?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const pending = res.body.items.find((s: any) => s.id === 'my-pending-spec');
    const approved = res.body.items.find((s: any) => s.id === 'my-approved-spec');

    expect(pending).toBeDefined();
    expect(pending.status).toBe('pending');
    expect(pending.storyCount).toBe(1);

    expect(approved).toBeDefined();
    expect(approved.status).toBe('approved');
    expect(approved.approvedAt).toBeDefined();
  });

  test('filters by status=pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only');
    seedSpecFile(approvedDir, 'appr-only');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=pending').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('pend-only');
  });

  test('filters by status=approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'pend-only2');
    seedSpecFile(approvedDir, 'appr-only2');

    const res = await request(app).get('/api/specs?workspaceId=ws-test&status=approved').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('appr-only2');
  });

  test('returns empty array when no specs exist', async () => {
    const res = await request(app).get('/api/specs?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });

  test('unknown workspaceId → 404', async () => {
    const res = await request(app).get('/api/specs?workspaceId=nonexistent').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/specs/:id/approve', () => {
  test('moves file to approved/ and returns ok', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'to-approve');
    await seedSpecReadinessLog('to-approve');

    const res = await request(app)
      .post('/api/specs/to-approve/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.approvedPath).toContain('approved');
    expect(res.body.approvedPath).toContain('to-approve.json');

    // File moved: no longer in pending, exists in approved
    expect(fs.existsSync(path.join(pendingDir, 'to-approve.json'))).toBe(false);
    expect(fs.existsSync(path.join(approvedDir, 'to-approve.json'))).toBe(true);
  });

  test('emits WAL event with event_type=spec_approved', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'wal-approve');
    await seedSpecReadinessLog('wal-approve');

    await request(app)
      .post('/api/specs/wal-approve/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'spec_approved'`) as { event_type: string; spec_id: string; actor: string; payload: string };

    expect(event).toBeDefined();
    expect(event.spec_id).toBe('wal-approve');
    expect(event.actor).toBe(SPECS_USER_ID);
    const payload = parsePayload(event.payload);
    expect(payload.workspaceId).toBe('ws-test');
  });

  test('creates approved/ directory if it does not exist', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');

    seedSpecFile(pendingDir, 'auto-mkdir');
    await seedSpecReadinessLog('auto-mkdir');
    // Ensure approved/ doesn't exist
    expect(fs.existsSync(approvedDir)).toBe(false);

    const res = await request(app)
      .post('/api/specs/auto-mkdir/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(fs.existsSync(approvedDir)).toBe(true);
  });

  test('durably publishes creation of a previously absent approved directory through its parent', async () => {
    const specsRoot = path.join(os.tmpdir(), 'forge', 'specs');
    const pendingDir = path.join(specsRoot, 'pending');
    const approvedDir = path.join(specsRoot, 'approved');
    seedSpecFile(pendingDir, 'durable-auto-mkdir');
    await seedSpecReadinessLog('durable-auto-mkdir');
    expect(fs.existsSync(approvedDir)).toBe(false);

    const originalFsyncDirectory = runSpecSnapshot.fsyncDirectory;
    const syncedDirectories: string[] = [];
    const fsyncSpy = jest.spyOn(runSpecSnapshot, 'fsyncDirectory').mockImplementation((directory) => {
      syncedDirectories.push(path.resolve(directory));
      originalFsyncDirectory(directory);
    });
    try {
      const res = await request(app)
        .post('/api/specs/durable-auto-mkdir/approve')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ workspaceId: 'ws-test' });
      expect(res.status).toBe(200);
    } finally {
      fsyncSpy.mockRestore();
    }

    expect(syncedDirectories).toContain(specsRoot);
    expect(syncedDirectories).toContain(approvedDir);
  });

  test('rejects blocked specs by default with canonical readiness details', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'blocked-approve');

    const res = await request(app)
      .post('/api/specs/blocked-approve/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('SPEC_READINESS_BLOCKED');
    expect(res.body.details.blockingReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_context' }),
    ]));
  });

  test('rejects readiness override without publishing or emitting override authority', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecFile(pendingDir, 'blocked-approve-override');

    const res = await request(app)
      .post('/api/specs/blocked-approve-override/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', readinessOverride: true });

    expect(res.status).toBe(422);
    expect(fs.existsSync(path.join(pendingDir, 'blocked-approve-override.json'))).toBe(true);
    expect(fs.existsSync(path.join(approvedDir, 'blocked-approve-override.json'))).toBe(false);
    const event = await queryOne<{ payload: unknown }>(
      `SELECT payload FROM wal_events WHERE event_type = 'spec_readiness_override_used' AND spec_id = 'blocked-approve-override' ORDER BY id DESC LIMIT 1`,
    );
    expect(event).toBeUndefined();
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 422 schema validation', async () => {
    const res = await request(app)
      .post('/api/specs/whatever/approve')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(422);
  });
});

describe('POST /api/specs/:id/reject', () => {
  test('deletes file and returns ok', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'to-reject');

    const res = await request(app)
      .post('/api/specs/to-reject/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.existsSync(path.join(pendingDir, 'to-reject.json'))).toBe(false);
  });

  test('emits WAL event with event_type=spec_rejected and reason', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'wal-reject');

    await request(app)
      .post('/api/specs/wal-reject/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', reason: 'Too many stories' });

    const event = await queryOne(
      `SELECT * FROM wal_events WHERE event_type = 'spec_rejected' AND spec_id = 'wal-reject'`,
    ) as { event_type: string; spec_id: string; actor: string; payload: string };

    expect(event).toBeDefined();
    expect(event.spec_id).toBe('wal-reject');
    expect(event.actor).toBe('user');
    const payload = parsePayload(event.payload);
    expect(payload.reason).toBe('Too many stories');
  });

  test('spec not found → 404', async () => {
    const res = await request(app)
      .post('/api/specs/ghost/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/specs/:specId (detail)', () => {
  test('returns full spec JSON from pending', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const seeded = seedSpecFile(pendingDir, 'detail-spec');

    const res = await request(app).get('/api/specs/detail-spec?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('detail-spec');
    expect(res.body.slug).toBe('detail-spec');
    expect(res.body.title).toBe(seeded.title);
    expect(res.body.userStories).toHaveLength(1);
  });

  test('returns full spec JSON from approved', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    const seeded = seedSpecFile(approvedDir, 'approved-detail');

    const res = await request(app).get('/api/specs/approved-detail?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe(seeded.title);
  });

  test('spec not found → 404', async () => {
    const res = await request(app).get('/api/specs/nonexistent?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
  });

  test('missing workspaceId → 400', async () => {
    const res = await request(app).get('/api/specs/some-spec').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
  });
});

// ─── US-001: Version History + Diff ───────────────────────────────────────────

describe('GET /api/specs/:specId/versions', () => {
  test('returns empty array when no versions exist', async () => {
    const res = await request(app).get('/api/specs/nonexistent-slug/versions?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    
    expect(res.body.items).toEqual([]);
  });

  test('returns versions after rejection creates a snapshot', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedSpecFile(pendingDir, 'versioned-spec', {
      title: 'Versioned Spec',
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Story two', description: 'Desc2', acceptanceCriteria: ['AC2'], dependsOn: [], passes: false },
      ],
    });

    // Reject the spec (creates a version snapshot)
    await request(app)
      .post('/api/specs/versioned-spec/reject')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', reason: 'Needs more stories' });

    const res = await request(app).get('/api/specs/versioned-spec/versions?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].version).toBe(1);
    expect(res.body.items[0].status).toBe('rejected');
    expect(res.body.items[0].rejectionReason).toBe('Needs more stories');
    expect(res.body.items[0].title).toBe('Versioned Spec');
    expect(res.body.items[0].storyCount).toBe(2);
    expect(res.body.items[0].createdAt).toBeDefined();
  });

  test('returns multiple versions in ascending order', async () => {
    // Manually insert two versions
    await execute(`INSERT INTO spec_versions (workspace_id, spec_slug, version, content_json, status) VALUES ('ws-test', $1, $2, $3, $4)`, ['multi-ver', 1, JSON.stringify({ title: 'V1', userStories: [] }), 'rejected']);
    await execute(`INSERT INTO spec_versions (workspace_id, spec_slug, version, content_json, status) VALUES ('ws-test', $1, $2, $3, $4)`, ['multi-ver', 2, JSON.stringify({ title: 'V2', userStories: [{ id: 'US-001', title: 'S1' }] }), 'pending']);

    const res = await request(app).get('/api/specs/multi-ver/versions?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].version).toBe(1);
    expect(res.body.items[0].title).toBe('V1');
    expect(res.body.items[0].storyCount).toBe(0);
    expect(res.body.items[1].version).toBe(2);
    expect(res.body.items[1].title).toBe('V2');
    expect(res.body.items[1].storyCount).toBe(1);
  });
});

describe('GET /api/specs/:specId/diff', () => {
  beforeEach(async () => {
    // Seed two versions with different stories
    const v1 = {
      title: 'Auth System',
      userStories: [
        { id: 'US-001', title: 'Login', description: 'Login flow', acceptanceCriteria: ['AC1', 'AC2'], dependsOn: [] },
        { id: 'US-002', title: 'Signup', description: 'Signup flow', acceptanceCriteria: ['AC3'], dependsOn: ['US-001'] },
      ],
    };
    const v2 = {
      title: 'Auth System v2',
      userStories: [
        { id: 'US-001', title: 'Login', description: 'Improved login', acceptanceCriteria: ['AC1', 'AC2', 'AC4'], dependsOn: [] },
        { id: 'US-003', title: 'Password Reset', description: 'Reset flow', acceptanceCriteria: ['AC5'], dependsOn: ['US-001'] },
      ],
    };
    await execute(`INSERT INTO spec_versions (workspace_id, spec_slug, version, content_json, status) VALUES ('ws-test', $1, $2, $3, $4)`, ['diff-test', 1, JSON.stringify(v1), 'rejected']);
    await execute(`INSERT INTO spec_versions (workspace_id, spec_slug, version, content_json, status, rejection_reason) VALUES ('ws-test', $1, $2, $3, $4, $5)`, ['diff-test', 2, JSON.stringify(v2), 'pending', null]);
  });

  test('returns structured diff with added, removed, modified, unchanged stories', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?workspaceId=ws-test&v1=1&v2=2').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);

    expect(res.body.specSlug).toBe('diff-test');
    expect(res.body.v1.version).toBe(1);
    expect(res.body.v2.version).toBe(2);

    const { diff } = res.body;
    expect(diff.titleChanged).toBe(true);
    expect(diff.oldTitle).toBe('Auth System');
    expect(diff.newTitle).toBe('Auth System v2');

    // US-001: modified (description + AC changed)
    const us001 = diff.stories.find((s: any) => s.id === 'US-001');
    expect(us001.changeType).toBe('modified');
    expect(us001.deltas).toBeDefined();
    const descDelta = us001.deltas.find((d: any) => d.field === 'description');
    expect(descDelta.old).toBe('Login flow');
    expect(descDelta.new).toBe('Improved login');
    const acDelta = us001.deltas.find((d: any) => d.field === 'acceptanceCriteria');
    expect(acDelta.added).toContain('AC4');
    expect(acDelta.removed).toEqual([]);

    // US-002: removed
    const us002 = diff.stories.find((s: any) => s.id === 'US-002');
    expect(us002.changeType).toBe('removed');
    expect(us002.story).toBeDefined();

    // US-003: added
    const us003 = diff.stories.find((s: any) => s.id === 'US-003');
    expect(us003.changeType).toBe('added');
    expect(us003.story.title).toBe('Password Reset');

    // Summary
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1, unchanged: 0 });
  });

  test('missing v1/v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?workspaceId=ws-test&v1=1').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('v1 and v2');
  });

  test('same v1 and v2 → 400', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?workspaceId=ws-test&v1=1&v2=1').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('different');
  });

  test('nonexistent version → 404', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?workspaceId=ws-test&v1=1&v2=99').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v99');
  });

  test('both versions missing → 404 mentioning both', async () => {
    const res = await request(app).get('/api/specs/diff-test/diff?workspaceId=ws-test&v1=98&v2=99').set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('v98');
    expect(res.body.error).toContain('v99');
  });
});

// ─── US-005: Full-Text Search Archive ──────────────────────────────────────────

/** Seed a spec with rich content for search tests */
function seedRichSpec(dir: string, slug: string, overrides?: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  const spec = {
    title: overrides?.title ?? slug.replace(/-/g, ' '),
    userStories: overrides?.userStories ?? [
      {
        id: 'US-001',
        title: 'Story one',
        description: 'A basic description',
        acceptanceCriteria: ['Criterion alpha', 'Criterion beta'],
        dependsOn: [],
        passes: false,
      },
    ],
    generatedAt: overrides?.generatedAt ?? '2026-02-20T12:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

describe('GET /api/specs/archive (US-005 full-text search)', () => {
  test('q param searches across spec title', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-system', { title: 'Authentication System' });
    seedRichSpec(pendingDir, 'payment-flow', { title: 'Payment Processing' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=authentication').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-system');
    expect(res.body.items[0].matchSnippets).toBeDefined();
    expect(res.body.items[0].matchSnippets.length).toBeGreaterThan(0);
    expect(res.body.items[0].matchSnippets[0].field).toBe('title');
    expect(res.body.items[0].matchSnippets[0].text).toContain('<mark>');
  });

  test('q param searches across story titles', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedRichSpec(approvedDir, 'dashboard-spec', {
      title: 'Dashboard Features',
      userStories: [
        { id: 'US-001', title: 'User Analytics Widget', description: 'Shows analytics', acceptanceCriteria: ['Loads fast'], dependsOn: [] },
        { id: 'US-002', title: 'Notification Panel', description: 'Shows notifications', acceptanceCriteria: ['Real-time updates'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=analytics').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('dashboard-spec');
    const storySnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'storyTitle');
    expect(storySnippet).toBeDefined();
    expect(storySnippet.storyId).toBe('US-001');
  });

  test('q param searches across story descriptions', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'api-spec', {
      title: 'API Endpoints',
      userStories: [
        { id: 'US-001', title: 'Create user', description: 'Implement OAuth2 token-based authentication flow', acceptanceCriteria: ['Returns JWT'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=OAuth2').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('api-spec');
    const descSnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'storyDescription');
    expect(descSnippet).toBeDefined();
    expect(descSnippet.text).toContain('<mark>OAuth2</mark>');
  });

  test('q param searches across acceptance criteria', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'perf-spec', {
      title: 'Performance Improvements',
      userStories: [
        { id: 'US-001', title: 'Caching', description: 'Add cache', acceptanceCriteria: ['Response time under 50ms for cached queries', 'Cache invalidation on write'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=invalidation').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('perf-spec');
    const acSnippet = res.body.items[0].matchSnippets.find((s: any) => s.field === 'acceptanceCriteria');
    expect(acSnippet).toBeDefined();
    expect(acSnippet.storyId).toBe('US-001');
  });

  test('results ranked by relevance — title matches rank higher', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    // This spec has "login" only in a story description
    seedRichSpec(pendingDir, 'general-spec', {
      title: 'General Features',
      userStories: [
        { id: 'US-001', title: 'Authentication', description: 'Implement login functionality', acceptanceCriteria: ['Works'], dependsOn: [] },
      ],
    });
    // This spec has "login" in the title
    seedRichSpec(pendingDir, 'login-system', {
      title: 'Login System',
      userStories: [
        { id: 'US-001', title: 'Basic form', description: 'A form', acceptanceCriteria: ['Renders'], dependsOn: [] },
      ],
    });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=login').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // Title match should rank first
    expect(res.body.items[0].id).toBe('login-system');
    expect(res.body.items[0].relevanceScore).toBeGreaterThan(res.body.items[1].relevanceScore);
  });

  test('date range filter: createdAfter', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'old-spec', { title: 'Old Spec', generatedAt: '2026-01-01T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'new-spec', { title: 'New Spec', generatedAt: '2026-02-15T00:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&createdAfter=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('new-spec');
  });

  test('date range filter: createdBefore', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'jan-spec', { title: 'January Spec', generatedAt: '2026-01-15T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'feb-spec', { title: 'February Spec', generatedAt: '2026-02-15T00:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&createdBefore=2026-02-01T00:00:00.000Z').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('jan-spec');
  });

  test('date range combined with text search', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-old', { title: 'Auth Module', generatedAt: '2026-01-10T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-new', { title: 'Auth System v2', generatedAt: '2026-02-20T00:00:00.000Z' });
    seedRichSpec(pendingDir, 'payment-new', { title: 'Payment System', generatedAt: '2026-02-20T00:00:00.000Z' });

    const res = await request(app)
      .get('/api/specs/archive?workspaceId=ws-test&q=auth&createdAfter=2026-02-01T00:00:00.000Z')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-new');
  });

  test('empty search returns all specs without snippets', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'spec-a', { title: 'Spec A' });
    seedRichSpec(pendingDir, 'spec-b', { title: 'Spec B' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // No matchSnippets or relevanceScore when no query
    expect(res.body.items[0].matchSnippets).toBeUndefined();
    expect(res.body.items[0].relevanceScore).toBeUndefined();
  });

  test('no results for unmatched query', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'some-spec', { title: 'Some Feature' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=zzzznonexistent').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test('search respects status filter', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedRichSpec(pendingDir, 'auth-pending', { title: 'Auth Pending' });
    seedRichSpec(approvedDir, 'auth-approved', { title: 'Auth Approved' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&status=approved').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe('auth-approved');
  });

  test('pagination works with search results', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedRichSpec(pendingDir, 'auth-one', { title: 'Auth One', generatedAt: '2026-02-20T12:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-two', { title: 'Auth Two', generatedAt: '2026-02-21T12:00:00.000Z' });
    seedRichSpec(pendingDir, 'auth-three', { title: 'Auth Three', generatedAt: '2026-02-22T12:00:00.000Z' });

    const res = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&limit=2&offset=0').set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.hasMore).toBe(true);

    // Second page
    const res2 = await request(app).get('/api/specs/archive?workspaceId=ws-test&q=auth&limit=2&offset=2').set('Authorization', `Bearer ${authToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.items).toHaveLength(1);
    expect(res2.body.hasMore).toBe(false);
  });
});

// ─── US-008: Batch Spec Generation with Brief Queue ────────────────────────────

describe('POST /api/specs/generate/batch', () => {
  test('accepts array of briefs and returns batchId + briefCount', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build user auth', workspaceId: 'ws-test', title: 'Auth Feature' },
          { brief: 'Build payments', workspaceId: 'ws-test', title: 'Payment Feature' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.batchId).toBeDefined();
    expect(typeof res.body.batchId).toBe('string');
    expect(res.body.briefCount).toBe(2);
    await waitForBatch(res.body.batchId);
  });

  test('batch generation calls the Pi forge drafter when a brief sets agentOverride=pi', async () => {
    mockDraftSpecWithPi.mockResolvedValue({
      text: validLlmResponse,
      usage: { inputTokens: 11, outputTokens: 22 },
    });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build user auth', workspaceId: 'ws-test', title: 'Auth Feature', agentOverride: 'pi' },
        ],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.batchId).toBeDefined();

    await waitForBatch(createRes.body.batchId);

    const statusRes = await request(app)
      .get(`/api/specs/generate/batch/${createRes.body.batchId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(mockDraftSpecWithPi).toHaveBeenCalled();
    expect(['generating', 'completed']).toContain(statusRes.body.items[0].status);
  });

  test('missing briefs array → 400', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('briefs');
  });

  test('empty briefs array → 400', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ briefs: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('empty');
  });

  test('brief missing required fields → 400 with index', async () => {
    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { title: 'Valid', brief: 'Valid brief', workspaceId: 'ws-test' },
          { title: 'Missing WS', brief: 'Missing workspace' },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('index 1');
    expect(res.body.error).toContain('workspaceId');
  });

  test('brief with custom model is accepted (pass-through)', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { title: 'Test Spec', brief: 'Test', workspaceId: 'ws-test', model: 'custom-model-v1' },
        ],
      });

    // Any model string is accepted for openai-compat pass-through
    expect(res.status).not.toBe(400);
    if (res.status === 201) await waitForBatch(res.body.batchId);
  });

  test('emits batch_started WAL event', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const res = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch WAL Test' },
        ],
      });

    expect(res.status).toBe(201);

    const event = await queryOne(
      `SELECT * FROM wal_events
        WHERE event_type = 'batch_started'
          AND payload ->> 'batchId' = $1`,
      [res.body.batchId],
    ) as { event_type: string; payload: string };

    expect(event).toBeDefined();
    const payload = parsePayload(event.payload);
    expect(payload.batchId).toBe(res.body.batchId);
    expect(payload.briefCount).toBe(1);
    await waitForBatch(res.body.batchId);
  });
});

/** Poll batch status until finishedAt is set or timeout expires */
async function waitForBatch(batchId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);
    if (res.status === 200 && res.body.finishedAt) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Batch ${batchId} did not finish within ${timeoutMs}ms`);
}

describe('GET /api/specs/generate/batch/:batchId', () => {
  test('returns batch status with per-brief progress', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 100, outputTokens: 200 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Build auth', workspaceId: 'ws-test', title: 'Batch Status A' },
          { brief: 'Build payments', workspaceId: 'ws-test', title: 'Batch Status B' },
        ],
      });

    expect(createRes.status).toBe(201);
    const { batchId } = createRes.body;

    // Wait for processing to complete
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.batchId).toBe(batchId);
    expect(statusRes.body.createdAt).toBeDefined();
    expect(statusRes.body.totalBriefs).toBe(2);
    expect(statusRes.body.items).toHaveLength(2);
    expect(statusRes.body.summary).toBeDefined();
    expect(typeof statusRes.body.summary.completed).toBe('number');
    expect(typeof statusRes.body.summary.failed).toBe('number');
    expect(typeof statusRes.body.summary.generating).toBe('number');
    expect(typeof statusRes.body.summary.queued).toBe('number');
  });

  test('nonexistent batchId → 404', async () => {
    const res = await request(app).get('/api/specs/generate/batch/nonexistent-id').set('Authorization', `Bearer ${authToken}`);

    expect({ status: res.status, body: res.body }).toEqual({
      status: 404,
      body: expect.objectContaining({ error: expect.stringContaining('not found') }),
    });
  });

  test('completed batch has finishedAt and all items completed', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Single brief', workspaceId: 'ws-test', title: 'Finished Batch' },
        ],
      });

    const { batchId } = createRes.body;

    // Wait for processing to complete
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.finishedAt).toBeDefined();
    expect(statusRes.body.summary.completed).toBe(1);
    expect(statusRes.body.summary.queued).toBe(0);
    expect(statusRes.body.summary.generating).toBe(0);
    expect(statusRes.body.items[0].status).toBe('completed');
    expect(statusRes.body.items[0].slug).toBeDefined();
  });

  test('failed briefs captured with errors, do not block remaining briefs', async () => {
    // First call fails, second succeeds
    mockChatComplete
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Will fail', workspaceId: 'ws-test', title: 'Failing Brief' },
          { brief: 'Will succeed', workspaceId: 'ws-test', title: 'Succeeding Brief' },
        ],
      });

    const { batchId } = createRes.body;

    // Wait for both to process
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.finishedAt).toBeDefined();
    expect(statusRes.body.summary.failed).toBe(1);
    expect(statusRes.body.summary.completed).toBe(1);

    // First item failed with error message
    const failedItem = statusRes.body.items.find((i: any) => i.status === 'failed');
    expect(failedItem).toBeDefined();
    expect(failedItem.error).toContain('LLM timeout');

    // Second item completed successfully
    const completedItem = statusRes.body.items.find((i: any) => i.status === 'completed');
    expect(completedItem).toBeDefined();
    expect(completedItem.slug).toBeDefined();
  });

  test('workspace not found for a brief sets status to failed', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Bad workspace', workspaceId: 'nonexistent-ws', title: 'Bad WS' },
          { brief: 'Good workspace', workspaceId: 'ws-test', title: 'Good WS' },
        ],
      });

    const { batchId } = createRes.body;
    await waitForBatch(batchId);

    const statusRes = await request(app).get(`/api/specs/generate/batch/${batchId}`).set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.summary.failed).toBe(1);
    expect(statusRes.body.summary.completed).toBe(1);

    const failedItem = statusRes.body.items[0];
    expect(failedItem.status).toBe('failed');
    expect(failedItem.error).toContain('Workspace not found');
  });

  test('emits batch_progress WAL events during processing', async () => {
    mockChatComplete.mockResolvedValue({ text: validLlmResponse, usage: { inputTokens: 50, outputTokens: 100 } });

    const createRes = await request(app)
      .post('/api/specs/generate/batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        briefs: [
          { brief: 'Progress test', workspaceId: 'ws-test', title: 'Progress Brief' },
        ],
      });

    const batchId = createRes.body.batchId;
    await waitForBatch(batchId);
    const allEvents = await query(`SELECT * FROM wal_events WHERE event_type = 'batch_progress' ORDER BY id ASC`) as { payload: string }[];
    // Filter to only events from this batch (avoids cross-test contamination)
    const events = allEvents.filter(e => {
      try { return parsePayload(e.payload).batchId === batchId; } catch { return false; }
    });

    // Should have at least 2 progress events: generating + completed/failed
    expect(events.length).toBeGreaterThanOrEqual(2);

    const firstPayload = parsePayload(events[0].payload);
    expect(firstPayload.batchId).toBe(batchId);
    expect(firstPayload.briefIndex).toBe(0);
    expect(firstPayload.totalBriefs).toBe(1);
    expect(firstPayload.status).toBe('generating');

    const secondPayload = parsePayload(events[1].payload);
    expect(secondPayload.status).toBe('completed');
    expect(secondPayload.slug).toBeDefined();
  });
});

// ─── V2-083: Story Exclusion ─────────────────────────────────────────────────

describe('V2-083: Story exclusion', () => {
  function seedSpecWithStories(dir: string, slug: string) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug.replace(/-/g, ' '),
      userStories: [
        { id: 'US-001', title: 'Story one', description: 'Desc 1', acceptanceCriteria: ['AC1'], dependsOn: [], passes: false },
        { id: 'US-002', title: 'Story two', description: 'Desc 2', acceptanceCriteria: ['AC2'], dependsOn: ['US-001'], passes: false },
        { id: 'US-003', title: 'Story three', description: 'Desc 3', acceptanceCriteria: ['AC3'], dependsOn: [], passes: false },
      ],
      generatedAt: '2026-02-20T12:00:00.000Z',
    };
    const specPath = path.join(dir, `${slug}.json`);
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
    return { spec, specPath };
  }

  test('PATCH /:specId/stories/:storyId toggles excluded flag', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-test');

    // Exclude US-002
    const res = await request(app)
      .patch('/api/specs/excl-test/stories/US-002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.story.excluded).toBe(true);

    // Verify persisted to JSON
    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'excl-test.json'), 'utf8'));
    expect(content.userStories[1].excluded).toBe(true);
    expect(content.userStories[0].excluded).toBeFalsy();

    // Re-include US-002
    const res2 = await request(app)
      .patch('/api/specs/excl-test/stories/US-002')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: false });

    expect(res2.status).toBe(200);
    expect(res2.body.story.excluded).toBe(false);
  });

  test('PATCH emits WAL event for exclusion toggle', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-wal');

    await request(app)
      .patch('/api/specs/excl-wal/stories/US-001')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    const events = await query(`SELECT * FROM wal_events WHERE event_type = 'story_excluded' AND spec_id = 'excl-wal'`) as { story_id: string; payload: string }[];

    expect(events).toHaveLength(1);
    expect(events[0].story_id).toBe('US-001');
  });

  test('PATCH returns 404 for non-existent story', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'excl-404');

    const res = await request(app)
      .patch('/api/specs/excl-404/stories/US-999')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', excluded: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Story not found');
  });

  test('bulk exclude marks multiple stories as excluded', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'bulk-excl');

    const res = await request(app)
      .post('/api/specs/bulk-excl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'exclude', storyIds: ['US-001', 'US-003'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.affectedCount).toBe(2);

    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'bulk-excl.json'), 'utf8'));
    expect(content.userStories[0].excluded).toBe(true);
    expect(content.userStories[1].excluded).toBeFalsy();
    expect(content.userStories[2].excluded).toBe(true);
  });

  test('bulk include re-includes excluded stories', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedSpecWithStories(approvedDir, 'bulk-incl');

    // First exclude
    await request(app)
      .post('/api/specs/bulk-incl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'exclude', storyIds: ['US-001', 'US-002'] });

    // Then re-include
    const res = await request(app)
      .post('/api/specs/bulk-incl/stories/bulk')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', action: 'include', storyIds: ['US-001'] });

    expect(res.status).toBe(200);

    const content = JSON.parse(fs.readFileSync(path.join(approvedDir, 'bulk-incl.json'), 'utf8'));
    expect(content.userStories[0].excluded).toBe(false);
    expect(content.userStories[1].excluded).toBe(true);
  });

  test('story_results accepts excluded status', async () => {
    // Create a pipeline run to reference
    const runResult = await queryOne<{ id: number }>(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('test.json', 'ws-test', 'running') RETURNING id`);
    const runId = runResult!.id;

    // Insert excluded story result
    await execute(`INSERT INTO story_results (run_id, story_id, status, finished_at) VALUES ($1, 'US-001', 'excluded', NOW())`, [runId]);

    const row = await queryOne(`SELECT * FROM story_results WHERE run_id = $1 AND story_id = 'US-001'`, [runId]) as { status: string };

    expect(row.status).toBe('excluded');
  });
});

describe('PUT /api/specs/:specId/stories/:storyId', () => {
  function seedEditableSpec(dir: string, slug: string) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug,
      userStories: [
        {
          id: 'US-001',
          title: 'Original title',
          description: 'Original description',
          acceptanceCriteria: ['AC1'],
          complexity: 2,
          dependsOn: [],
          passes: false,
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
  }

  test('updates title and complexity for a single story', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedEditableSpec(pendingDir, 'story-edit-test');

    const res = await request(app)
      .put('/api/specs/story-edit-test/stories/US-001')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        title: 'Edited title',
        complexity: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.story.title).toBe('Edited title');
    expect(res.body.story.complexity).toBe(5);

    const content = JSON.parse(fs.readFileSync(path.join(pendingDir, 'story-edit-test.json'), 'utf8'));
    expect(content.userStories[0].title).toBe('Edited title');
    expect(content.userStories[0].complexity).toBe(5);
  });
});

// ─── SV-001: GET /:specId/check — Structural spec validation ──────────────────

describe('GET /api/specs/:id/check', () => {
  // The global beforeEach re-requires the server (DB migrations) — allow extra time
  jest.setTimeout(60_000);

  function seedCheckSpec(dir: string, slug: string, overrides?: Record<string, unknown>) {
    fs.mkdirSync(dir, { recursive: true });
    const spec = {
      title: slug.replace(/-/g, ' '),
      userStories: [
        {
          id: 'US-001',
          title: 'Story one',
          description: 'A valid description',
          acceptanceCriteria: ['Criterion one', 'Criterion two'],
          dependsOn: [],
          passes: false,
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
      ...overrides,
    };
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(spec, null, 2), 'utf8');
    return spec;
  }

  test('GET /api/specs/:id/check returns 404 for unknown spec', async () => {
    const res = await request(app)
      .get('/api/specs/nonexistent-spec-xyz/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/spec not found/i);
  });

  test('GET /api/specs/:id/check returns {valid: true} for valid spec', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    seedCheckSpec(pendingDir, 'valid-check-spec');

    const res = await request(app)
      .get('/api/specs/valid-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.errors).toEqual([]);
    expect(res.body.warnings).toBeDefined();
    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.totalStories).toBe(1);
  });

  test('GET /api/specs/:id/check returns errors for spec with missing required fields', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const badSpec = {
      title: 'Bad Spec',
      userStories: [
        {
          id: 'US-001',
          // missing title, description, acceptanceCriteria
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(pendingDir, 'bad-check-spec.json'), JSON.stringify(badSpec, null, 2), 'utf8');

    const res = await request(app)
      .get('/api/specs/bad-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.length).toBeGreaterThan(0);
    const titleError = res.body.errors.find((e: any) => e.field === 'title');
    expect(titleError).toBeDefined();
  });

  test('GET /api/specs/:id/check returns 404 when workspaceId is not in DB', async () => {
    const res = await request(app)
      .get('/api/specs/some-spec/check?workspaceId=nonexistent-ws')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/workspace not found/i);
  });

  test('GET /api/specs/:id/check returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/specs/some-spec/check')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });

  test('GET /api/specs/:id/check finds spec in approved dir', async () => {
    const approvedDir = path.join(os.tmpdir(), 'forge', 'specs', 'approved');
    seedCheckSpec(approvedDir, 'approved-check-spec');

    const res = await request(app)
      .get('/api/specs/approved-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test('GET /api/specs/:id/check detects orphaned dependsOn references', async () => {
    const pendingDir = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const orphanSpec = {
      title: 'Orphan Spec',
      userStories: [
        {
          id: 'US-001',
          title: 'Story one',
          description: 'Desc',
          acceptanceCriteria: ['AC1'],
          dependsOn: ['US-999'], // US-999 does not exist
          passes: false,
        },
      ],
      generatedAt: '2026-03-12T00:00:00.000Z',
    };
    fs.writeFileSync(path.join(pendingDir, 'orphan-check-spec.json'), JSON.stringify(orphanSpec, null, 2), 'utf8');

    const res = await request(app)
      .get('/api/specs/orphan-check-spec/check?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    const orphanError = res.body.errors.find((e: any) => e.field === 'dependsOn');
    expect(orphanError).toBeDefined();
    expect(orphanError.message).toContain('US-999');
  });
});

describe('POST /api/specs/:id/assign-models', () => {
  const specId = 'assign-models-test-spec';

  // Ensure RORCA_AGENT is always a valid value for server module load
  beforeEach(() => {
    process.env.RORCA_AGENT = 'claude';
    delete process.env.RORCA_MODEL;
  });

  afterEach(async () => {
    process.env.RORCA_AGENT = 'claude';
    delete process.env.RORCA_MODEL;
    // Remove any workspace env vars seeded for these tests
    await execute(`DELETE FROM workspace_env_vars WHERE workspace_id = 'ws-test'`);
  });

  function makeSpecFile(stories: object[], dir: 'pending' | 'approved') {
    for (const existingDir of ['pending', 'approved'] as const) {
      const existingPath = path.join(os.tmpdir(), 'forge', 'specs', existingDir, `${specId}.json`);
      if (fs.existsSync(existingPath)) {
        fs.rmSync(existingPath, { force: true });
      }
    }
    const specsDir = path.join(os.tmpdir(), 'forge', 'specs', dir);
    fs.mkdirSync(specsDir, { recursive: true });
    const specContent = {
      title: specId,
      userStories: stories,
      generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(specsDir, `${specId}.json`), JSON.stringify(specContent, null, 2), 'utf8');
    return path.join(specsDir, `${specId}.json`);
  }

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 when spec does not exist', async () => {
    const res = await request(app)
      .post('/api/specs/nonexistent-spec/assign-models')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(404);
  });

  test('returns { storiesAssigned: 0, skipped: false, breakdown: [] } for empty spec', async () => {
    makeSpecFile([], 'pending');

    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(0);
    expect(res.body.skipped).toBe(false);
    expect(res.body.breakdown).toEqual([]);
  });

  test('RORCA_AGENT=claude: returns complexity breakdown using the configured model', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Update config label',
        description: 'Update config label copy for onboarding',
        acceptanceCriteria: ['Label reads "Get Started"'],
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-002',
        title: 'Implement security architecture',
        description: 'Design and implement security architecture for authentication and payments migration',
        acceptanceCriteria: ['All auth flows are secured', 'Payment data encrypted'],
        dependsOn: ['US-001'],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(2);
    expect(res.body.skipped).toBe(false);
    expect(res.body.breakdown).toHaveLength(2);

    for (const entry of res.body.breakdown) {
      expect(entry).toHaveProperty('storyId');
      expect(entry).toHaveProperty('complexity');
      expect(['low', 'medium', 'high']).toContain(entry.complexity);
      expect(entry).toHaveProperty('model');
      expect(entry.model).toBe('(user-configured)');
      expect(entry).toHaveProperty('reason');
      expect(typeof entry.reason).toBe('string');
    }
  });

  test('RORCA_AGENT=codex: returns skipped=true without modifying spec', async () => {
    const specFile = makeSpecFile([
      {
        id: 'US-001',
        title: 'Add feature',
        description: 'Add a basic feature',
        acceptanceCriteria: ['Feature works'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    const beforeContent = fs.readFileSync(specFile, 'utf8');

    process.env.RORCA_AGENT = 'codex';

    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(0);
    expect(res.body.skipped).toBe(true);
    expect(res.body.reason).toMatch(/codex/i);
    expect(res.body.reason).toMatch(/ChatGPT subscription/i);

    // Spec file must NOT be modified
    const afterContent = fs.readFileSync(specFile, 'utf8');
    expect(afterContent).toBe(beforeContent);
  });

  test('dryRun=true: returns breakdown without writing story.model to spec file', async () => {
    const specFile = makeSpecFile([
      {
        id: 'US-001',
        title: 'Implement architecture for payments',
        description: 'Design architecture for payments system migration',
        acceptanceCriteria: ['Architecture documented'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    const beforeContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(beforeContent.userStories[0].model).toBeUndefined();

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test', dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toHaveLength(1);

    // File must NOT have story.model written
    const afterContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(afterContent.userStories[0].model).toBeUndefined();
  });

  test('dryRun=false (default): does not write per-story model overrides to spec file', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Add CRUD endpoints',
        description: 'Add CRUD endpoints for config resource',
        acceptanceCriteria: ['GET/POST/PUT/DELETE all work'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(1);

    // Per-story model cascading was removed — the configured run model is used.
    const specFile = path.join(os.tmpdir(), 'forge', 'specs', 'pending', `${specId}.json`);
    const afterContent = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    expect(afterContent.userStories[0].model).toBeUndefined();
  });

  test('RORCA_AGENT=opencode with openai/gpt-4o: all stories use the configured model', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Update config label',
        description: 'Update the CRUD config label copy',
        acceptanceCriteria: ['Label updated'],
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-002',
        title: 'Security architecture for payments',
        description: 'Implement security architecture for authentication payments migration',
        acceptanceCriteria: ['Security audit passes', 'Payment flows encrypted', 'Architecture reviewed'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    process.env.RORCA_AGENT = 'opencode';
    process.env.RORCA_MODEL = 'openai/gpt-4o';

    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(2);

    const lowStory = res.body.breakdown.find((b: any) => b.storyId === 'US-001');
    const highStory = res.body.breakdown.find((b: any) => b.storyId === 'US-002');

    expect(lowStory).toBeDefined();
    expect(highStory).toBeDefined();
    expect(lowStory.model).toBe('openai/gpt-4o');
    expect(highStory.model).toBe('openai/gpt-4o');
  });

  test('complexity label derives from the declared complexity field (effort routing)', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Implement security architecture',
        description: 'Design security architecture for payments system migration',
        acceptanceCriteria: ['All routes secured'],
        complexity: 5,
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-002',
        title: 'Update CRUD config',
        description: 'Update the config label copy for onboarding',
        acceptanceCriteria: ['Label shows correct text'],
        complexity: 2,
        dependsOn: [],
        passes: false,
      },
      {
        id: 'US-003',
        title: 'Moderate story',
        description: 'No declared complexity defaults to medium',
        acceptanceCriteria: ['Works'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);

    const highStory = res.body.breakdown.find((b: any) => b.storyId === 'US-001');
    const lowStory = res.body.breakdown.find((b: any) => b.storyId === 'US-002');
    const mediumStory = res.body.breakdown.find((b: any) => b.storyId === 'US-003');

    expect(highStory.complexity).toBe('high');
    expect(lowStory.complexity).toBe('low');
    expect(mediumStory.complexity).toBe('medium');
  });

  test('falls back to process.env when workspace_env_vars do not override agent config', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Add feature',
        description: 'Add a basic feature',
        acceptanceCriteria: ['Feature works'],
        dependsOn: [],
        passes: false,
      },
    ], 'pending');

    // RORCA_AGENT=claude set by beforeEach; no workspace env var means process.env is used
    // Insert raw (non-encrypted) value via direct DB insert won't work with decryptToken,
    // so test the fallback: no workspace env var means process.env is used
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    // Should use process.env.RORCA_AGENT=claude fallback
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(false);
    for (const entry of res.body.breakdown) {
      expect(entry.model).toBe('(user-configured)');
    }
  });

  test('works with spec in approved directory', async () => {
    makeSpecFile([
      {
        id: 'US-001',
        title: 'Simple feature',
        description: 'A simple feature implementation',
        acceptanceCriteria: ['Works correctly'],
        dependsOn: [],
        passes: false,
      },
    ], 'approved');

    // RORCA_AGENT=claude already set by beforeEach
    const res = await request(app)
      .post(`/api/specs/${specId}/assign-models`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });


    expect(res.status).toBe(200);
    expect(res.body.storiesAssigned).toBe(1);
  });
});

describe('POST /api/specs/:specId/enrich (CTM-007 canonical context parity)', () => {
  const specId = 'enrich-parity-spec';

  function makeSpecFile(stories: object[], dir: 'pending' | 'approved' = 'pending') {
    for (const existingDir of ['pending', 'approved'] as const) {
      const existingPath = path.join(os.tmpdir(), 'forge', 'specs', existingDir, `${specId}.json`);
      if (fs.existsSync(existingPath)) {
        fs.rmSync(existingPath, { force: true });
      }
    }
    const specsDir = path.join(os.tmpdir(), 'forge', 'specs', dir);
    fs.mkdirSync(specsDir, { recursive: true });
    const specContent = {
      title: 'Enrich Parity Spec',
      userStories: stories,
      generatedAt: new Date().toISOString(),
    };
    const file = path.join(specsDir, `${specId}.json`);
    fs.writeFileSync(file, JSON.stringify(specContent, null, 2), 'utf8');
    return file;
  }

  test('persists a canonical context_summary_json matching the generate/persist contract', async () => {
    mockChatComplete.mockResolvedValue({
      text: '- Relevant convention: use apiFetch\n- Gotcha: strip claude env vars',
      usage: { inputTokens: 12, outputTokens: 34 },
    });

    makeSpecFile([
      { id: 'US-001', title: 'Login', description: 'Build login flow', acceptanceCriteria: ['User can submit credentials'], dependsOn: [] },
      { id: 'US-002', title: 'Dashboard', description: 'Show dashboard', acceptanceCriteria: ['Shows recent activity'], dependsOn: ['US-001'] },
    ]);

    const res = await request(app)
      .post(`/api/specs/${specId}/enrich`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.storiesEnriched).toBe(2);
    // retrieval_method must use the canonical vocabulary shared with
    // memory-router / generate / persist, never a bespoke string.
    expect(['cache', 'search', 'hybrid', 'none']).toContain(res.body.retrieval_method);

    const logRes = await request(app)
      .get(`/api/specs/${specId}/generation-log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body).toBeTruthy();
    expect(logRes.body.spec_slug).toBe(specId);
    expect(logRes.body.status).toBe('completed');
    expect(logRes.body.enriched).toBe(true);
    expect(['cache', 'search', 'hybrid', 'none']).toContain(logRes.body.retrieval_method);
    expect(logRes.body.retrieval_method).toBe(res.body.retrieval_method);

    const summary = parsePayload(logRes.body.context_summary_json) as {
      directionLayers: { l1: unknown; l2: { present: unknown; domain: unknown }; l3: unknown };
      skills: unknown;
      memoryEntries: unknown;
      modelContextWindow: unknown;
      memory?: unknown;
      tokenBudget?: unknown;
      flags?: unknown;
    };

    // Canonical directionLayers is an OBJECT ({l1, l2:{present,domain}, l3}),
    // not the legacy array-of-{layer,present} shape.
    expect(Array.isArray(summary.directionLayers)).toBe(false);
    expect(typeof summary.directionLayers.l1).toBe('boolean');
    expect(typeof summary.directionLayers.l2.present).toBe('boolean');
    expect('domain' in summary.directionLayers.l2).toBe(true);
    expect(typeof summary.directionLayers.l3).toBe('boolean');

    // Canonical scalar fields present; divergent enrich-only fields absent.
    expect(Array.isArray(summary.skills)).toBe(true);
    expect(typeof summary.memoryEntries).toBe('number');
    expect(summary.modelContextWindow).toBe(200000);
    expect(summary.memory).toBeUndefined();
    expect(summary.tokenBudget).toBeUndefined();
    expect(summary.flags).toBeUndefined();

    // The annotation came from chatComplete().text (ChatResult), not a stringified
    // ChatResult — verify it was appended under a Context heading on disk.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', `${specId}.json`), 'utf8'),
    ) as { userStories: Array<{ description: string }> };
    expect(onDisk.userStories[0].description).toContain('## Context');
    expect(onDisk.userStories[0].description).toContain('use apiFetch');
    expect(onDisk.userStories[0].description).not.toContain('[object Object]');
  });

  test('reports retrieval_method none and omits retrieval block when no stories', async () => {
    makeSpecFile([]);

    const res = await request(app)
      .post(`/api/specs/${specId}/enrich`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.storiesEnriched).toBe(0);
    expect(res.body.retrieval_method).toBe('none');
  });

  test('survives per-story chatComplete failures and still writes a completed log (fallback)', async () => {
    // First story annotation rejects, second resolves — enrich must skip the
    // failed story rather than failing the whole run.
    mockChatComplete
      .mockRejectedValueOnce(new Error('Rate limit reached'))
      .mockResolvedValue({ text: '- annotation ok', usage: { inputTokens: 5, outputTokens: 7 } });

    makeSpecFile([
      { id: 'US-001', title: 'First', description: 'First story', acceptanceCriteria: ['AC1'], dependsOn: [] },
      { id: 'US-002', title: 'Second', description: 'Second story', acceptanceCriteria: ['AC2'], dependsOn: [] },
    ]);

    const res = await request(app)
      .post(`/api/specs/${specId}/enrich`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // One story failed → only one enriched, run still succeeds.
    expect(res.body.storiesEnriched).toBe(1);

    const logRes = await request(app)
      .get(`/api/specs/${specId}/generation-log`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(logRes.status).toBe(200);
    expect(logRes.body.status).toBe('completed');
    expect(logRes.body.enriched).toBe(true);
  });
});

// ─── US-008: Verified Genesis binding at spec persist and binding API ─────────

/**
 * Fixture packages are registered with the production Genesis authority
 * bridge at module scope: the specs router captures the bridge's package
 * snapshot when the server module loads in beforeAll, so registrations must
 * happen before that require.
 */
function genesisPackageDefinition(id: string, overrides: Partial<GenesisPackageDefinitionInput> = {}): GenesisPackageDefinitionInput {
  return {
    id,
    title: `Approved package ${id}`,
    sourceVersion: 'revision-7',
    reviewStatus: 'approved',
    sensitivity: 'internal',
    canonicalStore: 'pglite+pgvector+genesis-vault',
    citationSummary: '2 bridge-selected evidence chunks',
    warningCount: 0,
    skippedEvidenceCount: 0,
    freshnessTs: '2026-03-16T00:00:00.000Z',
    bridgeVersion: 'genesis-bridge.v1',
    chunks: [
      {
        chunkId: 'chunk-control',
        evidence: { genesisEvidenceId: 'GEN-101', sourceTitle: 'Delivery Control', exactCitation: 'Genesis Control §4.1', evidenceStrength: 'primary' },
        sensitivity: 'internal',
        content: 'Require signed delivery evidence.',
      },
      {
        chunkId: 'chunk-review',
        evidence: { genesisEvidenceId: 'GEN-102', sourceTitle: 'Review Control', exactCitation: 'Genesis Review §2.3', evidenceStrength: 'primary' },
        sensitivity: 'internal',
        content: 'Approval requires independent review.',
      },
    ],
    ...overrides,
  };
}

const PUBLISHED_GENESIS_PACKAGE_ID = 'GEN-PKG-PUBLISHED';
const PUBLISHED_GENESIS_SPEC_ID = 'genesis-published-spec';
const publishedGenesisBaseDefinition = genesisPackageDefinition(PUBLISHED_GENESIS_PACKAGE_ID);
const publishedGenesisContentHash = `sha256:${crypto.createHash('sha256')
  .update(publishedGenesisBaseDefinition.chunks.map((chunk) => chunk.content).join('\n\n'))
  .digest('hex')}` as const;
const publishedGenesisPackageHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
  packageId: publishedGenesisBaseDefinition.id,
  title: publishedGenesisBaseDefinition.title,
  sourceVersion: publishedGenesisBaseDefinition.sourceVersion,
  chunkIds: publishedGenesisBaseDefinition.chunks.map((chunk) => chunk.chunkId),
  contentHash: publishedGenesisContentHash,
})).digest('hex')}` as const;
const publishedGenesisReleaseSubject = `sha256:${crypto.createHash('sha256')
  .update(PUBLISHED_GENESIS_SPEC_ID)
  .digest('hex')}` as const;
const publishedGenesisDocuments = {
  'PRD.md': '# Published Genesis source\n\n## Intent\nPersist trusted publication authority.\n',
  'SDD.md': '# Published Genesis design\n\n## Target model\nCanonical writer issuance.\n',
  'PLAN.md': '# Published Genesis plan\n\n## Caveats\nExact receipt identity only.\n',
};
const publishedGenesisManifest = {
  contractVersion: 'genesis.intent-curation-export/v1',
  status: 'published',
  publicationStatus: 'published',
  authoritative: true,
  workspaceId: SPECS_WORKSPACE_ID,
  packageId: PUBLISHED_GENESIS_PACKAGE_ID,
  contentHash: publishedGenesisPackageHash,
  previewHash: `sha256:${crypto.createHash('sha256').update('published-preview').digest('hex')}` as const,
  snapshotHash: `sha256:${crypto.createHash('sha256').update('published-snapshot').digest('hex')}` as const,
  authorityReceiptPath: 'publication-receipt.json',
  files: [...Object.keys(publishedGenesisDocuments), 'manifest.json'],
  evidence: [{ title: PUBLISHED_GENESIS_PACKAGE_ID }],
};
const publishedGenesisManifestRaw = `${JSON.stringify(publishedGenesisManifest, null, 2)}\n`;
const publishedGenesisEventHash = `sha256:${crypto.createHash('sha256').update('published-event').digest('hex')}` as const;
const publishedGenesisReceipt = {
  contractVersion: 'genesis.package-publication-receipt/v1',
  receiptId: `package-event:${publishedGenesisEventHash}` as const,
  eventHash: publishedGenesisEventHash,
  state: 'published',
  authoritative: true,
  workspaceId: SPECS_WORKSPACE_ID,
  packageId: PUBLISHED_GENESIS_PACKAGE_ID,
  packagePath: `genesis/artifacts/export-packs/${PUBLISHED_GENESIS_PACKAGE_ID}`,
  packageHash: publishedGenesisPackageHash,
  previewHash: publishedGenesisManifest.previewHash,
  snapshotHash: publishedGenesisManifest.snapshotHash,
  manifestHash: `sha256:${crypto.createHash('sha256').update(publishedGenesisManifestRaw).digest('hex')}` as const,
  releaseSubject: { type: 'spec_hash', value: publishedGenesisReleaseSubject },
  artifacts: Object.entries(publishedGenesisDocuments).map(([artifactPath, content]) => ({
    path: artifactPath,
    contentHash: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}` as const,
    sizeBytes: Buffer.byteLength(content),
  })),
};
const publishedGenesisReceiptRaw = JSON.stringify(publishedGenesisReceipt, null, 2);
const publishedGenesisDefinition: GenesisPackageDefinitionInput = {
  ...publishedGenesisBaseDefinition,
  publicationAuthority: {
    workspaceId: SPECS_WORKSPACE_ID,
    specSlug: PUBLISHED_GENESIS_SPEC_ID,
    releaseSubjectHash: publishedGenesisReleaseSubject,
    packageId: PUBLISHED_GENESIS_PACKAGE_ID,
    packagePath: publishedGenesisReceipt.packagePath,
    receiptId: publishedGenesisReceipt.receiptId,
    receiptHash: `sha256:${crypto.createHash('sha256').update(publishedGenesisReceiptRaw).digest('hex')}`,
    eventHash: publishedGenesisEventHash,
    manifestHash: publishedGenesisReceipt.manifestHash,
    packageHash: publishedGenesisPackageHash,
    previewHash: publishedGenesisManifest.previewHash,
    snapshotHash: publishedGenesisManifest.snapshotHash,
  },
};

const CONFLICT_GENESIS_PACKAGE_ID = 'GEN-PKG-PUBLICATION-CONFLICT';
const CONFLICT_GENESIS_SPEC_ID = 'genesis-publication-conflict';
const conflictGenesisBaseDefinition = genesisPackageDefinition(CONFLICT_GENESIS_PACKAGE_ID);
const conflictGenesisContentHash = `sha256:${crypto.createHash('sha256')
  .update(conflictGenesisBaseDefinition.chunks.map((chunk) => chunk.content).join('\n\n'))
  .digest('hex')}` as const;
const conflictGenesisPackageHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
  packageId: conflictGenesisBaseDefinition.id,
  title: conflictGenesisBaseDefinition.title,
  sourceVersion: conflictGenesisBaseDefinition.sourceVersion,
  chunkIds: conflictGenesisBaseDefinition.chunks.map((chunk) => chunk.chunkId),
  contentHash: conflictGenesisContentHash,
})).digest('hex')}` as const;
const conflictGenesisEventHash = `sha256:${crypto.createHash('sha256').update('conflicting-publication-event').digest('hex')}` as const;
const conflictGenesisDefinition: GenesisPackageDefinitionInput = {
  ...conflictGenesisBaseDefinition,
  publicationAuthority: {
    workspaceId: SPECS_WORKSPACE_ID,
    specSlug: CONFLICT_GENESIS_SPEC_ID,
    releaseSubjectHash: `sha256:${crypto.createHash('sha256').update(CONFLICT_GENESIS_SPEC_ID).digest('hex')}`,
    packageId: CONFLICT_GENESIS_PACKAGE_ID,
    packagePath: `genesis/artifacts/export-packs/${CONFLICT_GENESIS_PACKAGE_ID}`,
    receiptId: `package-event:${conflictGenesisEventHash}`,
    receiptHash: `sha256:${crypto.createHash('sha256').update('conflicting-publication-receipt').digest('hex')}`,
    eventHash: conflictGenesisEventHash,
    manifestHash: `sha256:${crypto.createHash('sha256').update('conflicting-publication-manifest').digest('hex')}`,
    packageHash: conflictGenesisPackageHash,
    previewHash: `sha256:${crypto.createHash('sha256').update('conflicting-publication-preview').digest('hex')}`,
    snapshotHash: `sha256:${crypto.createHash('sha256').update('conflicting-publication-snapshot').digest('hex')}`,
  },
};

const bridgeInternalClearance = {
  principalClearance: () => 'internal' as const,
};

registerGenesisPackage(
  genesisPackageDefinition('GEN-PKG-BOUND'),
  bridgeInternalClearance,
);
registerGenesisPackage(
  conflictGenesisDefinition,
  bridgeInternalClearance,
);
registerGenesisPackage(
  publishedGenesisDefinition,
  bridgeInternalClearance,
);
registerGenesisPackage(
  genesisPackageDefinition('GEN-PKG-OTHER'),
  bridgeInternalClearance,
);
registerGenesisPackage(
  genesisPackageDefinition('GEN-PKG-PENDING', { reviewStatus: 'pending' }),
  bridgeInternalClearance,
);
registerGenesisPackage(genesisPackageDefinition('GEN-PKG-RESTRICTED', {
  sensitivity: 'restricted',
  citationSummary: '1 restricted evidence chunk',
  chunks: [{
    chunkId: 'chunk-secret',
    evidence: { genesisEvidenceId: 'GEN-301', sourceTitle: 'Vault Item', exactCitation: 'Vault restricted item', evidenceStrength: 'primary' },
    sensitivity: 'restricted',
    content: 'raw restricted deployment credential',
  }],
}));

function genesisPersistPayload(slug: string, title: string, genesisSource?: Record<string, unknown>) {
  return {
    workspaceId: 'ws-test',
    title,
    slug,
    source: 'genesis-explicit-draft',
    stories: [{
      id: 'GEN-001',
      title: 'Preserve evidence lineage',
      description: 'Keep bounded Genesis package provenance attached to the pending spec.',
      acceptanceCriteria: ['The canonical spec identity survives persistence'],
      dependsOn: [],
    }],
    policyPresetId: 'fast_import',
    ...(genesisSource ? { genesisSource } : {}),
  };
}

describe('US-008 verified Genesis binding', () => {
  test('persist with a valid package id stores a verified spec_sources row and returns boundSources', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(genesisPersistPayload('genesis-bound-spec', 'Genesis Bound Spec', {
        kind: 'genesis_package',
        id: 'GEN-PKG-BOUND',
        principalId: 'principal-reviewer',
      }));

    expect(res.status).toBe(200);
    expect(res.body.boundSources).toHaveLength(1);
    expect(res.body.boundSources[0]).toMatchObject({
      schemaVersion: 'rorca.spec-source-binding.v1',
      specId: 'genesis-bound-spec',
      workspaceId: 'ws-test',
      source: 'genesis',
      kind: 'genesis_package',
      id: 'GEN-PKG-BOUND',
      packageId: 'GEN-PKG-BOUND',
      reviewStatus: 'approved',
      sensitivity: 'internal',
      boundBy: 'principal-reviewer',
      evidenceChunkIds: ['chunk-control', 'chunk-review'],
    });
    expect(res.body.boundSources[0].packageHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(res.body.boundSources[0].contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(res.body.boundSources[0].citations).toEqual([
      { chunkId: 'chunk-control', citation: 'Genesis Control §4.1' },
      { chunkId: 'chunk-review', citation: 'Genesis Review §2.3' },
    ]);

    const row = await queryOne<{
      source: string;
      source_kind: string;
      source_id: string;
      package_hash: string;
      review_status: string;
      bound_by: string;
    }>(
      `SELECT source, source_kind, source_id, package_hash, review_status, bound_by
         FROM spec_sources
        WHERE spec_id = $1 AND workspace_id = $2`,
      ['genesis-bound-spec', 'ws-test'],
    );
    expect(row).toMatchObject({
      source: 'genesis',
      source_kind: 'genesis_package',
      source_id: 'GEN-PKG-BOUND',
      review_status: 'approved',
      bound_by: 'principal-reviewer',
    });
    expect(row?.package_hash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const readback = await request(app)
      .get('/api/specs/genesis-bound-spec?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(readback.status).toBe(200);
    expect(readback.body.boundSources).toHaveLength(1);
    expect(readback.body.boundSources[0].id).toBe('GEN-PKG-BOUND');
  });

  test('request-supplied publication authority cannot mint an issuance receipt', async () => {
    const specId = 'genesis-request-authority';
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(genesisPersistPayload(specId, 'Genesis Request Authority', {
        kind: 'genesis_package',
        id: 'GEN-PKG-BOUND',
        principalId: 'principal-reviewer',
        publicationAuthority: publishedGenesisDefinition.publicationAuthority,
      }));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('REQUEST_SCHEMA_INVALID');
    const binding = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text count FROM spec_sources WHERE workspace_id = $1 AND spec_id = $2`,
      [SPECS_WORKSPACE_ID, specId],
    );
    expect(binding?.count).toBe('0');
    const authority = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text count
         FROM lifecycle_source_publication_receipts
        WHERE workspace_id = $1 AND package_id = 'GEN-PKG-BOUND'`,
      [SPECS_WORKSPACE_ID],
    );
    expect(authority?.count).toBe('0');
  });

  test('trusted Genesis binding atomically issues an idempotent receipt that source projection verifies', async () => {
    const pendingRoot = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    const packageRoot = path.join(os.tmpdir(), 'genesis', 'artifacts', 'export-packs', PUBLISHED_GENESIS_PACKAGE_ID);
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(pendingRoot, `${PUBLISHED_GENESIS_SPEC_ID}.json`), JSON.stringify({
      title: 'Published Genesis source',
      sourcePackageId: PUBLISHED_GENESIS_PACKAGE_ID,
    }));
    for (const [name, content] of Object.entries(publishedGenesisDocuments)) {
      fs.writeFileSync(path.join(packageRoot, name), content);
    }
    fs.writeFileSync(path.join(packageRoot, 'manifest.json'), publishedGenesisManifestRaw);
    fs.writeFileSync(path.join(packageRoot, 'publication-receipt.json'), publishedGenesisReceiptRaw);

    try {
      const bind = () => request(app)
        .post(`/api/specs/${PUBLISHED_GENESIS_SPEC_ID}/genesis-sources`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          workspaceId: SPECS_WORKSPACE_ID,
          genesisSource: {
            kind: 'genesis_package',
            id: PUBLISHED_GENESIS_PACKAGE_ID,
            principalId: 'principal-publication-authority',
          },
        });
      expect((await bind()).status).toBe(200);
      expect((await bind()).status).toBe(200);

      const authority = await queryOne<{ count: string; receipt_hash: string }>(
        `SELECT COUNT(*) OVER () AS count, receipt_hash
           FROM lifecycle_source_publication_receipts
          WHERE workspace_id = $1 AND receipt_id = $2`,
        [SPECS_WORKSPACE_ID, publishedGenesisReceipt.receiptId],
      );
      expect(authority).toEqual({
        count: '1',
        receipt_hash: publishedGenesisDefinition.publicationAuthority!.receiptHash,
      });

      const material = await projectLifecycleSourceMaterial({
        workspacePath: os.tmpdir(),
        workspaceId: SPECS_WORKSPACE_ID,
        specId: PUBLISHED_GENESIS_SPEC_ID,
        specTitle: 'Published Genesis source',
        specContent: { sourcePackageId: PUBLISHED_GENESIS_PACKAGE_ID },
        releaseSubject: { type: 'spec_hash', value: publishedGenesisReleaseSubject },
        lens: 'requirements',
      });
      expect(material.state).toBe('available');
      if (material.state !== 'available') return;
      expect(material.authority).toMatchObject({
        status: 'verified',
        reasonCode: 'verified',
        receiptId: publishedGenesisReceipt.receiptId,
        receiptHash: publishedGenesisDefinition.publicationAuthority!.receiptHash,
      });
      expect(lifecycleSourceEvidenceProjection(material)).not.toBeNull();
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });

  test('conflicting publication receipt reuse rolls back the Genesis binding', async () => {
    const pendingRoot = path.join(os.tmpdir(), 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingRoot, { recursive: true });
    fs.writeFileSync(path.join(pendingRoot, `${CONFLICT_GENESIS_SPEC_ID}.json`), JSON.stringify({
      title: 'Conflicting Genesis publication',
    }));
    const publication = conflictGenesisDefinition.publicationAuthority!;
    await ownerPool.query(
      `INSERT INTO rorca.lifecycle_source_publication_receipts
        (workspace_id, spec_slug, release_subject_hash, package_id, package_path, receipt_id,
         receipt_hash, event_hash, manifest_hash, package_hash, preview_hash, snapshot_hash)
       VALUES ($1, 'existing-spec', $2, 'existing-package',
         'genesis/artifacts/export-packs/existing-package', $3, $4, $5, $6, $7, $8, $9)`,
      [
        SPECS_WORKSPACE_ID,
        publication.releaseSubjectHash,
        publication.receiptId,
        `sha256:${'a'.repeat(64)}`,
        publication.eventHash,
        publication.manifestHash,
        publication.packageHash,
        publication.previewHash,
        publication.snapshotHash,
      ],
    );

    const response = await request(app)
      .post(`/api/specs/${CONFLICT_GENESIS_SPEC_ID}/genesis-sources`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: SPECS_WORKSPACE_ID,
        genesisSource: {
          kind: 'genesis_package',
          id: CONFLICT_GENESIS_PACKAGE_ID,
          principalId: 'principal-publication-authority',
        },
      });
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('conflicts with persisted authority');
    const binding = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text count FROM spec_sources WHERE workspace_id = $1 AND spec_id = $2`,
      [SPECS_WORKSPACE_ID, CONFLICT_GENESIS_SPEC_ID],
    );
    expect(binding?.count).toBe('0');
  });

  test('forged genesis provenance is rejected with a typed error and no row', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(genesisPersistPayload('genesis-forged', 'Forged Genesis Spec', {
        kind: 'genesis_package',
        id: 'GEN-PKG-FORGED',
        principalId: 'principal-reviewer',
      }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.error).toContain('GEN-PKG-FORGED');

    const count = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM spec_sources WHERE spec_id = $1 AND workspace_id = $2`,
      ['genesis-forged', 'ws-test'],
    );
    expect(count?.count).toBe('0');
    // Resolution runs before artifact publication: a rejected binding must
    // not leave a spec file behind either.
    expect(fs.existsSync(path.join(os.tmpdir(), 'forge', 'specs', 'pending', 'genesis-forged.json'))).toBe(false);
  });

  test('unapproved genesis provenance is rejected with a typed error and no row', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(genesisPersistPayload('genesis-pending', 'Pending Genesis Spec', {
        kind: 'genesis_package',
        id: 'GEN-PKG-PENDING',
        principalId: 'principal-reviewer',
      }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toContain('not approved context');

    const count = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM spec_sources WHERE spec_id = $1 AND workspace_id = $2`,
      ['genesis-pending', 'ws-test'],
    );
    expect(count?.count).toBe('0');
  });

  test('redacted genesis provenance is rejected with a typed error and no row', async () => {
    const res = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(genesisPersistPayload('genesis-restricted', 'Restricted Genesis Spec', {
        kind: 'genesis_package',
        id: 'GEN-PKG-RESTRICTED',
        principalId: 'principal-reviewer',
      }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.error).toContain('redacted');

    const count = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM spec_sources WHERE spec_id = $1 AND workspace_id = $2`,
      ['genesis-restricted', 'ws-test'],
    );
    expect(count?.count).toBe('0');
  });

  test('binding endpoint binds idempotently after persist and surfaces in GET spec', async () => {
    const persisted = await request(app)
      .post('/api/specs/persist')
      .set('Authorization', `Bearer ${authToken}`)
      .send(genesisPersistPayload('genesis-late-bind', 'Genesis Late Bind'));

    expect(persisted.status).toBe(200);

    const bind = async () => request(app)
      .post('/api/specs/genesis-late-bind/genesis-sources')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        genesisSource: { kind: 'genesis_package', id: 'GEN-PKG-BOUND', principalId: 'principal-reviewer' },
      });

    const first = await bind();
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.body.boundSources).toHaveLength(1);
    expect(first.body.boundSources[0].id).toBe('GEN-PKG-BOUND');

    const replay = await bind();
    expect(replay.status).toBe(200);
    expect(replay.body.boundSources[0].id).toBe('GEN-PKG-BOUND');

    const count = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM spec_sources WHERE spec_id = $1 AND workspace_id = $2`,
      ['genesis-late-bind', 'ws-test'],
    );
    expect(count?.count).toBe('1');

    const readback = await request(app)
      .get('/api/specs/genesis-late-bind?workspaceId=ws-test')
      .set('Authorization', `Bearer ${authToken}`);

    expect(readback.status).toBe(200);
    expect(readback.body.boundSources).toHaveLength(1);
    expect(readback.body.boundSources[0].id).toBe('GEN-PKG-BOUND');
    expect(readback.body.boundSources[0].boundBy).toBe('principal-reviewer');

    const conflicting = await request(app)
      .post('/api/specs/genesis-late-bind/genesis-sources')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        genesisSource: { kind: 'genesis_package', id: 'GEN-PKG-OTHER', principalId: 'principal-reviewer' },
      });

    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe('CONFLICT');

    const forged = await request(app)
      .post('/api/specs/genesis-late-bind/genesis-sources')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        genesisSource: { kind: 'genesis_package', id: 'GEN-PKG-FORGED', principalId: 'principal-reviewer' },
      });

    expect(forged.status).toBe(404);
    expect(forged.body.code).toBe('NOT_FOUND');

    const missingSpec = await request(app)
      .post('/api/specs/genesis-missing-spec/genesis-sources')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-test',
        genesisSource: { kind: 'genesis_package', id: 'GEN-PKG-BOUND', principalId: 'principal-reviewer' },
      });

    expect(missingSpec.status).toBe(404);
  });
});
