/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PSE-005: Tests for POST /api/specs/:specId/repair
 *
 * Tests cover:
 *   (1) 404 when spec file does not exist
 *   (2) 404 when workspace does not exist
 *   (3) 400 when workspaceId is missing
 *   (4) 409 when spec has an active pipeline run
 *   (5) Healthy spec returns all-skipped actions
 *   (6) Missing generation log is seeded
 *   (7) Failed enrich stage is re-enqueued
 *   (8) Failed match-skills stage is re-enqueued
 *   (9) dryRun mode diagnoses without modifying state
 *   (10) Idempotency — repair on already-healthy spec is no-op
 *   (11) Active enrich job blocks re-enqueue
 *   (12) Selective stage repair via stages param
 */

import crypto from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import type * as AuthHelperModule from './helpers/auth-helper';
import type * as DatabaseModule from '../../db/index';
import { Pool } from 'pg';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  ALL_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../../lib/pi-spec-drafter', () => ({
  draftSpecWithPi: jest.fn(),
}));

jest.mock('../../lib/codex-spec-drafter', () => ({
  draftSpecWithCodex: jest.fn(),
}));

jest.mock('../../lib/pg-boss', () => {
  let callCount = 0;
  const send = jest.fn().mockImplementation(() => {
    callCount++;
    // Return unique UUID on each call to avoid unique constraint violations on boss_job_id
    return Promise.resolve(`22222222-2222-4222-8222-${String(callCount).padStart(12, '0')}`);
  });
  return {
    initBoss: jest.fn().mockResolvedValue(undefined),
    getBoss: jest.fn(() => ({ send })),
    __resetCallCount: () => { callCount = 0; },
  };
});

let app: Server;
let mockBossSend: jest.Mock;
let getAuthToken: typeof AuthHelperModule.getAuthToken;
let queryOne: typeof DatabaseModule.queryOne;
let authToken: string;
let workspaceDir: string;

