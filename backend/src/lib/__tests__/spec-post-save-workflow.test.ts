/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export {};
const events: string[] = [];
const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const createdJobs = new Map<string, any>();
const mockTransactionQuery = jest.fn(async (sql: string, params: any[] = []) => {
  if (sql.includes('SELECT id FROM spec_post_save_workflow_stages')) return { rows: [{ id: String(params[1]).length }], rowCount: 1 };
  if (sql.includes('SELECT id FROM spec_post_save_workflow_runs')) return { rows: [{ id: params[0] }], rowCount: 1 };
  if (sql.includes('INSERT INTO spec_jobs')) {
    const metadata = JSON.parse(params[4]);
    const created = await mockCreateJob(params[1], params[2], params[3], metadata);
    createdJobs.set(params[0], { ...created, id: params[0], bossJobId: params[6], transportSchema: params[7], requestPayload: metadata });
    return { rows: [{ id: params[0] }], rowCount: 1 };
  }
  if (sql.includes('UPDATE spec_post_save_workflow_stages')) {
    const updated = await mockUpdateStageStatus({ runId: params[0], stageKey: params[1], status: 'queued', reason: 'durable_job_enqueueing',
      allowedCurrentStatuses: ['pending'], jobId: params[2], bossJobId: params[3], queueName: params[4], transportSchema: params[5] });
    return { rows: [], rowCount: updated ? 1 : 0 };
  }
  return { rows: [], rowCount: 1 };
});

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  transaction: (operation: (client: { query: typeof mockTransactionQuery }) => Promise<unknown>) => operation({ query: mockTransactionQuery }),
  withPgAdvisoryLock: (_key: string, operation: () => Promise<unknown>) => operation(),
}));

const mockCreateRun = jest.fn();
const mockInsertStages = jest.fn();
const mockListStagesByRun = jest.fn();
const mockListActiveWorkflowConflicts = jest.fn();
const mockSupersedeActiveWorkflowRuns = jest.fn();
const mockUpdateStageStatus = jest.fn();
const mockGetLatestRunForSpec = jest.fn();
const mockGetRunById = jest.fn();
const mockHashEffectivePolicy = jest.fn((_policy: unknown) => '8'.repeat(64));

jest.mock('../../db/spec-post-save', () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  getLatestRunForSpec: (...args: unknown[]) => mockGetLatestRunForSpec(...args),
  getRunById: (...args: unknown[]) => mockGetRunById(...args),
  hashEffectivePolicy: (policy: unknown) => mockHashEffectivePolicy(policy),
  insertStages: (...args: unknown[]) => mockInsertStages(...args),
  listActiveWorkflowConflicts: (...args: unknown[]) => mockListActiveWorkflowConflicts(...args),
  listStagesByRun: (...args: unknown[]) => mockListStagesByRun(...args),
  supersedeActiveWorkflowRuns: (...args: unknown[]) => mockSupersedeActiveWorkflowRuns(...args),
  updateStageStatus: (...args: unknown[]) => mockUpdateStageStatus(...args),
}));

const mockCreateJob = jest.fn();
const mockGetJob = jest.fn();
const mockUpdateJobStatus = jest.fn();

function normalizeWorkflowJob(job: any) {
  if (!job?.requestPayload || job.requestPayload.workflow !== 'spec-post-save-v1') return job;
  const stageKey = job.requestPayload.stage as 'enrich'|'matchSkills'|'memorySynthesis';
  const defaults = { enrich: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'spec:enrich'],
    matchSkills: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'spec:match-skills'],
    memorySynthesis: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'spec:memory-synthesis'] } as const;
  const [defaultBossId, queueName] = defaults[stageKey];
  const bossJobId = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(job.bossJobId ?? '') ? job.bossJobId : defaultBossId;
  return { ...job, bossJobId, transportSchema: job.transportSchema ?? 'pgboss',
    requestPayload: { ...job.requestPayload, bossJobId, queueName, transportSchema: job.transportSchema ?? 'pgboss' } };
}

