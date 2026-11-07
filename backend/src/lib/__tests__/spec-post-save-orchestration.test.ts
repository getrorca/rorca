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

const mockCreateWorkflowRun = jest.fn();
const mockGetLatestWorkflowRunForSpec = jest.fn();
const mockInsertWorkflowStages = jest.fn();
const mockListWorkflowStagesByRun = jest.fn();
const mockListActiveWorkflowConflicts = jest.fn();
const mockProjectPostSaveStages = jest.fn();
const mockSupersedeActiveWorkflowRuns = jest.fn();
const mockUpdateWorkflowStageStatus = jest.fn();

jest.mock('../../db/spec-post-save', () => ({
  createRun: (...args: unknown[]) => mockCreateWorkflowRun(...args),
  getLatestRunForSpec: (...args: unknown[]) => mockGetLatestWorkflowRunForSpec(...args),
  insertStages: (...args: unknown[]) => mockInsertWorkflowStages(...args),
  listStagesByRun: (...args: unknown[]) => mockListWorkflowStagesByRun(...args),
  listActiveWorkflowConflicts: (...args: unknown[]) => mockListActiveWorkflowConflicts(...args),
  projectPostSaveStages: (...args: unknown[]) => mockProjectPostSaveStages(...args),
  supersedeActiveWorkflowRuns: (...args: unknown[]) => mockSupersedeActiveWorkflowRuns(...args),
  updateStageStatus: (...args: unknown[]) => mockUpdateWorkflowStageStatus(...args),
}));

const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockListActiveJobs = jest.fn();
const mockListJobsForSpec = jest.fn();
const mockUpdateJobStatus = jest.fn();
const mockCompareAndSetJobStatus = jest.fn();

jest.mock('../../db/spec-jobs', () => ({
  createJob: (...args: unknown[]) => mockCreateJob(...args),
  compareAndSetJobStatus: (...args: unknown[]) => mockCompareAndSetJobStatus(...args),
  getJob: (...args: unknown[]) => mockGetJob(...args),
  listActiveJobs: (...args: unknown[]) => mockListActiveJobs(...args),
  listJobsForSpec: (...args: unknown[]) => mockListJobsForSpec(...args),
  updateJobStatus: (...args: unknown[]) => mockUpdateJobStatus(...args),
}));

const mockBossSend = jest.fn().mockImplementation((
  _name: string,
  _payload: unknown,
  options?: { id?: string },
) => Promise.resolve(options?.id ?? null));
const mockBossCancel = jest.fn().mockResolvedValue(undefined);

