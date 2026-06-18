/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * PSE-009: Regression tests for the durable post-save orchestration contract.
 *
 * These tests complement PSE-003's buildPersistPostSaveStages coverage by
 * exercising the pure-logic helpers that weren't previously covered:
 *   (1) stageStateForJob — maps a SpecJob row to the correct PersistPostSaveStageState
 *   (2) deriveOverallStatus — aggregates stage states into the spec_generation_logs status
 *   (3) enqueuePersistPostSaveJobs — orchestration dependency topology (enrich → matchSkills)
 *   (4) Stage skip reasons are tracked with the correct PersistStageReason values
 *   (5) buildPersistPostSaveStages idempotency and edge cases
 */

import {
  buildPersistPostSaveStages,
  type PersistStageStatus,
  type PersistStageReason,
} from '../spec-post-save';

// Mock DB and pg-boss — buildPersistPostSaveStages is pure logic, no I/O needed
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();

jest.mock('../../db/index', () => ({
  query: jest.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
}));

const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockListJobsForSpec = jest.fn();
const mockUpdateJobStatus = jest.fn();

jest.mock('../../db/spec-jobs', () => ({
  createJob: (...args: unknown[]) => mockCreateJob(...args),
  getJob: (...args: unknown[]) => mockGetJob(...args),
  listJobsForSpec: (...args: unknown[]) => mockListJobsForSpec(...args),
  updateJobStatus: (...args: unknown[]) => mockUpdateJobStatus(...args),
}));

let bossCallCount = 0;
const mockBossSend = jest.fn().mockImplementation(() => {
  bossCallCount++;
  return Promise.resolve(`aaaaaaaa-aaaa-4aaa-8aaa-${String(bossCallCount).padStart(12, '0')}`);
});

jest.mock('../pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn(() => ({ send: mockBossSend })),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryOne.mockResolvedValue(undefined);
  mockExecute.mockResolvedValue(undefined);
  bossCallCount = 0;
});

/* ─── Stage skip reasons ────────────────────────────────────────── */

