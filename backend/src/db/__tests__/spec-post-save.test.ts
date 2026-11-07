/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type * as DatabaseModule from '../index';
import type * as SpecPostSaveModule from '../spec-post-save';
import type { PostSaveWorkflowStage } from '../spec-post-save';

const originalWorkspaceScope = Object.prototype.hasOwnProperty.call(
  process.env,
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
)
  ? { present: true as const, value: process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE! }
  : { present: false as const };
const workspaceId = `spec-post-save-${randomUUID()}`;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = workspaceId;

const {
  attachBossJobId,
  createRun,
  getLatestRunForSpec,
  getRunById,
  hashEffectivePolicy,
  insertStages,
  listActiveWorkflowConflicts,
  listStagesByRun,
  projectPostSaveStages,
  updateStageStatus,
} = require('../spec-post-save') as typeof SpecPostSaveModule;
const {
  closePool,
  pool: runtimePool,
} = require('../index') as typeof DatabaseModule;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 2,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}`,
});

async function cleanupFixtures(): Promise<void> {
  await ownerPool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
}

async function expectRuntimeOwnerActionDenied(sql: string): Promise<void> {
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

beforeEach(async () => {
  await cleanupFixtures();
  await ownerPool.query(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Spec Post-Save Workspace', $2)`,
    [workspaceId, `/tmp/${workspaceId}`],
  );
});

afterEach(cleanupFixtures);

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    cleanupFixtures,
    closePool,
    () => ownerPool.end(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (originalWorkspaceScope.present) {
    process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = originalWorkspaceScope.value;
  } else {
    delete process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'spec post-save cleanup failed');
  }
});

