/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const events: string[] = [];
const mockQueryOne = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

const mockCreateRun = jest.fn();
const mockInsertStages = jest.fn();
const mockListStagesByRun = jest.fn();
const mockListActiveWorkflowConflicts = jest.fn();
const mockSupersedeActiveWorkflowRuns = jest.fn();
const mockUpdateStageStatus = jest.fn();
const mockGetLatestRunForSpec = jest.fn();

jest.mock('../../db/spec-post-save', () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  getLatestRunForSpec: (...args: unknown[]) => mockGetLatestRunForSpec(...args),
  insertStages: (...args: unknown[]) => mockInsertStages(...args),
  listActiveWorkflowConflicts: (...args: unknown[]) => mockListActiveWorkflowConflicts(...args),
  listStagesByRun: (...args: unknown[]) => mockListStagesByRun(...args),
  supersedeActiveWorkflowRuns: (...args: unknown[]) => mockSupersedeActiveWorkflowRuns(...args),
  updateStageStatus: (...args: unknown[]) => mockUpdateStageStatus(...args),
}));

const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateJobStatus = jest.fn();

jest.mock('../../db/spec-jobs', () => ({
  createJob: (...args: unknown[]) => mockCreateJob(...args),
  getJob: (...args: unknown[]) => mockGetJob(...args),
  updateJobStatus: (...args: unknown[]) => mockUpdateJobStatus(...args),
}));

const mockBossSend = jest.fn();

jest.mock('../pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn(() => ({ send: (...args: unknown[]) => mockBossSend(...args) })),
}));

jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const bestEffortPolicy = {
  version: 'v1' as const,
  presetId: 'best_effort' as const,
  context: 'capture' as const,
  enrich: 'enqueue' as const,
  skills: 'match' as const,
  memory: 'synthesize' as const,
  onFailure: 'continue' as const,
};

function stage(stageKey: 'context' | 'enrich' | 'matchSkills' | 'memorySynthesis', status: string, requested = true) {
  return {
    id: stageKey.length,
    runId: 7,
    stageKey,
    requested,
    status,
    reason: status === 'skipped' ? 'disabled_by_policy' : 'requested_by_policy',
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
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    finishedAt: null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  mockCreateRun.mockImplementation(async () => ({ id: 7, saveGeneration: 1, effectivePolicyHash: 'hash' }));
  mockInsertStages.mockImplementation(async () => { events.push('insertStages'); return []; });
  mockListActiveWorkflowConflicts.mockResolvedValue([]);
  mockSupersedeActiveWorkflowRuns.mockResolvedValue(0);
  mockGetLatestRunForSpec.mockResolvedValue({ id: 7, saveGeneration: 1, effectivePolicyHash: 'hash' });
  mockCreateJob.mockImplementation(async (_workspaceId, specId, jobType, requestPayload) => ({
    id: `job-${jobType}`,
    specId,
    workspaceId: 'ws-1',
    jobType,
    status: 'pending',
    bossJobId: null,
    requestPayload,
    resultPayload: null,
    errorMessage: null,
    createdAt: new Date(),
    saveGeneration: 1,
  }));
  mockUpdateJobStatus.mockResolvedValue(undefined);
  mockUpdateStageStatus.mockImplementation(async (input) => {
    if (input.allowedCurrentStatuses?.includes('pending')) return { ...stage(input.stageKey, input.status), ...input };
    return { ...stage(input.stageKey, input.status), ...input };
  });
  mockBossSend.mockImplementation(async () => { events.push('bossSend'); return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; });
});

