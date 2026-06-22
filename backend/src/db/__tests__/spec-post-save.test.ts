/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool } from 'pg';
import {
  attachBossJobId,
  createRun,
  getLatestRunForSpec,
  hashEffectivePolicy,
  insertStages,
  listActiveWorkflowConflicts,
  listStagesByRun,
  projectPostSaveStages,
  updateStageStatus,
  type PostSaveWorkflowStage,
} from '../spec-post-save';
import { closeTestPool, getTestPool, truncateAll } from '../../__tests__/helpers/pg-test-utils';

let pool: Pool;

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  await pool.query(
    `INSERT INTO workspaces (id, label, path)
     VALUES ('ws-test', 'Test Workspace', '/tmp/ws-test')
     ON CONFLICT (id) DO NOTHING`,
  );
});

describe('spec-post-save durable workflow helpers', () => {
  it('hashes effective policy independent of object key order', () => {
    const first = hashEffectivePolicy({ postSave: { enrich: true, matchSkills: false, memorySynthesis: false }, version: 1 });
    const second = hashEffectivePolicy({ version: 1, postSave: { memorySynthesis: false, matchSkills: false, enrich: true } });

    expect(first).toBe(second);
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
      workspaceId: 'ws-test',
      specId: 'spec-a',
      saveGeneration: 9001,
      effectivePolicy: policy,
      idempotencyKey: 'run-a-9001',
      status: 'pending',
    });

    expect(run.workspaceId).toBe('ws-test');
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

    const dependencyRows = await pool.query<{ stage_key: string; depends_on_stage_key: string }>(
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
      workspaceId: 'ws-test',
      saveGeneration: 9001,
    });
    expect(latest).not.toBeNull();
    expect(latest?.status).toBe('completed');

    const conflicts = await listActiveWorkflowConflicts({
      workspaceId: 'ws-test',
      specId: 'spec-a',
      effectivePolicy: policy,
    });
    expect(conflicts).toEqual([]);
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
      workspaceId: 'ws-test',
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
      workspaceId: 'ws-test',
      specId: 'spec-b',
      saveGeneration: 9003,
      effectivePolicy: policy,
      idempotencyKey: 'run-b-9003',
      status: 'pending',
    })).rejects.toThrow(/duplicate key|idx_spec_post_save_runs_active_policy_unique/i);

    const activeConflicts = await listActiveWorkflowConflicts({
      workspaceId: 'ws-test',
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
      workspaceId: 'ws-test',
      specId: 'spec-b',
      saveGeneration: 9003,
      effectivePolicy: policy,
      idempotencyKey: 'run-b-9003',
      status: 'pending',
    });

    expect(secondRun.id).toBeGreaterThan(firstRun.id);
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