describe('spec-post-save durable workflow helpers', () => {
  it('hashes effective policy independent of object key order', () => {
    const first = hashEffectivePolicy({ postSave: { enrich: true, matchSkills: false, memorySynthesis: false }, version: 1 });
    const second = hashEffectivePolicy({ version: 1, postSave: { memorySynthesis: false, matchSkills: false, enrich: true } });

    expect(first).toBe(second);
  });

  it('denies migration-owner fixture and catalog actions to the scoped runtime', async () => {
    await expectRuntimeOwnerActionDenied(
      'ALTER TABLE spec_post_save_workflow_runs ADD COLUMN runtime_owner_probe BOOLEAN',
    );
    await expectRuntimeOwnerActionDenied('TRUNCATE spec_post_save_workflow_runs CASCADE');
  });

  it('creates runs, stages, edges, and updates durable status through the helper API', async () => {
    const policy = {
      version: 1,
      postSave: {
        enrich: true,
        matchSkills: false,
        memorySynthesis: false,
      },
    };

    const run = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-a',
      saveGeneration: 9001,
      effectivePolicy: policy,
      idempotencyKey: 'run-a-9001',
      status: 'pending',
    });

    expect(run.workspaceId).toBe(workspaceId);
    expect(run.specId).toBe('spec-a');
    expect(run.effectivePolicyHash).toBe(hashEffectivePolicy(policy));

    const inserted = await insertStages(
      run.id,
      [
        {
          stageKey: 'context',
          requested: true,
          status: 'completed',
          reason: 'context_captured',
          finishedAt: new Date('2026-06-18T12:00:00.000Z'),
        },
        {
          stageKey: 'enrich',
          requested: true,
          status: 'pending',
          reason: 'requested_by_policy',
          fingerprint: 'enrich-fp-1',
        },
        {
          stageKey: 'matchSkills',
          requested: false,
          status: 'skipped',
          reason: 'disabled_by_policy',
          finishedAt: new Date('2026-06-18T12:00:00.000Z'),
        },
        {
          stageKey: 'memorySynthesis',
          requested: false,
          status: 'skipped',
          reason: 'disabled_by_policy',
          finishedAt: new Date('2026-06-18T12:00:00.000Z'),
        },
      ],
      [
        { stageKey: 'enrich', dependsOnStageKey: 'context' },
        { stageKey: 'matchSkills', dependsOnStageKey: 'enrich' },
        { stageKey: 'memorySynthesis', dependsOnStageKey: 'matchSkills' },
      ],
    );

    expect(inserted.map((stage) => stage.stageKey).sort()).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);

    const dependencyRows = await runtimePool.query<{ stage_key: string; depends_on_stage_key: string }>(
      `SELECT stage_key, depends_on_stage_key
       FROM spec_post_save_stage_dependencies
       WHERE run_id = $1
       ORDER BY stage_key, depends_on_stage_key`,
      [run.id],
    );
    expect(dependencyRows.rows).toEqual([
      { stage_key: 'enrich', depends_on_stage_key: 'context' },
      { stage_key: 'matchSkills', depends_on_stage_key: 'enrich' },
      { stage_key: 'memorySynthesis', depends_on_stage_key: 'matchSkills' },
    ]);

    const queued = await attachBossJobId(run.id, 'enrich', 'boss-job-1');
    expect(queued).toMatchObject({
      runId: run.id,
      stageKey: 'enrich',
      status: 'queued',
      reason: 'durable_job_enqueued',
      bossJobId: 'boss-job-1',
    });

    const running = await updateStageStatus({
      runId: run.id,
      stageKey: 'enrich',
      status: 'running',
      reason: 'job_started',
      allowedCurrentStatuses: ['queued'],
      queueStatus: 'running',
      queuePosition: 0,
      activeJobsAhead: 0,
    });
    expect(running).toMatchObject({
      status: 'running',
      reason: 'job_started',
      queueStatus: 'running',
      queuePosition: 0,
    });
    expect(running?.startedAt).toBeInstanceOf(Date);

    const completed = await updateStageStatus({
      runId: run.id,
      stageKey: 'enrich',
      status: 'completed',
      reason: 'job_completed',
      allowedCurrentStatuses: ['running'],
      finishedAt: new Date('2026-06-18T12:05:00.000Z'),
    });
    expect(completed).toMatchObject({
      status: 'completed',
      reason: 'job_completed',
      bossJobId: 'boss-job-1',
    });

    const persistedStages = await listStagesByRun(run.id);
    expect(persistedStages.map((stage) => stage.stageKey)).toEqual(['context', 'enrich', 'matchSkills', 'memorySynthesis']);
    expect(projectPostSaveStages(persistedStages)).toMatchObject({
      enrich: expect.objectContaining({
        requested: true,
        status: 'completed',
        reason: 'job_completed',
        bossJobId: 'boss-job-1',
      }),
    });

    const latest = await getLatestRunForSpec('spec-a', {
      workspaceId: workspaceId,
      saveGeneration: 9001,
    });
    expect(latest).not.toBeNull();
    expect(latest?.status).toBe('completed');

    const conflicts = await listActiveWorkflowConflicts({
      workspaceId: workspaceId,
      specId: 'spec-a',
      effectivePolicy: policy,
    });
    expect(conflicts).toEqual([]);
  });

  it('looks up an exact run by ID only when every workflow binding matches', async () => {
    const policy = { version: 'v1', presetId: 'skill_first_strict', memory: 'synthesize', onFailure: 'fail' };
    const run = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-exact-run',
      saveGeneration: 432,
      generationLogId: null,
      effectivePolicy: policy,
      idempotencyKey: 'exact-run-80',
      status: 'pending',
    });
    const binding = {
      workspaceId: workspaceId,
      specId: 'spec-exact-run',
      saveGeneration: 432,
      effectivePolicyHash: hashEffectivePolicy(policy),
    };

    await expect(getRunById(run.id, binding)).resolves.toMatchObject({ id: run.id, ...binding });
    await expect(getRunById(run.id, { ...binding, workspaceId: 'wrong' })).resolves.toBeNull();
    await expect(getRunById(run.id, { ...binding, specId: 'wrong' })).resolves.toBeNull();
    await expect(getRunById(run.id, { ...binding, saveGeneration: 433 })).resolves.toBeNull();
    await expect(getRunById(run.id, { ...binding, effectivePolicyHash: '0'.repeat(64) })).resolves.toBeNull();
    await expect(getRunById(run.id + 1, binding)).resolves.toBeNull();
  });

  it('treats the effective policy hash as part of run idempotency', async () => {
    const policyA = {
      version: 1,
      postSave: {
        enrich: true,
        matchSkills: false,
        memorySynthesis: false,
      },
    };
    const policyB = {
      version: 1,
      postSave: {
        enrich: false,
        matchSkills: true,
        memorySynthesis: false,
      },
    };

    const firstRun = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-policy-idempotency',
      saveGeneration: 9100,
      effectivePolicy: policyA,
      idempotencyKey: 'same-save-generation',
      status: 'pending',
    });

    const replayedRun = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-policy-idempotency',
      saveGeneration: 9100,
      effectivePolicy: policyA,
      idempotencyKey: 'same-save-generation',
      status: 'pending',
    });
    expect(replayedRun.id).toBe(firstRun.id);

    const policyChangedRun = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-policy-idempotency',
      saveGeneration: 9100,
      effectivePolicy: policyB,
      idempotencyKey: 'same-save-generation',
      status: 'pending',
    });

    expect(policyChangedRun.id).not.toBe(firstRun.id);
    expect(policyChangedRun.effectivePolicyHash).toBe(hashEffectivePolicy(policyB));

    await expect(createRun({
      workspaceId: workspaceId,
      specId: 'spec-policy-idempotency',
      saveGeneration: 9101,
      effectivePolicy: policyB,
      idempotencyKey: 'different-idempotency-same-policy',
      status: 'pending',
    })).rejects.toThrow(/duplicate key|idx_spec_post_save_runs_active_policy_unique/i);
  });

  it('blocks duplicate active runs for the same spec and effective policy but allows a new run after completion', async () => {
    const policy = {
      version: 1,
      postSave: {
        enrich: true,
        matchSkills: true,
        memorySynthesis: false,
      },
    };

    const firstRun = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-b',
      saveGeneration: 9002,
      effectivePolicy: policy,
      idempotencyKey: 'run-b-9002',
      status: 'pending',
    });

    await insertStages(firstRun.id, [
      {
        stageKey: 'context',
        requested: true,
        status: 'completed',
        reason: 'context_captured',
        finishedAt: new Date('2026-06-18T13:00:00.000Z'),
      },
      {
        stageKey: 'enrich',
        requested: true,
        status: 'pending',
        reason: 'requested_by_policy',
      },
      {
        stageKey: 'matchSkills',
        requested: false,
        status: 'skipped',
        reason: 'disabled_by_policy',
        finishedAt: new Date('2026-06-18T13:00:00.000Z'),
      },
      {
        stageKey: 'memorySynthesis',
        requested: false,
        status: 'skipped',
        reason: 'disabled_by_policy',
        finishedAt: new Date('2026-06-18T13:00:00.000Z'),
      },
    ]);

    await expect(createRun({
      workspaceId: workspaceId,
      specId: 'spec-b',
      saveGeneration: 9003,
      effectivePolicy: policy,
      idempotencyKey: 'run-b-9003',
      status: 'pending',
    })).rejects.toThrow(/duplicate key|idx_spec_post_save_runs_active_policy_unique/i);

    const activeConflicts = await listActiveWorkflowConflicts({
      workspaceId: workspaceId,
      specId: 'spec-b',
      effectivePolicy: policy,
    });
    expect(activeConflicts.map((conflict) => conflict.id)).toEqual([firstRun.id]);

    await updateStageStatus({
      runId: firstRun.id,
      stageKey: 'enrich',
      status: 'completed',
      reason: 'job_completed',
      finishedAt: new Date('2026-06-18T13:05:00.000Z'),
    });

    const secondRun = await createRun({
      workspaceId: workspaceId,
      specId: 'spec-b',
      saveGeneration: 9003,
      effectivePolicy: policy,
      idempotencyKey: 'run-b-9003',
      status: 'pending',
    });

    expect(secondRun.id).toBeGreaterThan(firstRun.id);
  });

  it('locks the v1 migration contract for workflow stage keys and idempotency columns', async () => {
    const stageConstraint = await ownerPool.query<{ constraintdef: string }>(
      `SELECT pg_get_constraintdef(oid) AS constraintdef
       FROM pg_constraint
       WHERE conname = 'spec_post_save_workflow_stages_stage_key_check'`,
    );
    expect(stageConstraint.rows).toHaveLength(1);
    expect(stageConstraint.rows[0].constraintdef).toContain('context');
    expect(stageConstraint.rows[0].constraintdef).toContain('enrich');
    expect(stageConstraint.rows[0].constraintdef).toContain('matchSkills');
    expect(stageConstraint.rows[0].constraintdef).toContain('memorySynthesis');

    const idempotencyColumns = await ownerPool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.table_name = 'spec_post_save_workflow_runs'
         AND tc.constraint_name = 'spec_post_save_workflow_runs_idempotency_unique'
       ORDER BY kcu.ordinal_position`,
    );
    expect(idempotencyColumns.rows.map((row) => row.column_name)).toEqual([
      'workspace_id',
      'spec_id',
      'effective_policy_hash',
      'idempotency_key',
    ]);
  });

  it('projects durable stage rows into the legacy postSaveStages shape', () => {
    const now = new Date('2026-06-18T15:00:00.000Z');
    const stages: PostSaveWorkflowStage[] = [
      {
        id: 1,
        runId: 10,
        stageKey: 'enrich',
        requested: true,
        status: 'queued',
        reason: 'durable_job_enqueued',
        jobId: '11111111-1111-4111-8111-111111111111',
        bossJobId: 'boss-1',
        queueName: 'spec:enrich',
        transportSchema: 'pgboss',
        queueStatus: 'queued',
        queuePosition: 1,
        activeJobsAhead: 0,
        queuePriority: 1,
        singletonKey: 'persist-post-save:ws:spec',
        fingerprint: 'enrich-v1',
        previousFingerprint: null,
        errorMessage: null,
        details: {},
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      },
      {
        id: 2,
        runId: 10,
        stageKey: 'memorySynthesis',
        requested: false,
        status: 'skipped',
        reason: 'disabled_by_caller',
        jobId: null,
        bossJobId: null,
        queueName: null,
        transportSchema: null,
        queueStatus: null,
        queuePosition: null,
        activeJobsAhead: null,
        queuePriority: null,
        singletonKey: null,
        fingerprint: null,
        previousFingerprint: null,
        errorMessage: null,
        details: {},
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: now,
      },
    ];

    expect(projectPostSaveStages(stages)).toEqual({
      enrich: {
        requested: true,
        status: 'queued',
        reason: 'durable_job_enqueued',
        jobId: '11111111-1111-4111-8111-111111111111',
        bossJobId: 'boss-1',
        updatedAt: '2026-06-18T15:00:00.000Z',
        fingerprint: 'enrich-v1',
        queueName: 'spec:enrich',
        transportSchema: 'pgboss',
        queueStatus: 'queued',
        queuePosition: 1,
        activeJobsAhead: 0,
        queuePriority: 1,
        singletonKey: 'persist-post-save:ws:spec',
      },
      memorySynthesis: {
        requested: false,
        status: 'skipped',
        reason: 'disabled_by_caller',
        updatedAt: '2026-06-18T15:00:00.000Z',
      },
    });
  });
});
