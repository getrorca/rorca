/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PSE-003: Unit tests for the post-save stage status contract.
 *
 * Tests cover:
 *   (1) buildPersistPostSaveStages sets correct initial states
 *   (2) Requested stages start as pending with reason 'requested_by_caller'
 *   (3) Disabled stages start as skipped with reason 'disabled_by_caller'
 *   (4) Mixed requested/disabled stages are handled correctly
 *   (5) All three stages (enrich, matchSkills, memorySynthesis) are always present
 *   (6) Stage status type includes all canonical values
 */

import {
  buildPersistPostSaveStages,
  getEffectiveGenerationLog,
  getEffectiveGenerationLogs,
  type PersistStageStatus,
  type PersistPostSaveStageState,
} from '../spec-post-save';
import { query } from '../../db/index';
import {
  getLatestRunForSpec,
  listStagesByRun,
  type PostSaveWorkflowRun,
  type PostSaveWorkflowStage,
} from '../../db/spec-post-save';

// Mock DB and pg-boss — buildPersistPostSaveStages is pure logic, no I/O needed
jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  execute: jest.fn(),
}));
jest.mock('../../db/spec-post-save', () => {
  const actual = jest.requireActual('../../db/spec-post-save');
  return {
    ...actual,
    createRun: jest.fn(),
    getLatestRunForSpec: jest.fn(),
    insertStages: jest.fn(),
    listActiveWorkflowConflicts: jest.fn(),
    listStagesByRun: jest.fn(),
    supersedeActiveWorkflowRuns: jest.fn(),
    updateStageStatus: jest.fn(),
  };
});
jest.mock('../../db/spec-jobs', () => ({
  createJob: jest.fn(),
  getJob: jest.fn(),
  listJobsForSpec: jest.fn(),
  updateJobStatus: jest.fn(),
}));
jest.mock('../pg-boss', () => ({
  initBoss: jest.fn(),
  getBoss: jest.fn(),
}));
jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockGetLatestRunForSpec = getLatestRunForSpec as jest.MockedFunction<typeof getLatestRunForSpec>;
const mockListStagesByRun = listStagesByRun as jest.MockedFunction<typeof listStagesByRun>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PSE-003: buildPersistPostSaveStages', () => {
  it('returns pending status for all requested stages', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: true,
      memorySynthesis: true,
    });

    expect(stages.enrich).toMatchObject({
      requested: true,
      status: 'pending',
      reason: 'requested_by_caller',
    });
    expect(stages.matchSkills).toMatchObject({
      requested: true,
      status: 'pending',
      reason: 'requested_by_caller',
    });
    expect(stages.memorySynthesis).toMatchObject({
      requested: true,
      status: 'pending',
      reason: 'requested_by_caller',
    });
  });

  it('returns skipped status for all disabled stages', () => {
    const stages = buildPersistPostSaveStages({
      enrich: false,
      matchSkills: false,
      memorySynthesis: false,
    });

    expect(stages.enrich).toMatchObject({
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    });
    expect(stages.matchSkills).toMatchObject({
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    });
    expect(stages.memorySynthesis).toMatchObject({
      requested: false,
      status: 'skipped',
      reason: 'disabled_by_caller',
    });
  });

  it('handles mixed requested and disabled stages', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: false,
      memorySynthesis: true,
    });

    expect(stages.enrich.requested).toBe(true);
    expect(stages.enrich.status).toBe('pending');
    expect(stages.matchSkills.requested).toBe(false);
    expect(stages.matchSkills.status).toBe('skipped');
    expect(stages.memorySynthesis.requested).toBe(true);
    expect(stages.memorySynthesis.status).toBe('pending');
  });

  it('always includes all three stage keys', () => {
    const stages = buildPersistPostSaveStages({
      enrich: false,
      matchSkills: false,
      memorySynthesis: false,
    });

    expect(Object.keys(stages).sort()).toEqual(['enrich', 'matchSkills', 'memorySynthesis']);
  });

  it('distinguishes "skipped because not requested" from a requested stage', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: false,
      memorySynthesis: false,
    });

    // Skipped stages have requested=false and reason='disabled_by_caller'
    expect(stages.matchSkills.requested).toBe(false);
    expect(stages.matchSkills.status).toBe('skipped');
    expect(stages.matchSkills.reason).toBe('disabled_by_caller');

    // Requested stages have requested=true and reason='requested_by_caller'
    expect(stages.enrich.requested).toBe(true);
    expect(stages.enrich.status).toBe('pending');
    expect(stages.enrich.reason).toBe('requested_by_caller');
  });
});