jest.mock('../../db/spec-jobs', () => ({
  createJob: (...args: unknown[]) => mockCreateJob(...args),
  getJob: async (...args: unknown[]) => normalizeWorkflowJob(createdJobs.get(String(args[0])) ?? await mockGetJob(...args)),
  compareAndSetJobStatus: async (...args: unknown[]) => { await mockUpdateJobStatus(...args); return normalizeWorkflowJob(createdJobs.get(String((args[0] as any).jobId))) ?? {}; },
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

const mockCompileSpecPlan = jest.fn();
jest.mock('../ssdlc-plan-service', () => ({
  compileSpecPlan: (...args: unknown[]) => mockCompileSpecPlan(...args),
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
    jobId: null as string | null,
    bossJobId: null as string | null,
    queueName: null,
    transportSchema: null as string | null,
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

function ownedStage(stageKey: 'enrich'|'matchSkills'|'memorySynthesis', status: string, job: { id: string; bossJobId: string | null; requestPayload?: unknown }) {
  const normalized = normalizeWorkflowJob(job);
  return { ...stage(stageKey,status),jobId:normalized.id,bossJobId:normalized.bossJobId,
    queueName: normalized.requestPayload.queueName, transportSchema:'pgboss' };
}

function installDurableStageState(initial: ReturnType<typeof stage>[]) {
  const durableStages = new Map(initial.map((current) => [current.stageKey, current] as const));
  const stageOrder = ['context', 'enrich', 'matchSkills', 'memorySynthesis'] as const;
  let reads = 0;

  mockListStagesByRun.mockImplementation(async () => {
    reads += 1;
    if (reads > 16) {
      throw new Error(`durable stage fixture did not converge: ${stageOrder.map((stageKey) => `${stageKey}:${durableStages.get(stageKey)?.status}`).join(',')}`);
    }
    return stageOrder
      .map((stageKey) => durableStages.get(stageKey))
      .filter((current) => current !== undefined);
  });
  mockUpdateStageStatus.mockImplementation(async (input) => {
    const current = durableStages.get(input.stageKey);
    if (!current) return null;
    if (input.allowedCurrentStatuses && !input.allowedCurrentStatuses.includes(current.status)) return null;
    if (input.expectedJobId !== undefined && input.expectedJobId !== current.jobId) return null;
    if (input.expectedBossJobId !== undefined && input.expectedBossJobId !== current.bossJobId) return null;
    if (input.expectedTransportSchema !== undefined && input.expectedTransportSchema !== current.transportSchema) return null;
    const updated = {
      ...current,
      status: input.status,
      reason: input.reason ?? current.reason,
      jobId: input.jobId ?? current.jobId,
      bossJobId: input.bossJobId ?? current.bossJobId,
      transportSchema: input.transportSchema ?? current.transportSchema,
      errorMessage: input.errorMessage ?? current.errorMessage,
      details: input.details ?? current.details,
      updatedAt: new Date(),
    };
    durableStages.set(input.stageKey, updated);
    return updated;
  });

  return durableStages;
}

beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  createdJobs.clear();
  mockCreateRun.mockImplementation(async () => ({ id: 7, saveGeneration: 1, effectivePolicyHash: '8'.repeat(64) }));
  mockInsertStages.mockImplementation(async () => { events.push('insertStages'); return []; });
  mockListActiveWorkflowConflicts.mockResolvedValue([]);
  mockSupersedeActiveWorkflowRuns.mockResolvedValue(0);
  mockGetLatestRunForSpec.mockResolvedValue({ id: 7, saveGeneration: 1, effectivePolicyHash: '8'.repeat(64) });
  mockGetRunById.mockImplementation(async (_runId: number, binding?: { workspaceId: string; specId: string }) => ({
    id: 7,
    workspaceId: binding?.workspaceId ?? 'ws-1',
    specId: binding?.specId ?? 'spec-unused',
    generationLogId: 11,
    saveGeneration: 1,
    effectivePolicyHash: '8'.repeat(64),
    effectivePolicy: bestEffortPolicy,
  }));
  mockCreateJob.mockImplementation(async (_workspaceId, specId, jobType, requestPayload) => ({
    id: `job-${jobType}`,
    specId,
    workspaceId: 'ws-1',
    jobType,
    status: 'pending',
    bossJobId: null,
    transportSchema: requestPayload.transportSchema ?? null,
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
  mockBossSend.mockImplementation(async (_queue, _payload, options) => { events.push('bossSend'); return options.id; });
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

  it('gives distinct explicit repair attempts fresh durable workflow identities', async () => {
    mockListStagesByRun.mockResolvedValue([
      stage('context', 'completed'),
      stage('enrich', 'completed'),
      stage('matchSkills', 'completed'),
      stage('memorySynthesis', 'completed'),
    ]);

    const { startSpecPostSaveWorkflow } = await import('../spec-post-save-workflow');
    const shared = {
      specId: 'spec-repair',
      workspaceId: 'ws-1',
      effectivePolicy: bestEffortPolicy,
      saveGeneration: 9,
    };
    await startSpecPostSaveWorkflow({ ...shared, workflowAttemptId: 'repair-a' });
    await startSpecPostSaveWorkflow({ ...shared, workflowAttemptId: 'repair-b' });

    expect(mockCreateRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ idempotencyKey: 'spec-post-save-v1:ws-1:spec-repair:9:attempt:repair-a' }),
    );
    expect(mockCreateRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ idempotencyKey: 'spec-post-save-v1:ws-1:spec-repair:9:attempt:repair-b' }),
    );
  });

  it('re-materializes missing stages on an idempotent retry before queueing work', async () => {
    mockListActiveWorkflowConflicts.mockResolvedValueOnce([
      { id: 7, idempotencyKey: 'spec-post-save-v1:ws-1:spec-retry:1', saveGeneration: 1, effectivePolicyHash: '8'.repeat(64) },
    ]);
    mockListStagesByRun
      .mockResolvedValueOnce([])
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
    await startSpecPostSaveWorkflow({ specId: 'spec-retry', workspaceId: 'ws-1', effectivePolicy: bestEffortPolicy, saveGeneration: 1 });

    expect(mockCreateRun).not.toHaveBeenCalled();
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

  it('guards the post-send queued write so a worker race cannot regress stage state', async () => {
    mockListStagesByRun
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'pending'),
        stage('matchSkills', 'pending'),
        stage('memorySynthesis', 'pending'),
      ])
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'running'),
        stage('matchSkills', 'pending'),
        stage('memorySynthesis', 'pending'),
      ]);
    mockUpdateStageStatus.mockImplementation(async (input) => {
      if (input.stageKey === 'enrich' && input.reason === 'durable_job_enqueued_after_dependency') {
        return null;
      }
      return { ...stage(input.stageKey, input.status), ...input };
    });

    const { startSpecPostSaveWorkflow } = await import('../spec-post-save-workflow');
    await startSpecPostSaveWorkflow({ specId: 'spec-race', workspaceId: 'ws-1', effectivePolicy: bestEffortPolicy, saveGeneration: 1 });

    expect(mockUpdateStageStatus).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: 'enrich',
      status: 'queued',
      reason: 'durable_job_enqueued_after_dependency',
      allowedCurrentStatuses: ['queued'],
    }));
    expect(mockBossSend).toHaveBeenCalledTimes(1);
  });

  it('queues memory synthesis only after match-skills durably completes', async () => {
    const completedMatchSkillsJob = {
      id: 'job-match-skills',
      specId: 'spec-2b',
      workspaceId: 'ws-1',
      jobType: 'match-skills',
      status: 'completed',
      bossJobId: 'boss-match', transportSchema: 'pgboss',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'matchSkills', saveGeneration: 1, generationLogId: 11, effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'persist-post-save:ws-1:spec-2b' },
      resultPayload: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(completedMatchSkillsJob);
    mockQueryOne.mockResolvedValue({ save_generation: 1 });
    mockListStagesByRun
      .mockResolvedValueOnce([ownedStage('matchSkills','completed',completedMatchSkillsJob)])
      .mockResolvedValueOnce([ownedStage('matchSkills','completed',completedMatchSkillsJob)])
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'completed'),
        ownedStage('matchSkills','completed',completedMatchSkillsJob),
        stage('memorySynthesis', 'pending'),
      ])
      .mockResolvedValueOnce([
        stage('context', 'completed'),
        stage('enrich', 'completed'),
        stage('matchSkills', 'completed'),
        stage('memorySynthesis', 'queued'),
      ]);

    const { advanceSpecPostSaveWorkflowDependencies } = await import('../spec-post-save-workflow');
    await advanceSpecPostSaveWorkflowDependencies('job-match-skills');

    expect(mockCreateJob).toHaveBeenCalledWith(
      'ws-1',
      'spec-2b',
      'memory-synthesis',
      expect.objectContaining({ stage: 'memorySynthesis', workflow: 'spec-post-save-v1' }),
    );
    expect(mockBossSend).toHaveBeenCalledWith('spec:memory-synthesis', expect.objectContaining({ specId: 'spec-2b' }), expect.any(Object));
  });

  it('does not duplicate-enqueue dependents that durable stage state already released', async () => {
    const completedEnrichJob = {
      id: 'job-enrich',
      specId: 'spec-3',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'completed',
      bossJobId: 'boss-1', transportSchema: 'pgboss',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'enrich', saveGeneration: 1, generationLogId: 11, effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'persist-post-save:ws-1:spec-3' },
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
      ownedStage('enrich','completed',completedEnrichJob),
      stage('matchSkills', 'queued'),
      stage('memorySynthesis', 'pending'),
    ]);

    const { advanceSpecPostSaveWorkflowDependencies } = await import('../spec-post-save-workflow');
    await advanceSpecPostSaveWorkflowDependencies('job-enrich');

    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it('guards terminal stage syncs so duplicate completion events stay idempotent', async () => {
    const completedEnrichJob = {
      id: 'job-enrich-sync',
      specId: 'spec-sync',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'completed',
      bossJobId: 'boss-sync', transportSchema: 'pgboss',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'enrich', saveGeneration: 1, generationLogId: 11, effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'persist-post-save:ws-1:spec-sync' },
      resultPayload: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(completedEnrichJob);
    mockQueryOne.mockResolvedValue({ save_generation: 1 });
    mockListStagesByRun.mockResolvedValue([ownedStage('enrich','completed',completedEnrichJob)]);

    const { syncSpecPostSaveWorkflowStageFromJob } = await import('../spec-post-save-workflow');
    await syncSpecPostSaveWorkflowStageFromJob('job-enrich-sync');

    expect(mockUpdateStageStatus).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: 'enrich',
      status: 'completed',
      allowedCurrentStatuses: ['pending', 'queued', 'running'],
    }));
  });

  it('binds the observed same-generation 80/93 topology to exact run 80 without latest-run substitution', async () => {
    const failedMemoryJob = {
      id: '340c973e-1829-4b9e-b7a0-1405a635d703',
      specId: 'wave-2',
      workspaceId: 'mission-waves',
      jobType: 'memory-synthesis',
      status: 'failed',
      bossJobId: 'b1ed2642-d2bc-40df-b19b-10b9372b933a', transportSchema: 'pgboss',
      requestPayload: {
        origin: 'persist-post-save',
        workflow: 'spec-post-save-v1',
        workflowRunId: 80,
        stage: 'memorySynthesis',
        saveGeneration: 432,
        transportSchema: 'pgboss',
        priority: 1,
        singletonKey: 'persist-post-save:mission-waves:wave-2',
      },
      resultPayload: null,
      errorMessage: 'postgres://user:pass@db.invalid/app Bearer Aa9Qz7Lm2Np8Vr4Tx6Kj0Hs5\n    at secretStack (/workspace/file.ts:1)',
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 432,
    };
    mockGetJob.mockResolvedValue(failedMemoryJob);
    mockQueryOne.mockResolvedValue({ save_generation: 432 });
    mockGetLatestRunForSpec.mockResolvedValue({ id: 93, saveGeneration: 432 });
    mockGetRunById.mockResolvedValue({
      id: 80,
      workspaceId: 'mission-waves',
      specId: 'wave-2',
      generationLogId: 437,
      saveGeneration: 432,
      effectivePolicyHash: '8'.repeat(64),
      effectivePolicy: bestEffortPolicy,
    });
    mockListStagesByRun.mockResolvedValue([
      {
        ...stage('memorySynthesis', 'queued'),
        runId: 80,
        jobId: failedMemoryJob.id,
        bossJobId: failedMemoryJob.bossJobId,
        queueName: 'spec:memory-synthesis',
        transportSchema: 'pgboss',
      },
    ]);

    const { getExactWorkflowRunForJob, syncSpecPostSaveWorkflowStageFromJob } = await import('../spec-post-save-workflow');
    expect(await getExactWorkflowRunForJob(normalizeWorkflowJob(failedMemoryJob))).toEqual(expect.objectContaining({ ok: true }));
    await syncSpecPostSaveWorkflowStageFromJob(failedMemoryJob.id);

    expect(mockGetRunById).toHaveBeenCalledWith(80, undefined);
    expect(mockGetLatestRunForSpec).not.toHaveBeenCalled();
    expect(mockUpdateStageStatus).toHaveBeenCalledWith(expect.objectContaining({
      runId: 80,
      stageKey: 'memorySynthesis',
      status: 'failed',
      errorMessage:'Application job failed; raw diagnostics are restricted.',
    }));
    expect(JSON.stringify(mockUpdateStageStatus.mock.calls)).not.toMatch(/postgres|Bearer|secretStack|workspace\/file/);
  });

  it.each([
    ['wrong workspace', { workspaceId: 'wrong' }],
    ['wrong spec', { specId: 'wrong' }],
    ['wrong generation', { saveGeneration: 999 }],
    ['wrong policy', { effectivePolicyHash: '9'.repeat(64) }],
    ['wrong generation log', { generationLogId: 999 }],
  ])('rejects exact workflow binding mismatch: %s', async (_label, patch) => {
    const job = {
      id: 'job-boundary',
      specId: 'spec-boundary',
      workspaceId: 'ws-boundary',
      jobType: 'enrich',
      status: 'failed',
      bossJobId: 'boss-boundary', transportSchema: 'pgboss',
      requestPayload: {
        origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 80,
        stage: 'enrich', saveGeneration: 432, generationLogId: 437,
        effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'bound',
      },
      resultPayload: null, errorMessage: 'failed', createdAt: new Date(),
      startedAt: new Date(), finishedAt: new Date(), saveGeneration: 432,
    };
    mockGetJob.mockResolvedValue(job);
    mockQueryOne.mockResolvedValue({ save_generation: 432 });
    mockGetRunById.mockResolvedValue({
      id: 80, workspaceId: 'ws-boundary', specId: 'spec-boundary', generationLogId: 437,
      saveGeneration: 432, effectivePolicyHash: '8'.repeat(64), effectivePolicy: bestEffortPolicy,
      ...patch,
    });

    const { syncSpecPostSaveWorkflowStageFromJob } = await import('../spec-post-save-workflow');
    await syncSpecPostSaveWorkflowStageFromJob(job.id);

    expect(mockUpdateStageStatus).not.toHaveBeenCalled();
  });

  it('rejects a fabricated application job type for the named workflow stage', async () => {
    mockGetJob.mockResolvedValue({
      id: 'job-fabricated', specId: 'spec-boundary', workspaceId: 'ws-boundary',
      jobType: 'match-skills', status: 'completed', bossJobId: 'boss-fabricated', transportSchema: 'pgboss',
      requestPayload: {
        origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 80,
        stage: 'enrich', saveGeneration: 432, generationLogId: 437,
        effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'bound',
      },
      resultPayload: {}, errorMessage: null, createdAt: new Date(), startedAt: new Date(),
      finishedAt: new Date(), saveGeneration: 432,
    });
    mockQueryOne.mockResolvedValue({ save_generation: 432 });

    const { syncSpecPostSaveWorkflowStageFromJob } = await import('../spec-post-save-workflow');
    await syncSpecPostSaveWorkflowStageFromJob('job-fabricated');

    expect(mockGetRunById).not.toHaveBeenCalled();
    expect(mockUpdateStageStatus).not.toHaveBeenCalled();
  });

  it('finalizes exactly from a terminal durable generation and reuses the shared compiler service', async () => {
    mockListStagesByRun.mockResolvedValue([
      stage('context', 'completed'),
      stage('enrich', 'completed'),
      stage('matchSkills', 'skipped'),
      stage('memorySynthesis', 'completed'),
    ]);
    mockQueryOne.mockResolvedValue({ path: '/workspace' });
    mockCompileSpecPlan.mockResolvedValue({ status: 'compiled', planId: 'plan-1' });

    const { finalizeSpecPostSavePlanIfReady } = await import('../spec-post-save-workflow');
    await expect(finalizeSpecPostSavePlanIfReady({
      id: 7,
      workspaceId: 'ws-1',
      specId: 'spec-final',
      saveGeneration: 9,
    } as never)).resolves.toMatchObject({ status: 'compiled', planId: 'plan-1' });

    expect(mockCompileSpecPlan).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1',
      specSlug: 'spec-final',
      expectedSaveGeneration: 9,
      source: 'post-save-finalizer',
    }));
  });

  it('blocks downstream pending stages with a durable reason when a required dependency fails', async () => {
    const failedEnrichJob = {
      id: 'job-enrich-failed',
      specId: 'spec-4',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'failed',
      bossJobId: 'boss-1', transportSchema: 'pgboss',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'enrich', saveGeneration: 1, generationLogId: 11, effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'persist-post-save:ws-1:spec-4' },
      resultPayload: null,
      errorMessage: 'enrich failed',
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 1,
    };
    mockGetJob.mockResolvedValue(failedEnrichJob);
    mockQueryOne.mockResolvedValue({ save_generation: 1 });
    const durableStages = installDurableStageState([
      stage('context', 'completed'),
      ownedStage('enrich','failed',failedEnrichJob),
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
    expect(durableStages.get('matchSkills')).toMatchObject({ status: 'failed', reason: 'blocked_by_required_stage_failed' });
    expect(durableStages.get('memorySynthesis')).toMatchObject({ status: 'failed', reason: 'blocked_by_required_stage_failed' });
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it('retains exact durable ownership for idempotent publication recovery after an ambiguous send failure', async () => {
    const durableStages = installDurableStageState([
      stage('context', 'completed'),
      stage('enrich', 'pending'),
      stage('matchSkills', 'pending'),
      stage('memorySynthesis', 'pending'),
    ]);
    mockBossSend.mockRejectedValueOnce(new Error('transport unavailable'));

    const { startSpecPostSaveWorkflow } = await import('../spec-post-save-workflow');
    await startSpecPostSaveWorkflow({ specId: 'spec-enqueue-failed', workspaceId: 'ws-1', effectivePolicy: bestEffortPolicy, saveGeneration: 1 });

    expect(mockUpdateStageStatus).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: 'enrich', status: 'queued', reason: 'durable_job_enqueueing', allowedCurrentStatuses: ['pending'],
      jobId: expect.any(String), bossJobId: expect.any(String), transportSchema: 'pgboss',
    }));
    expect(durableStages.get('enrich')).toMatchObject({ status: 'queued', reason: 'durable_job_enqueueing' });
    expect(durableStages.get('matchSkills')).toMatchObject({ status: 'pending' });
    expect(durableStages.get('memorySynthesis')).toMatchObject({ status: 'pending' });
  });

  it('terminates when a failed-dependency block CAS makes no durable transition', async () => {
    mockGetJob.mockResolvedValue({
      id: 'job-enrich-cas-lost',
      specId: 'spec-cas-lost',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'failed',
      bossJobId: 'boss-cas-lost',
      transportSchema: 'pgboss',
      requestPayload: { origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7, stage: 'enrich', saveGeneration: 1, generationLogId: 11, effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonKey: 'persist-post-save:ws-1:spec-cas-lost' },
      resultPayload: null,
      errorMessage: 'enrich failed',
      createdAt: new Date(),
      startedAt: new Date(),
      finishedAt: new Date(),
      saveGeneration: 1,
    });
    mockQueryOne.mockResolvedValue({ save_generation: 1 });
    const casLostJob = await mockGetJob('job-enrich-cas-lost');
    mockGetJob.mockResolvedValue(casLostJob);
    mockListStagesByRun.mockResolvedValue([
      stage('context', 'completed'),
      ownedStage('enrich','failed',casLostJob),
      stage('matchSkills', 'pending'),
      stage('memorySynthesis', 'pending'),
    ]);
    mockUpdateStageStatus.mockResolvedValue(null);

    const { advanceSpecPostSaveWorkflowDependencies } = await import('../spec-post-save-workflow');
    await expect(advanceSpecPostSaveWorkflowDependencies('job-enrich-cas-lost')).resolves.toBeUndefined();

    expect(mockUpdateStageStatus).toHaveBeenCalledWith(expect.objectContaining({
      stageKey: 'matchSkills',
      reason: 'blocked_by_required_stage_failed',
      allowedCurrentStatuses: ['pending'],
    }));
    expect(mockListStagesByRun).toHaveBeenCalledTimes(4);
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it('rolls back when the atomic stage ownership binding CAS makes no durable transition', async () => {
    mockListStagesByRun.mockResolvedValue([
      stage('context', 'completed'),
      stage('enrich', 'pending'),
      stage('matchSkills', 'pending'),
      stage('memorySynthesis', 'pending'),
    ]);
    mockUpdateStageStatus.mockResolvedValue(null);

    const { startSpecPostSaveWorkflow } = await import('../spec-post-save-workflow');
    await expect(startSpecPostSaveWorkflow({
      specId: 'spec-enqueue-cas-lost',
      workspaceId: 'ws-1',
      effectivePolicy: bestEffortPolicy,
      saveGeneration: 1,
    })).rejects.toThrow('Atomic post-save stage ownership binding lost');

    expect(mockListStagesByRun).toHaveBeenCalledTimes(1);
    expect(mockCreateJob).toHaveBeenCalledTimes(1);
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  it.each([
    ['valid UUID text', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', true],
    ['null legacy text', null, false],
    ['empty legacy text', '', false],
    ['malformed legacy text', 'not-a-uuid', false],
  ] as const)('recovers worker publications safely for %s', async (_label, stageBossJobId, shouldJoin) => {
    const bossJobId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const applicationJob = {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      specId: 'spec-recovery',
      workspaceId: 'ws-1',
      jobType: 'enrich',
      status: 'pending',
      bossJobId,
      transportSchema: 'pgboss',
      requestPayload: {
        origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 7,
        stage: 'enrich', saveGeneration: 1, generationLogId: 11,
        effectivePolicyHash: '8'.repeat(64), transportSchema: 'pgboss',
        queueName: 'spec:enrich', bossJobId, priority: 1,
        singletonKey: 'persist-post-save:ws-1:spec-recovery',
      },
      resultPayload: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
      saveGeneration: 1,
    };
    mockQuery.mockImplementationOnce(async (sql: string) => {
      expect(sql).toContain('stage.boss_job_id=job.boss_job_id::text');
      expect(sql).not.toMatch(/stage\.boss_job_id\s*::\s*uuid/i);
      return stageBossJobId === bossJobId
        ? [{ id: applicationJob.id, request_payload: applicationJob.requestPayload }]
        : [];
    });
    mockGetJob.mockResolvedValue(applicationJob);

    const { recoverBoundPostSaveWorkflowPublications } = await import('../spec-post-save-workflow');
    await expect(recoverBoundPostSaveWorkflowPublications()).resolves.toEqual(shouldJoin
      ? { scanned: 1, published: 1, failed: 0 }
      : { scanned: 0, published: 0, failed: 0 });

    if (shouldJoin) {
      expect(mockBossSend).toHaveBeenCalledWith(
        'spec:enrich',
        expect.objectContaining({ jobId: applicationJob.id, bossJobId }),
        expect.objectContaining({ id: bossJobId }),
      );
    } else {
      expect(mockGetJob).not.toHaveBeenCalled();
      expect(mockBossSend).not.toHaveBeenCalled();
    }
  });
});

export {};