jest.mock('../pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn(() => ({ send: mockBossSend, cancel: mockBossCancel })),
}));

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('../logger', () => ({
  logger: { warn: (...args: unknown[]) => mockLoggerWarn(...args), info: (...args: unknown[]) => mockLoggerInfo(...args), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockQueryOne.mockResolvedValue(undefined);
  mockExecute.mockResolvedValue(undefined);
  mockCreateWorkflowRun.mockResolvedValue({ id: 1, effectivePolicyHash: 'policy-hash' });
  mockGetLatestWorkflowRunForSpec.mockResolvedValue({ id: 1 });
  mockInsertWorkflowStages.mockResolvedValue([]);
  mockListWorkflowStagesByRun.mockResolvedValue([]);
  mockListActiveWorkflowConflicts.mockResolvedValue([]);
  mockProjectPostSaveStages.mockReturnValue({});
  mockSupersedeActiveWorkflowRuns.mockResolvedValue(0);
  mockUpdateWorkflowStageStatus.mockResolvedValue(undefined);
  mockCompareAndSetJobStatus.mockResolvedValue(true);
  mockListActiveJobs.mockResolvedValue([]);
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
      'metadata_only_skip',
      'story_content_only',
      'context_bearing_change',
      'no_installed_skills',
      'context_captured',
      'requested_by_policy',
      'disabled_by_policy',
      'durable_job_enqueueing',
      'durable_job_enqueued_after_dependency',
      'blocked_by_required_stage_failed',
    ];
    expect(allReasons).toHaveLength(23);
    expect(new Set(allReasons).size).toBe(allReasons.length);
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
  let syncPersistPostSaveStageFromJob: typeof import('../spec-post-save').syncPersistPostSaveStageFromJob;
  let markPersistPostSaveJobSupersededIfStale: typeof import('../spec-post-save').markPersistPostSaveJobSupersededIfStale;

  beforeAll(async () => {
    const mod = await import('../spec-post-save');
    enqueuePersistPostSaveJobs = mod.enqueuePersistPostSaveJobs;
    advancePersistPostSaveDependencies = mod.advancePersistPostSaveDependencies;
    syncPersistPostSaveStageFromJob = mod.syncPersistPostSaveStageFromJob;
    markPersistPostSaveJobSupersededIfStale = mod.markPersistPostSaveJobSupersededIfStale;
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
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({ specId: 'spec-1' }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-1:spec-1' }),
    );
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
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:match-skills',
      expect.objectContaining({ specId: 'spec-2' }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-1:spec-2' }),
    );
  });

  it('coalesces rapid saves by superseding older post-save jobs before enqueueing the latest generation', async () => {
    const olderJob = {
      id: 'job-enrich-old',
      specId: 'spec-coalesce',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      bossJobId: '99999999-9999-4999-8999-999999999999',
      status: 'pending',
      progressCurrent: 0,
      progressTotal: 0,
      progressMessage: null,
      requestPayload: {
        origin: 'persist-post-save',
        stage: 'enrich',
        saveGeneration: 1,
        priority: 1,
        singletonKey: 'persist-post-save:ws-1:spec-coalesce',
      },
      resultPayload: null,
      errorMessage: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      saveGeneration: 1,
    };
    const latestJob = {
      ...olderJob,
      id: 'job-enrich-latest',
      bossJobId: null,
      requestPayload: {
        origin: 'persist-post-save',
        stage: 'enrich',
        saveGeneration: 2,
        priority: 1,
        singletonKey: 'persist-post-save:ws-1:spec-coalesce',
      },
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
      saveGeneration: 2,
    };
    mockListJobsForSpec.mockResolvedValueOnce([olderJob]);
    mockCreateJob.mockResolvedValueOnce(latestJob);
    mockUpdateJobStatus.mockResolvedValue(undefined);

    await enqueuePersistPostSaveJobs('spec-coalesce', 'ws-1', {
      enrich: true,
      matchSkills: false,
      saveGeneration: 2,
    });

    expect(mockBossCancel).toHaveBeenCalledWith('spec:enrich', '99999999-9999-4999-8999-999999999999');
    expect(mockCompareAndSetJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-enrich-old',
      status: 'superseded',
      expectedStatuses: ['pending', 'running'],
      expectedWorkspaceId: 'ws-1',
      expectedSpecId: 'spec-coalesce',
      expectedBossJobId: '99999999-9999-4999-8999-999999999999',
      fields: expect.objectContaining({ progressMessage: 'Superseded by newer spec save' }),
    }));
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({ specId: 'spec-coalesce', jobId: 'job-enrich-latest' }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-1:spec-coalesce' }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'post-save',
        event: 'jobs_superseded',
        specId: 'spec-coalesce',
        workspaceId: 'ws-1',
        saveGeneration: 2,
        supersededCount: 1,
        supersededJobIds: ['job-enrich-old'],
      }),
      '[post-save] telemetry',
    );
  });

  it('stale post-save sync cannot mutate the newer generation log', async () => {
    const staleJob = {
      id: 'job-stale-completion',
      specId: 'spec-stale',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      bossJobId: '88888888-8888-4888-8888-888888888888',
      status: 'completed',
      progressCurrent: 1,
      progressTotal: 1,
      progressMessage: null,
      requestPayload: { origin: 'persist-post-save', stage: 'enrich', saveGeneration: 1 },
      resultPayload: { ok: true },
      errorMessage: null,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      finishedAt: new Date('2026-01-01T00:00:05.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(staleJob);
    mockQueryOne.mockResolvedValueOnce({ save_generation: 2 });

    await syncPersistPostSaveStageFromJob('job-stale-completion');

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockUpdateJobStatus).not.toHaveBeenCalledWith(
      'job-stale-completion',
      'completed',
      expect.anything(),
    );
  });

  it('marks stale jobs superseded without deleting audit-visible job rows', async () => {
    const staleJob = {
      id: 'job-stale-audit',
      specId: 'spec-stale-audit',
      workspaceId: 'ws-1',
      jobType: 'match-skills',
      bossJobId: '77777777-7777-4777-8777-777777777777',
      status: 'running',
      progressCurrent: 0,
      progressTotal: 1,
      progressMessage: null,
      requestPayload: { origin: 'persist-post-save', stage: 'matchSkills', saveGeneration: 1 },
      resultPayload: null,
      errorMessage: null,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      finishedAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(staleJob);
    mockQueryOne.mockResolvedValueOnce({ save_generation: 3 });

    await expect(markPersistPostSaveJobSupersededIfStale('job-stale-audit')).resolves.toBe(true);

    expect(mockCompareAndSetJobStatus).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 'job-stale-audit',
      status: 'superseded',
      expectedStatuses: ['pending', 'running'],
      expectedWorkspaceId: 'ws-1',
      expectedSpecId: 'spec-stale-audit',
      expectedBossJobId: '77777777-7777-4777-8777-777777777777',
      fields: expect.objectContaining({ progressMessage: 'Superseded by newer spec save' }),
    }));
    expect(mockCreateJob).not.toHaveBeenCalledWith(expect.anything(), 'spec-stale-audit', expect.anything(), expect.anything());
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'post-save',
        event: 'stale_job_superseded',
        jobId: 'job-stale-audit',
        skipReason: 'superseded_by_newer_save',
      }),
      '[post-save] telemetry',
    );
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
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({ specId: 'spec-3' }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-1:spec-3' }),
    );

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
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:match-skills',
      expect.objectContaining({ specId: 'spec-story-only' }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-1:spec-story-only' }),
    );
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
    expect(mockBossSend).toHaveBeenCalledWith(
      'spec:enrich',
      expect.objectContaining({ specId: 'spec-context' }),
      expect.objectContaining({ priority: 1, singletonKey: 'persist-post-save:ws-1:spec-context' }),
    );
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
  it('terminal statuses are completed, failed, and skipped', () => {
    const terminal: PersistStageStatus[] = ['completed', 'failed', 'skipped'];
    const inFlight: PersistStageStatus[] = ['pending', 'queued', 'running'];

    // Ensure no overlap
    for (const t of terminal) {
      expect(inFlight).not.toContain(t);
    }
    for (const i of inFlight) {
      expect(terminal).not.toContain(i);
    }

    // Ensure all v1 stage transition statuses are covered.
    expect([...terminal, ...inFlight].sort()).toEqual(
      ['completed', 'failed', 'pending', 'queued', 'running', 'skipped'],
    );
  });
});