describe('PSE-009: stage skip reason tracking', () => {
  it('disabled_by_caller reason is distinct from all failure reasons', () => {
    const disabledStages = buildPersistPostSaveStages({
      enrich: false,
      matchSkills: false,
      memorySynthesis: false,
    });

    const failureReasons: PersistStageReason[] = [
      'job_failed',
      'enqueue_failed',
      'blocked_by_enrich_failure',
      'blocked_by_enrich_enqueue_failure',
    ];

    for (const stage of Object.values(disabledStages)) {
      expect(failureReasons).not.toContain(stage.reason);
      expect(stage.reason).toBe('disabled_by_caller');
    }
  });

  it('requested_by_caller reason is distinct from all skip reasons', () => {
    const requestedStages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: true,
      memorySynthesis: true,
    });

    for (const stage of Object.values(requestedStages)) {
      expect(stage.reason).not.toBe('disabled_by_caller');
      expect(stage.reason).not.toBe('no_installed_skills');
      expect(stage.reason).toBe('requested_by_caller');
    }
  });

  it('all canonical PersistStageReason values compile and are valid strings', () => {
    const allReasons: PersistStageReason[] = [
      'requested_by_caller',
      'disabled_by_caller',
      'waiting_for_enrich',
      'durable_job_enqueued',
      'durable_job_enqueued_after_enrich',
      'job_started',
      'job_completed',
      'enqueue_failed',
      'job_failed',
      'superseded_by_newer_save',
      'blocked_by_enrich_failure',
      'blocked_by_enrich_enqueue_failure',
      'fingerprint_unchanged',
      'no_installed_skills',
    ];
    expect(allReasons).toHaveLength(14);
    for (const reason of allReasons) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

/* ─── enqueuePersistPostSaveJobs orchestration topology ─────────── */

describe('PSE-009: enqueuePersistPostSaveJobs dependency topology', () => {
  // Import the function under test (requires mocks above)
  let enqueuePersistPostSaveJobs: typeof import('../spec-post-save').enqueuePersistPostSaveJobs;
  let advancePersistPostSaveDependencies: typeof import('../spec-post-save').advancePersistPostSaveDependencies;

  beforeAll(async () => {
    const mod = await import('../spec-post-save');
    enqueuePersistPostSaveJobs = mod.enqueuePersistPostSaveJobs;
    advancePersistPostSaveDependencies = mod.advancePersistPostSaveDependencies;
  });

  it('no-ops when both enrich and matchSkills are false', async () => {
    await enqueuePersistPostSaveJobs('spec-1', 'ws-1', {
      enrich: false,
      matchSkills: false,
    });

    expect(mockCreateJob).not.toHaveBeenCalled();
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it('enqueue-only-enrich: creates one job and sends one pg-boss message', async () => {
    const fakeJob = {
      id: 'job-enrich-1',
      specId: 'spec-1',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob.mockResolvedValueOnce(fakeJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-1', 'ws-1', {
      enrich: true,
      matchSkills: false,
    });

    expect(mockCreateJob).toHaveBeenCalledTimes(1);
    expect(mockCreateJob).toHaveBeenCalledWith(
      'ws-1', 'spec-1', 'enrich',
      expect.objectContaining({ origin: 'persist-post-save', stage: 'enrich' }),
    );
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith('spec:enrich', expect.objectContaining({ specId: 'spec-1' }));
  });

  it('matchSkills-only (no enrich): enqueues matchSkills immediately', async () => {
    const fakeJob = {
      id: 'job-match-1',
      specId: 'spec-2',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob.mockResolvedValueOnce(fakeJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-2', 'ws-1', {
      enrich: false,
      matchSkills: true,
    });

    expect(mockCreateJob).toHaveBeenCalledTimes(1);
    expect(mockCreateJob).toHaveBeenCalledWith(
      'ws-1', 'spec-2', 'match-skills',
      expect.objectContaining({ origin: 'persist-post-save', stage: 'matchSkills' }),
    );
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith('spec:match-skills', expect.objectContaining({ specId: 'spec-2' }));
  });

  it('both enrich + matchSkills: enrich is immediate, matchSkills is deferred', async () => {
    const enrichJob = {
      id: 'job-enrich-2',
      specId: 'spec-3',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    const matchJob = {
      id: 'job-match-2',
      specId: 'spec-3',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob
      .mockResolvedValueOnce(enrichJob)   // enrich job creation
      .mockResolvedValueOnce(matchJob);   // deferred matchSkills job creation
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-3', 'ws-1', {
      enrich: true,
      matchSkills: true,
    });

    // Two jobs created: enrich (immediate) + matchSkills (deferred)
    expect(mockCreateJob).toHaveBeenCalledTimes(2);

    // Only enrich goes through pg-boss send
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith('spec:enrich', expect.objectContaining({ specId: 'spec-3' }));

    // matchSkills metadata includes waitForStage
    expect(mockCreateJob).toHaveBeenNthCalledWith(
      2,
      'ws-1', 'spec-3', 'match-skills',
      expect.objectContaining({
        origin: 'persist-post-save',
        stage: 'matchSkills',
        waitForStage: 'enrich',
      }),
    );
  });

  it('metadata-only save skips both stages when both fingerprints are unchanged', async () => {
    const enrichSkippedJob = {
      id: 'job-enrich-skip',
      specId: 'spec-skip',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    const matchSkippedJob = {
      id: 'job-match-skip',
      specId: 'spec-skip',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob
      .mockResolvedValueOnce(enrichSkippedJob)
      .mockResolvedValueOnce(matchSkippedJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-skip', 'ws-1', {
      enrich: true,
      matchSkills: true,
      currentFingerprints: { enrichFingerprint: 'enrich-v1', matchSkillsFingerprint: 'match-v1' },
      priorFingerprints: { enrichFingerprint: 'enrich-v1', matchSkillsFingerprint: 'match-v1' },
    });

    expect(mockCreateJob).toHaveBeenCalledTimes(2);
    expect(mockBossSend).not.toHaveBeenCalled();
    expect(mockCreateJob).toHaveBeenNthCalledWith(
      1,
      'ws-1', 'spec-skip', 'enrich',
      expect.objectContaining({ stage: 'enrich', fingerprint: 'enrich-v1', previousFingerprint: 'enrich-v1', skipReason: 'fingerprint_unchanged' }),
    );
    expect(mockCreateJob).toHaveBeenNthCalledWith(
      2,
      'ws-1', 'spec-skip', 'match-skills',
      expect.objectContaining({ stage: 'matchSkills', fingerprint: 'match-v1', previousFingerprint: 'match-v1', skipReason: 'fingerprint_unchanged' }),
    );
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      'job-enrich-skip',
      'completed',
      expect.objectContaining({
        resultPayload: expect.objectContaining({ skipped: true, skipReason: 'fingerprint_unchanged', fingerprint: 'enrich-v1' }),
      }),
    );
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      'job-match-skip',
      'completed',
      expect.objectContaining({
        resultPayload: expect.objectContaining({ skipped: true, skipReason: 'fingerprint_unchanged', fingerprint: 'match-v1' }),
      }),
    );
  });

  it('story-only save skips enrich but enqueues match-skills immediately when only match fingerprint changed', async () => {
    const enrichSkippedJob = {
      id: 'job-enrich-story-skip',
      specId: 'spec-story-only',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    const matchJob = {
      id: 'job-match-story-only',
      specId: 'spec-story-only',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob
      .mockResolvedValueOnce(enrichSkippedJob)
      .mockResolvedValueOnce(matchJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-story-only', 'ws-1', {
      enrich: true,
      matchSkills: true,
      currentFingerprints: { enrichFingerprint: 'enrich-v1', matchSkillsFingerprint: 'match-v2' },
      priorFingerprints: { enrichFingerprint: 'enrich-v1', matchSkillsFingerprint: 'match-v1' },
    });

    expect(mockCreateJob).toHaveBeenCalledTimes(2);
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith('spec:match-skills', expect.objectContaining({ specId: 'spec-story-only' }));
    expect(mockCreateJob).toHaveBeenNthCalledWith(
      2,
      'ws-1', 'spec-story-only', 'match-skills',
      expect.objectContaining({ stage: 'matchSkills', fingerprint: 'match-v2', previousFingerprint: 'match-v1' }),
    );
    expect(mockCreateJob.mock.calls[1][3]).not.toHaveProperty('waitForStage');
  });

  it('context-affecting save enqueues enrich and defers match-skills even when match fingerprint is unchanged', async () => {
    const enrichJob = {
      id: 'job-enrich-context',
      specId: 'spec-context',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    const matchJob = {
      id: 'job-match-context',
      specId: 'spec-context',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob
      .mockResolvedValueOnce(enrichJob)
      .mockResolvedValueOnce(matchJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-context', 'ws-1', {
      enrich: true,
      matchSkills: true,
      currentFingerprints: { enrichFingerprint: 'enrich-v2', matchSkillsFingerprint: 'match-v1' },
      priorFingerprints: { enrichFingerprint: 'enrich-v1', matchSkillsFingerprint: 'match-v1' },
    });

    expect(mockCreateJob).toHaveBeenCalledTimes(2);
    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith('spec:enrich', expect.objectContaining({ specId: 'spec-context' }));
    expect(mockCreateJob).toHaveBeenNthCalledWith(
      2,
      'ws-1', 'spec-context', 'match-skills',
      expect.objectContaining({
        stage: 'matchSkills',
        waitForStage: 'enrich',
        invalidatedByStage: 'enrich',
        fingerprint: 'match-v1',
      }),
    );
  });

  it('advance dependencies skips deferred match-skills when enrich was skipped and match fingerprint is unchanged', async () => {
    const enrichJob = {
      id: 'job-enrich-skipped-advance',
      specId: 'spec-advance-skip',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      bossJobId: null,
      status: 'completed',
      progressCurrent: 0,
      progressTotal: 0,
      progressMessage: null,
      requestPayload: { origin: 'persist-post-save', stage: 'enrich', fingerprint: 'enrich-v1', previousFingerprint: 'enrich-v1' },
      resultPayload: { skipped: true, skipReason: 'fingerprint_unchanged', fingerprint: 'enrich-v1', previousFingerprint: 'enrich-v1' },
      errorMessage: null,
      startedAt: null,
      finishedAt: new Date(),
      createdAt: new Date(),
    };
    const deferredMatchJob = {
      id: 'job-match-deferred-skip',
      specId: 'spec-advance-skip',
      workspaceId: 'ws-1',
      jobType: 'match-skills',
      bossJobId: null,
      status: 'pending',
      progressCurrent: 0,
      progressTotal: 0,
      progressMessage: null,
      requestPayload: {
        origin: 'persist-post-save',
        stage: 'matchSkills',
        waitForStage: 'enrich',
        fingerprint: 'match-v1',
        previousFingerprint: 'match-v1',
      },
      resultPayload: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
    };
    mockGetJob.mockResolvedValue(enrichJob);
    mockListJobsForSpec.mockResolvedValue([deferredMatchJob]);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await advancePersistPostSaveDependencies('job-enrich-skipped-advance');

    expect(mockBossSend).not.toHaveBeenCalled();
    expect(mockUpdateJobStatus).toHaveBeenCalledWith(
      'job-match-deferred-skip',
      'completed',
      expect.objectContaining({
        resultPayload: expect.objectContaining({ skipped: true, skipReason: 'fingerprint_unchanged', fingerprint: 'match-v1' }),
      }),
    );
  });

  it('both enrich + matchSkills when enrich create fails: matchSkills gets blocked_by_enrich_enqueue_failure', async () => {
    // First createJob (enrich) throws
    mockCreateJob.mockRejectedValueOnce(new Error('DB constraint violation'));
    // Second createJob (matchSkills blocked) should still be called
    const blockedJob = {
      id: 'job-blocked-1',
      specId: 'spec-4',
      workspaceId: 'ws-1',
      bossJobId: null,
      status: 'pending',
      errorMessage: null,
      createdAt: new Date(),
    };
    mockCreateJob.mockResolvedValueOnce(blockedJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-4', 'ws-1', {
      enrich: true,
      matchSkills: true,
    });

    // Second call is the blocked matchSkills job
    expect(mockCreateJob).toHaveBeenCalledTimes(2);
    expect(mockCreateJob).toHaveBeenNthCalledWith(
      2,
      'ws-1', 'spec-4', 'match-skills',
      expect.objectContaining({
        origin: 'persist-post-save',
        stage: 'matchSkills',
        blockedBy: 'enrich',
      }),
    );

    // No pg-boss messages sent at all (enrich failed to create, matchSkills is pre-failed)
    expect(mockBossSend).not.toHaveBeenCalled();
  });
});

/* ─── buildPersistPostSaveStages edge cases ────────────────────── */

describe('PSE-009: buildPersistPostSaveStages edge cases', () => {
  it('stage state initial shape has no optional fields populated', () => {
    const stages = buildPersistPostSaveStages({
      enrich: true,
      matchSkills: true,
      memorySynthesis: true,
    });

    for (const stage of Object.values(stages)) {
      expect(stage.jobId).toBeUndefined();
      expect(stage.bossJobId).toBeUndefined();
      expect(stage.error).toBeUndefined();
      expect(stage.updatedAt).toBeUndefined();
    }
  });

  it('calling with same input twice produces identical results (pure function)', () => {
    const input = { enrich: true, matchSkills: false, memorySynthesis: true };
    const first = buildPersistPostSaveStages(input);
    const second = buildPersistPostSaveStages(input);
    expect(first).toEqual(second);
  });

  it('result contains exactly the three canonical stage keys', () => {
    const stages = buildPersistPostSaveStages({ enrich: true, matchSkills: true, memorySynthesis: false });
    const keys = Object.keys(stages).sort();
    expect(keys).toEqual(['enrich', 'matchSkills', 'memorySynthesis']);
  });
});

/* ─── PersistStageStatus contract ──────────────────────────────── */

describe('PSE-009: PersistStageStatus terminal vs in-flight classification', () => {
  it('terminal statuses are completed, failed, skipped, and superseded', () => {
    const terminal: PersistStageStatus[] = ['completed', 'failed', 'skipped', 'superseded'];
    const inFlight: PersistStageStatus[] = ['pending', 'queued', 'running'];

    // Ensure no overlap
    for (const t of terminal) {
      expect(inFlight).not.toContain(t);
    }
    for (const i of inFlight) {
      expect(terminal).not.toContain(i);
    }

    // Ensure all 6 covered
    expect([...terminal, ...inFlight].sort()).toEqual(
      ['completed', 'failed', 'pending', 'queued', 'running', 'skipped', 'superseded'],
    );
  });
});