describe('spec-post-save-workflow v1 orchestrator', () => {
  it('materializes all stages and v1 dependency edges before queueing work', async () => {
    mockListStagesByRun
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'pending'),
        stage('matchSkills', 'pending'),
        stage('memorySynthesis', 'pending'),
      ])
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'queued'),
        stage('matchSkills', 'pending'),
        stage('memorySynthesis', 'pending'),
      ]);

    const { startSpecPostSaveWorkflow } = await import('../spec-post-save-workflow');
    await startSpecPostSaveWorkflow({ specId: 'spec-1', workspaceId: 'ws-1', effectivePolicy: bestEffortPolicy, saveGeneration: 1 });

    expect(mockInsertStages).toHaveBeenCalledWith(
      7,
      expect.arrayContaining([
        expect.objectContaining({ stageKey: 'context', status: 'completed' }),
        expect.objectContaining({ stageKey: 'enrich', status: 'pending' }),
        expect.objectContaining({ stageKey: 'matchSkills', status: 'pending' }),
        expect.objectContaining({ stageKey: 'memorySynthesis', status: 'pending' }),
      ]),
      [
        { stageKey: 'enrich', dependsOnStageKey: 'context' },
        { stageKey: 'matchSkills', dependsOnStageKey: 'enrich' },
        { stageKey: 'memorySynthesis', dependsOnStageKey: 'matchSkills' },
      ],
    );
    expect(events).toEqual(['insertStages', 'bossSend']);
  });

  it('lets an explicitly skipped enrich stage satisfy match-skills when policy requests skills', async () => {
    const policy = { ...bestEffortPolicy, enrich: 'skip' as const, memory: 'skip' as const };
    mockListStagesByRun
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'skipped', false),
        stage('matchSkills', 'pending'),
        stage('memorySynthesis', 'skipped', false),
      ])
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'skipped', false),
        stage('matchSkills', 'queued'),
        stage('memorySynthesis', 'skipped', false),
      ]);

    const { startSpecPostSaveWorkflow } = await import('../spec-post-save-workflow');
    await startSpecPostSaveWorkflow({ specId: 'spec-2', workspaceId: 'ws-1', effectivePolicy: policy, saveGeneration: 1 });

    expect(mockCreateJob).toHaveBeenCalledWith(
      'ws-1',
      'spec-2',
      'match-skills',
      expect.objectContaining({ stage: 'matchSkills', workflow: 'spec-post-save-v1' }),
    );
    expect(mockBossSend).toHaveBeenCalledWith('spec:match-skills', expect.objectContaining({ specId: 'spec-2' }), expect.any(Object));
  });

  it('does not duplicate-enqueue dependents that durable stage state already released', async () => {
    const completedEnrichJob = {
      id: 'job-enrich',
      specId: 'spec-3',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'completed',
      bossJobId: 'boss-1',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'enrich', saveGeneration: 1, priority: 1, singletonKey: 'persist-post-save:ws-1:spec-3' },
      resultPayload: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(completedEnrichJob);
    mockQueryOne.mockResolvedValue({ save_generation: 1 });
    mockListStagesByRun.mockResolvedValue([
      stage('context', 'completed'),
      stage('enrich', 'completed'),
      stage('matchSkills', 'queued'),
      stage('memorySynthesis', 'pending'),
    ]);

    const { advanceSpecPostSaveWorkflowDependencies } = await import('../spec-post-save-workflow');
    await advanceSpecPostSaveWorkflowDependencies('job-enrich');

    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it('blocks downstream pending stages with a durable reason when a required dependency fails', async () => {
    const failedEnrichJob = {
      id: 'job-enrich-failed',
      specId: 'spec-4',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'failed',
      bossJobId: 'boss-1',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'enrich', saveGeneration: 1, priority: 1, singletonKey: 'persist-post-save:ws-1:spec-4' },
      resultPayload: null,
      errorMessage: 'enrich failed',
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(failedEnrichJob);
    mockQueryOne.mockResolvedValue({ save_generation: 1 });
    mockListStagesByRun.mockResolvedValue([
      stage('context', 'completed'),
      stage('enrich', 'failed'),
      stage('matchSkills', 'pending'),
      stage('memorySynthesis', 'pending'),
    ]);

    const { advanceSpecPostSaveWorkflowDependencies } = await import('../spec-post-save-workflow');
    await advanceSpecPostSaveWorkflowDependencies('job-enrich-failed');

    expect(mockUpdateStageStatus).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: 'matchSkills',
      status: 'failed',
      reason: 'blocked_by_required_stage_failed',
      allowedCurrentStatuses: ['pending'],
    }));
    expect(mockBossSend).not.toHaveBeenCalled();
  });
});
