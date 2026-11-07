/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockGetJob = jest.fn();
const mockSynthesize = jest.fn();
const mockExactWorkflow = jest.fn();
const mockQueryOne = jest.fn();

jest.mock('../../db/spec-jobs', () => ({ getJob: (...args: unknown[]) => mockGetJob(...args) }));
jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => mockQueryOne(...args), query: jest.fn(), execute: jest.fn() }));
jest.mock('../strict-spec-memory', () => ({ synthesizeStrictSpecMemory: (...args: unknown[]) => mockSynthesize(...args) }));
jest.mock('../spec-post-save-workflow', () => ({ getExactWorkflowRunForJob: (...args: unknown[]) => mockExactWorkflow(...args) }));

import { runMemorySynthesisJob } from '../spec-job-handlers';

const payload = {
  jobId: '11111111-1111-4111-8111-111111111111',
  specId: 'spec-one',
  workspaceId: 'workspace:one',
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: payload.jobId,
    jobType: 'memory-synthesis',
    specId: payload.specId,
    workspaceId: payload.workspaceId,
    status: 'processing',
    requestPayload: {
      origin: 'persist-post-save', workflow: 'spec-post-save-v1', workflowRunId: 80,
      stage: 'memorySynthesis', saveGeneration: 3, generationLogId: 9,
      effectivePolicyHash: 'a'.repeat(64), transportSchema: 'pgboss', priority: 1, singletonSeconds: 1,
      memory: { brief: 'persisted only', stories: [], contextSummary: {} },
    },
    ...overrides,
  };
}

describe('required memory synthesis job handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const exactJob = job();
    mockGetJob.mockResolvedValue(exactJob);
    mockExactWorkflow.mockResolvedValue({ ok: true, run: { id: 80 }, stage: { id: 800 }, metadata: exactJob.requestPayload });
    mockQueryOne.mockResolvedValue({ material_hash: `sha256:${'b'.repeat(64)}` });
    mockSynthesize.mockResolvedValue({ success: true, saved: 1, replayed: false, memoryId: 7 });
  });

  test('binds the exact persisted application job and invokes only strict synthesis', async () => {
    const progress = jest.fn();
    await expect(runMemorySynthesisJob(payload, progress)).resolves.toEqual({ success: true, synthesized: true });
    expect(mockGetJob).toHaveBeenCalledWith(payload.jobId);
    expect(mockSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      ...payload,
      metadata: { workflowRunId: 80, workflowStageId: 800, generationLogId: 9, saveGeneration: 3, effectivePolicyHash: 'a'.repeat(64), materialHash: `sha256:${'b'.repeat(64)}` },
      memory: expect.objectContaining({ brief: 'persisted only' }),
    }));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 1, total: 1 }));
  });

  test.each([
    ['wrong application job', { id: '22222222-2222-4222-8222-222222222222' }],
    ['wrong workspace', { workspaceId: 'workspace:other' }],
    ['wrong job type', { jobType: 'enrich' }],
    ['missing strict workflow metadata', { requestPayload: { memory: {} } }],
  ])('rejects %s before invoking the sandbox', async (_label, overrides) => {
    const changedJob = job(overrides);
    mockGetJob.mockResolvedValue(changedJob);
    if ('requestPayload' in overrides) mockExactWorkflow.mockResolvedValue({ ok: false, reason: 'metadata_invalid' });
    await expect(runMemorySynthesisJob(payload)).rejects.toThrow(/binding is invalid|metadata is invalid/);
    expect(mockSynthesize).not.toHaveBeenCalled();
  });
});