describe('PSE-003: PersistStageStatus type coverage', () => {
  it('covers all canonical status values', () => {
    const allStatuses: PersistStageStatus[] = [
      'pending', 'queued', 'running', 'completed', 'failed', 'skipped',
    ];
    // Ensure each is a valid assignment (compile-time check manifested as runtime array)
    expect(allStatuses).toHaveLength(6);
  });
});

describe('PSE-003: stage state shape contract', () => {
  it('stage state contains expected fields for a requested stage', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: true,
      memorySynthesis: true,
    });

    const stage: PersistPostSaveStageState = stages.enrich;
    expect(stage).toHaveProperty('requested');
    expect(stage).toHaveProperty('status');
    expect(stage).toHaveProperty('reason');
    // jobId, bossJobId, error, updatedAt are optional at initial state
    expect(stage.jobId).toBeUndefined();
    expect(stage.bossJobId).toBeUndefined();
    expect(stage.error).toBeUndefined();
  });
});

describe('PSE-003: effective generation-log projection', () => {
  const runByGeneration = new Map<number, PostSaveWorkflowRun>([
    [7001, { id: 71, workspaceId: 'ws-test', specId: 'durable-spec', generationLogId: 7001, saveGeneration: 7001, effectivePolicyHash: 'hash-1', effectivePolicy: {}, idempotencyKey: 'run-7001', status: 'queued', source: 'persist-post-save', errorMessage: null, createdAt: new Date('2026-06-18T12:00:00.000Z'), updatedAt: new Date('2026-06-18T12:00:00.000Z'), finishedAt: null }],
    [7000, { id: 70, workspaceId: 'ws-test', specId: 'durable-spec', generationLogId: 7000, saveGeneration: 7000, effectivePolicyHash: 'hash-0', effectivePolicy: {}, idempotencyKey: 'run-7000', status: 'completed', source: 'persist-post-save', errorMessage: null, createdAt: new Date('2026-06-18T11:00:00.000Z'), updatedAt: new Date('2026-06-18T11:00:00.000Z'), finishedAt: new Date('2026-06-18T11:10:00.000Z') }],
  ]);
  const stageRowsByRun = new Map<number, PostSaveWorkflowStage[]>([
    [71, [
      {
        id: 1,
        runId: 71,
        stageKey: 'enrich',
        requested: true,
        status: 'queued',
        reason: 'durable_job_enqueued',
        jobId: '11111111-1111-4111-8111-111111111111',
        bossJobId: 'boss-queued',
        queueName: 'spec:enrich',
        transportSchema: 'pgboss',
        queueStatus: 'queued',
        queuePosition: 1,
        activeJobsAhead: 0,
        queuePriority: 1,
        singletonKey: 'persist-post-save:ws-test:durable-spec',
        fingerprint: 'enrich-queued',
        previousFingerprint: null,
        errorMessage: null,
        details: {},
        createdAt: new Date('2026-06-18T12:00:00.000Z'),
        updatedAt: new Date('2026-06-18T12:00:00.000Z'),
        startedAt: null,
        finishedAt: null,
      },
      {
        id: 2,
        runId: 71,
        stageKey: 'matchSkills',
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
        createdAt: new Date('2026-06-18T12:00:00.000Z'),
        updatedAt: new Date('2026-06-18T12:00:00.000Z'),
        startedAt: null,
        finishedAt: new Date('2026-06-18T12:00:00.000Z'),
      },
      {
        id: 3,
        runId: 71,
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
        createdAt: new Date('2026-06-18T12:00:00.000Z'),
        updatedAt: new Date('2026-06-18T12:00:00.000Z'),
        startedAt: null,
        finishedAt: new Date('2026-06-18T12:00:00.000Z'),
      },
    ]],
    [70, [
      {
        id: 4,
        runId: 70,
        stageKey: 'enrich',
        requested: true,
        status: 'completed',
        reason: 'job_completed',
        jobId: '22222222-2222-4222-8222-222222222222',
        bossJobId: 'boss-completed',
        queueName: 'spec:enrich',
        transportSchema: 'pgboss',
        queueStatus: 'running',
        queuePosition: 0,
        activeJobsAhead: 0,
        queuePriority: 1,
        singletonKey: 'persist-post-save:ws-test:durable-spec',
        fingerprint: 'enrich-completed',
        previousFingerprint: null,
        errorMessage: null,
        details: {},
        createdAt: new Date('2026-06-18T11:00:00.000Z'),
        updatedAt: new Date('2026-06-18T11:10:00.000Z'),
        startedAt: new Date('2026-06-18T11:01:00.000Z'),
        finishedAt: new Date('2026-06-18T11:10:00.000Z'),
      },
      {
        id: 5,
        runId: 70,
        stageKey: 'matchSkills',
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
        createdAt: new Date('2026-06-18T11:00:00.000Z'),
        updatedAt: new Date('2026-06-18T11:10:00.000Z'),
        startedAt: null,
        finishedAt: new Date('2026-06-18T11:10:00.000Z'),
      },
      {
        id: 6,
        runId: 70,
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
        createdAt: new Date('2026-06-18T11:00:00.000Z'),
        updatedAt: new Date('2026-06-18T11:10:00.000Z'),
        startedAt: null,
        finishedAt: new Date('2026-06-18T11:10:00.000Z'),
      },
    ]],
  ]);

  beforeEach(() => {
    mockGetLatestRunForSpec.mockImplementation(async (_specId, options) => {
      const generation = options?.saveGeneration ?? 7001;
      return runByGeneration.get(generation) ?? null;
    });
    mockListStagesByRun.mockImplementation(async (runId) => stageRowsByRun.get(runId) ?? []);
  });

  it('projects durable workflow rows into the latest generation log when legacy JSON is missing', async () => {
    mockQuery.mockResolvedValue([
      {
        id: 7001,
        spec_slug: 'durable-spec',
        status: 'pending_enrichment',
        save_generation: 7001,
        context_summary_json: {
          workspaceId: 'ws-test',
          saveGeneration: 7001,
          title: 'Durable Spec',
        },
      },
    ] as never);

    const log = await getEffectiveGenerationLog('durable-spec');
    const summary = log?.context_summary_json as Record<string, any>;

    expect(summary.postSaveStages.enrich).toMatchObject({
      requested: true,
      status: 'queued',
      reason: 'durable_job_enqueued',
      bossJobId: 'boss-queued',
    });
    expect(log?.status).toBe('pending_enrichment');
  });

  it('projects durable workflow rows for historical logs returned by ?all=true consumers', async () => {
    mockQuery.mockResolvedValue([
      {
        id: 7001,
        spec_slug: 'durable-spec',
        status: 'pending_enrichment',
        save_generation: 7001,
        context_summary_json: {
          workspaceId: 'ws-test',
          saveGeneration: 7001,
          title: 'Durable Spec',
        },
      },
      {
        id: 7000,
        spec_slug: 'durable-spec',
        status: 'persisted',
        save_generation: 7000,
        context_summary_json: {
          workspaceId: 'ws-test',
          saveGeneration: 7000,
          title: 'Durable Spec v0',
        },
      },
    ] as never);

    const result = await getEffectiveGenerationLogs('durable-spec');
    const historicalSummary = result[1]?.context_summary_json as Record<string, any>;

    expect(result).toHaveLength(2);
    expect(historicalSummary.postSaveStages.enrich).toMatchObject({
      requested: true,
      status: 'completed',
      reason: 'job_completed',
      bossJobId: 'boss-completed',
    });
    expect(mockGetLatestRunForSpec).toHaveBeenCalledWith('durable-spec', expect.objectContaining({
      workspaceId: 'ws-test',
      saveGeneration: 7000,
    }));
  });
});
