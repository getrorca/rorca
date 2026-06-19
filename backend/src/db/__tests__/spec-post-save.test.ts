/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import {
  hashEffectivePolicy,
  projectPostSaveStages,
  type PostSaveWorkflowStage,
} from '../spec-post-save';

describe('spec-post-save durable workflow helpers', () => {
  it('hashes effective policy independent of object key order', () => {
    const first = hashEffectivePolicy({ postSave: { enrich: true, matchSkills: false, memorySynthesis: false }, version: 1 });
    const second = hashEffectivePolicy({ version: 1, postSave: { memorySynthesis: false, matchSkills: false, enrich: true } });

    expect(first).toBe(second);
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