const fixtureId = crypto.randomUUID();
const WORKSPACE_ID = `ws-repair-${fixtureId}`;
const LEGACY_WORKSPACE_ID = 'ws-repair-test';
const FIXTURE_USER_ID = crypto.randomUUID();
const FIXTURE_AUTH_ID = crypto.randomUUID();
const FIXTURE_USER_EMAIL = `spec-repair-${fixtureId}@test.rorca.local`;
const originalNodeEnv = process.env.NODE_ENV;
const originalWorkspaceScope = process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;
const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${WORKSPACE_ID}`,
});
const FIXTURE_SPEC_IDS = [
  'batch-repair-spec', 'blocked-spec', 'dryrun-spec', 'failed-enrich-spec',
  'failed-match-spec', 'healthy-spec', 'idem-spec', 'legacy-backfill-spec',
  'memory-retry-spec', 'no-ctx-spec', 'no-log-spec', 'readiness-surface-spec',
  'selective-spec', 'stage-retry-spec', 'workflow-surface-spec',
];

function repairOperationKey(label: string): string {
  return `spec-repair:${fixtureId}:${label}`;
}

function specsDirs(workspacePath: string) {
  return {
    pendingDir: path.join(workspacePath, 'forge', 'specs', 'pending'),
    approvedDir: path.join(workspacePath, 'forge', 'specs', 'approved'),
  };
}

function writeSpecFile(_workspacePath: string, specId: string, content: Record<string, unknown> = {}) {
  const { pendingDir } = specsDirs(workspaceDir);
  fs.mkdirSync(pendingDir, { recursive: true });
  const specContent = {
    title: content.title ?? 'Test Spec',
    userStories: content.userStories ?? [
      { id: 'US-001', title: 'Story 1', description: 'Test story', acceptanceCriteria: ['AC1'], dependsOn: [] },
    ],
    model: content.model ?? 'claude-sonnet-4-5-20250929',
    source: content.source ?? 'test',
    ...content,
  };
  fs.writeFileSync(path.join(pendingDir, `${specId}.json`), JSON.stringify(specContent, null, 2));
}

async function ownerExecute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

async function ownerQueryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function seedGenerationLog(specId: string, options: {
  withPostSaveStages?: boolean;
  withContextCaptureStatus?: boolean;
  enrichStatus?: string;
  matchSkillsStatus?: string;
  workspaceId?: string;
} = {}) {
  const postSaveStages = options.withPostSaveStages !== false ? {
    enrich: {
      requested: true,
      status: options.enrichStatus ?? 'completed',
      reason: options.enrichStatus === 'failed' ? 'job_failed' : 'job_completed',
    },
    matchSkills: {
      requested: true,
      status: options.matchSkillsStatus ?? 'completed',
      reason: options.matchSkillsStatus === 'failed' ? 'job_failed' : 'job_completed',
    },
    memorySynthesis: {
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    },
  } : undefined;

  const contextCaptureStatus = options.withContextCaptureStatus !== false ? {
    status: 'provided',
    reason: 'caller_supplied_context',
    contextUsed: 'provided',
    contextSummary: 'provided',
  } : undefined;

  const summaryJson: Record<string, unknown> = {
    source: 'test',
    workspaceId: options.workspaceId ?? WORKSPACE_ID,
    title: 'Test Spec',
    storyCount: 1,
    ...(postSaveStages ? { postSaveStages } : {}),
    ...(contextCaptureStatus ? { contextCaptureStatus } : {}),
  };

  const inserted = await ownerQueryOne<{ id: number }>(
    `INSERT INTO spec_generation_logs (spec_slug, model, provider, duration_ms, context_summary, enriched, retrieval_method, context_summary_json, status)
     VALUES ($1, 'claude-sonnet-4-5-20250929', 'api', 0, 'test', false, 'none', $2, 'persisted')
     RETURNING id`,
    [specId, JSON.stringify(summaryJson)],
  );
  if (!inserted) throw new Error(`failed to seed generation log for ${specId}`);
  await ownerExecute(
    `UPDATE spec_generation_logs
     SET save_generation = $2, context_summary_json = $3::jsonb
     WHERE id = $1`,
    [inserted.id, inserted.id, JSON.stringify({ ...summaryJson, saveGeneration: inserted.id })],
  );
}

async function seedDurableWorkflowRun(specId: string, stages: {
  context?: { requested: boolean; status: string; reason: string };
  enrich?: { requested: boolean; status: string; reason: string };
  matchSkills?: { requested: boolean; status: string; reason: string };
  memorySynthesis?: { requested: boolean; status: string; reason: string };
}, runStatus: 'completed' | 'failed' = 'completed') {
  const log = await ownerQueryOne<{ id: number; save_generation: string | number | null }>(
    `SELECT id, COALESCE(save_generation, id::bigint) AS save_generation
     FROM spec_generation_logs
     WHERE spec_slug = $1
     ORDER BY id DESC
     LIMIT 1`,
    [specId],
  );
  if (!log) throw new Error(`missing generation log for ${specId}`);

  const insertedRun = await ownerQueryOne<{ id: number }>(
    `INSERT INTO spec_post_save_workflow_runs (
       workspace_id,
       spec_id,
       generation_log_id,
       save_generation,
       effective_policy_hash,
       effective_policy,
       idempotency_key,
       status,
       source,
       finished_at
     ) VALUES ($1, $2, $3, $4, 'test-policy-hash', $5::jsonb, $6, $7, 'repair', CASE WHEN $7 IN ('completed', 'failed') THEN NOW() ELSE NULL END)
     RETURNING id`,
    [
      WORKSPACE_ID,
      specId,
      log.id,
      Number(log.save_generation),
      JSON.stringify({ version: 'v1', presetId: 'best_effort', context: 'capture', enrich: 'enqueue', skills: 'match', memory: 'synthesize', onFailure: 'continue' }),
      `test:${specId}:${Number(log.save_generation)}`,
      runStatus,
    ],
  );
  const runId = insertedRun?.id;
  if (!runId) throw new Error(`failed to insert workflow run for ${specId}`);

  const allStages = {
    context: { requested: true, status: 'completed', reason: 'context_captured', ...stages.context },
    enrich: { requested: true, status: 'completed', reason: 'job_completed', ...stages.enrich },
    matchSkills: { requested: true, status: 'completed', reason: 'job_completed', ...stages.matchSkills },
    memorySynthesis: { requested: false, status: 'skipped', reason: 'disabled_by_policy', ...stages.memorySynthesis },
  };

  for (const [stageKey, stage] of Object.entries(allStages)) {
    await ownerExecute(
      `INSERT INTO spec_post_save_workflow_stages (run_id, stage_key, requested, status, reason, finished_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 IN ('completed', 'failed', 'skipped') THEN NOW() ELSE NULL END)`,
      [runId, stageKey, stage.requested, stage.status, stage.reason],
    );
  }
}

async function cleanFixtureDatabase(): Promise<void> {
  const workspaceIds = [WORKSPACE_ID, LEGACY_WORKSPACE_ID];
  await ownerExecute(
    `DELETE FROM spec_post_save_workflow_runs
     WHERE workspace_id = ANY($1::text[]) OR spec_id = ANY($2::text[])`,
    [workspaceIds, FIXTURE_SPEC_IDS],
  );
  await ownerExecute(
    `DELETE FROM spec_jobs
     WHERE workspace_id = ANY($1::text[]) OR spec_id = ANY($2::text[])`,
    [workspaceIds, FIXTURE_SPEC_IDS],
  );
  await ownerExecute(
    `DELETE FROM story_results result USING pipeline_runs run
     WHERE result.run_id = run.id AND run.workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM story_commits commit_row USING pipeline_runs run
     WHERE commit_row.run_id = run.id AND run.workspace_id = ANY($1::text[])`,
    [workspaceIds],
  );
  await ownerExecute('DELETE FROM pipeline_runs WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await ownerExecute(
    `DELETE FROM wal_events
     WHERE workspace_id = ANY($1::text[]) OR spec_id = ANY($2::text[])`,
    [workspaceIds, FIXTURE_SPEC_IDS],
  );
  await ownerExecute('DELETE FROM spec_search_index WHERE workspace_id = ANY($1::text[]) OR spec_slug = ANY($2::text[])', [workspaceIds, FIXTURE_SPEC_IDS]);
  await ownerExecute('DELETE FROM spec_versions WHERE spec_slug = ANY($1::text[])', [FIXTURE_SPEC_IDS]);
  await ownerExecute('DELETE FROM spec_generation_logs WHERE spec_slug = ANY($1::text[])', [FIXTURE_SPEC_IDS]);
  await ownerExecute('DELETE FROM workspace_context WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await ownerExecute('DELETE FROM direction_layers WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
}

function cleanFixtureFiles(): void {
  fs.rmSync(path.join(workspaceDir, 'forge', 'specs'), { recursive: true, force: true });
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WORKSPACE_ID;
  ({ getAuthToken } = require('./helpers/auth-helper') as typeof AuthHelperModule);
  ({ queryOne } = require('../../db/index') as typeof DatabaseModule);

  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-spec-repair-'));
  await ownerExecute(
    `INSERT INTO users (id, email, display_name, auth_id, role, plan)
     VALUES ($1, $2, 'Spec Repair Test Admin', $3::uuid, 'admin', 'pro')`,
    [FIXTURE_USER_ID, FIXTURE_USER_EMAIL, FIXTURE_AUTH_ID],
  );

  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: FIXTURE_USER_EMAIL,
    authId: FIXTURE_AUTH_ID,
    role: 'admin',
    displayName: 'Spec Repair Test Admin',
  });
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');

  const pgBoss = require('../../lib/pg-boss');
  mockBossSend = pgBoss.getBoss().send;
});

beforeEach(async () => {
  jest.clearAllMocks();
  const pgBossMod = require('../../lib/pg-boss');
  pgBossMod.__resetCallCount();
  mockBossSend = pgBossMod.getBoss().send;
  mockBossSend.mockClear();

  await cleanFixtureDatabase();
  cleanFixtureFiles();
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, 'Repair Test WS', $2)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, workspaceDir],
  );
});

afterEach(async () => {
  try {
    await cleanFixtureDatabase();
  } finally {
    cleanFixtureFiles();
  }
});

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  try {
    await cleanFixtureDatabase();
    await ownerExecute('DELETE FROM users WHERE id = $1', [FIXTURE_USER_ID]);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await ownerPool.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalWorkspaceScope === undefined) delete process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
  else process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = originalWorkspaceScope;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'spec-repair fixture cleanup failed');
});

describe('PSE-005: POST /api/specs/:specId/repair', () => {
  test('returns 422 when workspaceId is missing', async () => {
    const res = await request(app)
      .post('/api/specs/test-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ dryRun: false });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  test('returns 404 when workspace does not exist', async () => {
    const res = await request(app)
      .post('/api/specs/test-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-nonexistent', dryRun: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 404 when spec file does not exist', async () => {
    const res = await request(app)
      .post('/api/specs/nonexistent-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('returns 409 when spec has an active pipeline run', async () => {
    writeSpecFile(os.tmpdir(), 'blocked-spec');

    await ownerExecute(
      `INSERT INTO pipeline_runs (workspace_id, spec_path, status) VALUES ($1, $2, 'running')`,
      [WORKSPACE_ID, 'forge/specs/pending/blocked-spec.json'],
    );

    const res = await request(app)
      .post('/api/specs/blocked-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('blocked') });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/active pipeline run/i);
  });

  test('healthy spec with a durable workflow returns a true no-op repair result', async () => {
    writeSpecFile(os.tmpdir(), 'healthy-spec');
    await seedGenerationLog('healthy-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });
    await seedDurableWorkflowRun('healthy-spec', {});

    const res = await request(app)
      .post('/api/specs/healthy-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('healthy') });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(true);
    expect(res.body.status).toBe('no_op');
    expect(res.body.specId).toBe('healthy-spec');
    expect(res.body.diagnosis.missingGenerationLog).toBe(false);
    expect(res.body.diagnosis.missingWorkflowRun).toBe(false);
    expect(res.body.actions.every((a: { status: string }) => a.status === 'skipped')).toBe(true);
  });

  test('missing generation log is seeded before repair reports an active workflow conflict', async () => {
    writeSpecFile(os.tmpdir(), 'no-log-spec');
    // No generation log seeded

    const res = await request(app)
      .post('/api/specs/no-log-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('no-log') });

    expect(res.status).toBe(409);
    expect(res.body.status).toBe('conflict');
    expect(res.body.healthy).toBe(false);

    const seedAction = res.body.actions.find((a: { action: string }) => a.action === 'seed_generation_log');
    expect(seedAction).toBeDefined();
    expect(seedAction.status).toBe('repaired');
    expect(res.body.conflict).toMatchObject({ reasonCode: 'active_workflow_run' });

    const log = await queryOne<{ spec_slug: string; context_summary_json: unknown }>(
      'SELECT spec_slug, context_summary_json FROM spec_generation_logs WHERE spec_slug = $1',
      ['no-log-spec'],
    );
    expect(log).toBeDefined();
    expect(log!.spec_slug).toBe('no-log-spec');
  });

  test('failed enrich stage is re-enqueued', async () => {
    writeSpecFile(os.tmpdir(), 'failed-enrich-spec');
    await seedGenerationLog('failed-enrich-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });
    await seedDurableWorkflowRun('failed-enrich-spec', {
      enrich: { requested: true, status: 'failed', reason: 'job_failed' },
    }, 'failed');

    const res = await request(app)
      .post('/api/specs/failed-enrich-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        stages: ['enrich'],
        dryRun: false,
        idempotencyKey: repairOperationKey('failed-enrich'),
      });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.diagnosis.enrichNeedsRepair).toBe(true);

    const enrichAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_enrich');
    expect(enrichAction).toBeDefined();
    expect(enrichAction.status).toBe('repaired');
    expect(enrichAction.jobId).toBeDefined();
  });

  test('failed match-skills stage is re-enqueued', async () => {
    writeSpecFile(os.tmpdir(), 'failed-match-spec');
    await seedGenerationLog('failed-match-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .post('/api/specs/failed-match-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('failed-match') });

    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
    expect(res.body.diagnosis.matchSkillsNeedsRepair).toBe(true);

    const matchAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_match_skills');
    expect(matchAction).toBeDefined();
    expect(matchAction.status).toBe('repaired');
    expect(matchAction.jobId).toBeDefined();
  });

  test('dryRun diagnoses without modifying state', async () => {
    writeSpecFile(os.tmpdir(), 'dryrun-spec');
    // No generation log — should be diagnosed as missing

    const res = await request(app)
      .post('/api/specs/dryrun-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.diagnosis.missingGenerationLog).toBe(true);

    // Actions should be skipped (dryRun), not repaired
    const seedAction = res.body.actions.find((a: { action: string }) => a.action === 'seed_generation_log');
    expect(seedAction).toBeDefined();
    expect(seedAction.status).toBe('skipped');
    expect(seedAction.reason).toMatch(/dry run/i);

    // Verify no generation log was created
    const log = await queryOne<{ spec_slug: string }>(
      'SELECT spec_slug FROM spec_generation_logs WHERE spec_slug = $1',
      ['dryrun-spec'],
    );
    expect(log).toBeUndefined();
  });

  test('idempotency — repeated repair on a durably healthy spec stays no-op', async () => {
    writeSpecFile(os.tmpdir(), 'idem-spec');
    await seedGenerationLog('idem-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });
    await seedDurableWorkflowRun('idem-spec', {});

    const res1 = await request(app)
      .post('/api/specs/idem-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('idem') });

    expect(res1.status).toBe(200);
    expect(res1.body.healthy).toBe(true);
    expect(res1.body.status).toBe('no_op');

    const res2 = await request(app)
      .post('/api/specs/idem-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('idem') });

    expect(res2.status).toBe(200);
    expect(res2.body.healthy).toBe(true);
    expect(res2.body.status).toBe('no_op');
    expect(res2.body.actions.every((a: { status: string }) => a.status === 'skipped')).toBe(true);
  });

  test('selective stage repair via stages param', async () => {
    writeSpecFile(os.tmpdir(), 'selective-spec');
    await seedGenerationLog('selective-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'failed',
    });

    // Only request enrich repair
    const res = await request(app)
      .post('/api/specs/selective-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        stages: ['enrich'],
        dryRun: false,
        idempotencyKey: repairOperationKey('selective'),
      });

    expect(res.status).toBe(200);

    const enrichAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_enrich');
    expect(enrichAction).toBeDefined();
    expect(enrichAction.status).toBe('repaired');

    // match-skills should not appear since it wasn't requested
    const matchAction = res.body.actions.find((a: { action: string }) => a.action === 'enqueue_match_skills');
    expect(matchAction).toBeUndefined();
  });

  test('missing context summary is backfilled when generation log exists', async () => {
    writeSpecFile(os.tmpdir(), 'no-ctx-spec');
    await seedGenerationLog('no-ctx-spec', {
      withContextCaptureStatus: false,
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/no-ctx-spec/repair')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: WORKSPACE_ID, dryRun: false, idempotencyKey: repairOperationKey('no-context') });

    expect(res.status).toBe(200);
    expect(res.body.diagnosis.missingContextSummary).toBe(true);

    const backfillAction = res.body.actions.find((a: { action: string }) => a.action === 'backfill_context_summary');
    expect(backfillAction).toBeDefined();
    expect(backfillAction.status).toBe('repaired');
  });
});

describe('workflow/readiness exact surfaces', () => {
  test('GET /api/specs/:specId/workflow returns stable stage snapshots and safe action hints', async () => {
    writeSpecFile(os.tmpdir(), 'workflow-surface-spec');
    await seedGenerationLog('workflow-surface-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    await request(app)
      .post('/api/specs/workflow-surface-spec/workflow/stages/enrich/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        policyPresetId: 'skill_first_strict',
        dryRun: false,
        idempotencyKey: repairOperationKey('workflow-surface'),
      });

    const res = await request(app)
      .get(`/api/specs/workflow-surface-spec/workflow?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.stages.map((stage: { key: string }) => stage.key)).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);
    expect(res.body.reasonCodes).toEqual(expect.arrayContaining(['post_save_pending']));
    expect(res.body.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'enrich',
        status: expect.stringMatching(/queued|pending|running/),
        workflowRunId: expect.any(Number),
        safeActionHints: expect.any(Array),
      }),
    ]));
    expect(res.body.safeActionHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'inspect_workflow', request: expect.objectContaining({ method: 'GET' }) }),
    ]));
  });

  test('GET /api/specs/:specId/readiness returns reason codes, stage states, and safe action hints', async () => {
    writeSpecFile(os.tmpdir(), 'readiness-surface-spec');
    await seedGenerationLog('readiness-surface-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    await request(app)
      .post('/api/specs/readiness-surface-spec/workflow/stages/enrich/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        dryRun: false,
        idempotencyKey: repairOperationKey('readiness-surface'),
      });

    const res = await request(app)
      .get(`/api/specs/readiness-surface-spec/readiness?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.readinessState.status).toBe('blocked');
    expect(res.body.reasonCodes).toEqual(expect.arrayContaining(['post_save_pending']));
    expect(res.body.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'enrich', status: expect.stringMatching(/queued|pending|running/) }),
    ]));
    expect(res.body.safeActionHints).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'wait_for_post_save' }),
      expect.objectContaining({ action: 'inspect_readiness' }),
    ]));
    // US-010: readiness always carries a per-phase coverage projection for all
    // 11 SSDLC phases. Without an installed canon package this test fixture
    // exercises the degraded path: every phase present, none available.
    expect(res.body.coverageByPhase).toBeDefined();
    expect(res.body.coverageByPhase.adapterStatus).toBe('degraded');
    expect(res.body.coverageByPhase.message).toBeTruthy();
    expect(Object.keys(res.body.coverageByPhase.phases)).toEqual([
      'planning', 'requirements', 'design', 'development', 'testing', 'deployment', 'maintenance',
    ]);
    for (const entry of Object.values(res.body.coverageByPhase.phases)) {
      expect(entry).toMatchObject({
        inScope: false,
        required: [],
        covered: [],
        uncovered: [],
        missingSkills: [],
      });
    }
  });

  test('POST /api/specs/:specId/workflow/stages/:stageKey/retry echoes policy-aware action metadata', async () => {
    writeSpecFile(os.tmpdir(), 'stage-retry-spec');
    await seedGenerationLog('stage-retry-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'failed',
    });

    const res = await request(app)
      .post('/api/specs/stage-retry-spec/workflow/stages/matchSkills/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        policyPresetId: 'skill_first_strict',
        dryRun: false,
        idempotencyKey: repairOperationKey('stage-retry'),
      });

    expect(res.status).toBe(200);
    expect(res.body.requestedStageKey).toBe('matchSkills');
    expect(res.body.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'enqueue_match_skills',
        stageKey: 'matchSkills',
        status: 'repaired',
        policy: expect.objectContaining({
          effectivePolicy: expect.objectContaining({ onFailure: 'fail', presetId: 'skill_first_strict' }),
        }),
      }),
    ]));
    expect(res.body.workflow.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'matchSkills', bossJobId: expect.any(String) }),
    ]));
    expect(res.body.readiness.reasonCodes).toContain('post_save_pending');
  });

  test('POST /api/specs/:specId/workflow/stages/memorySynthesis/retry preserves the persisted memory material', async () => {
    writeSpecFile(os.tmpdir(), 'memory-retry-spec', {
      title: 'Memory Repair Spec',
      brief: 'Persisted memory repair brief',
    });
    await seedGenerationLog('memory-retry-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'completed',
    });
    await seedDurableWorkflowRun('memory-retry-spec', {
      memorySynthesis: { requested: true, status: 'failed', reason: 'job_failed' },
    }, 'failed');

    const res = await request(app)
      .post('/api/specs/memory-retry-spec/workflow/stages/memorySynthesis/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        policyPresetId: 'enterprise_governed',
        dryRun: false,
        idempotencyKey: repairOperationKey('memory-retry'),
      });

    expect(res.status).toBe(200);
    const action = res.body.actions.find((candidate: { stageKey?: string }) => candidate.stageKey === 'memorySynthesis');
    expect(action).toMatchObject({
      action: 'enqueue_memory_synthesis',
      status: 'repaired',
      jobId: expect.any(String),
    });
    const persisted = await queryOne<{ request_payload: { memory?: Record<string, unknown> } }>(
      'SELECT request_payload FROM spec_jobs WHERE id = $1::uuid',
      [action.jobId],
    );
    expect(persisted?.request_payload.memory).toMatchObject({
      brief: 'Persisted memory repair brief',
      stories: [expect.objectContaining({ id: 'US-001' })],
      contextSummary: expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        contextCaptureStatus: expect.objectContaining({ status: 'provided' }),
      }),
    });
  });

  test('POST /api/specs/:specId/workflow/stages/:stageKey/retry backfills legacy generation-log state into a durable workflow run', async () => {
    writeSpecFile(os.tmpdir(), 'legacy-backfill-spec');
    await seedGenerationLog('legacy-backfill-spec', {
      enrichStatus: 'completed',
      matchSkillsStatus: 'failed',
    });

    const before = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM spec_post_save_workflow_runs WHERE workspace_id = $1 AND spec_id = $2`,
      [WORKSPACE_ID, 'legacy-backfill-spec'],
    );
    expect(Number(before?.count ?? '0')).toBe(0);

    const retryRes = await request(app)
      .post('/api/specs/legacy-backfill-spec/workflow/stages/matchSkills/retry')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        policyPresetId: 'repair_only',
        dryRun: false,
        idempotencyKey: repairOperationKey('legacy-backfill'),
      });

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.workflow.workflow.runId).toEqual(expect.any(Number));

    const runId = retryRes.body.workflow.workflow.runId as number;
    const persistedRun = await queryOne<{ effective_policy: unknown }>(
      `SELECT effective_policy FROM spec_post_save_workflow_runs WHERE id = $1`,
      [runId],
    );
    expect(persistedRun?.effective_policy).toMatchObject({
      version: 'v1',
      presetId: 'repair_only',
      enrich: 'skip',
      skills: 'match',
      memory: 'skip',
    });

    const persistedStages = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM spec_post_save_workflow_stages WHERE run_id = $1`,
      [runId],
    );
    expect(Number(persistedStages?.count ?? '0')).toBe(4);

    const workflowRes = await request(app)
      .get(`/api/specs/legacy-backfill-spec/workflow?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(workflowRes.status).toBe(200);
    expect(workflowRes.body.workflow.runId).toBe(runId);
    expect(workflowRes.body.stages.map((stage: { key: string }) => stage.key)).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);
    expect(workflowRes.body.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'context', status: 'completed', reasonCode: 'context_captured' }),
      expect.objectContaining({ key: 'matchSkills', requested: true, status: expect.stringMatching(/queued|pending|running/) }),
    ]));
  });

  test('POST /api/specs/repair-batch returns the same durable workflow/readiness model plus requestedPolicy', async () => {
    writeSpecFile(os.tmpdir(), 'batch-repair-spec');
    await seedGenerationLog('batch-repair-spec', {
      enrichStatus: 'failed',
      matchSkillsStatus: 'completed',
    });

    const res = await request(app)
      .post('/api/specs/repair-batch')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: WORKSPACE_ID,
        categories: ['stage_failed'],
        limit: 1,
        dryRun: false,
        policyPresetId: 'repair_only',
        idempotencyKey: repairOperationKey('batch'),
      });

    expect(res.status).toBe(200);
    expect(res.body.requestedPolicy).toBe('repair_only');
    expect(res.body.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        specId: 'batch-repair-spec',
        requestedPolicy: 'repair_only',
        workflow: expect.objectContaining({
          reasonCodes: expect.arrayContaining(['post_save_pending']),
          stages: expect.arrayContaining([
            expect.objectContaining({ key: 'enrich', bossJobId: expect.any(String) }),
          ]),
        }),
        readiness: expect.objectContaining({
          reasonCodes: expect.arrayContaining(['post_save_pending']),
          safeActionHints: expect.arrayContaining([
            expect.objectContaining({ action: 'wait_for_post_save' }),
          ]),
        }),
      }),
    ]));
  });
});
