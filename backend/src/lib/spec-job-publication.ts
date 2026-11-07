/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { compareAndSetJobStatus, type SpecJob } from '../db/spec-jobs';

/**
 * Record a queue publication result without regressing a worker or cancellation
 * that won the race after pg-boss accepted the preallocated transport ID.
 */
export function recordSpecJobPublication(input: {
  job: Pick<SpecJob, 'id' | 'workspaceId' | 'specId' | 'bossJobId' | 'transportSchema'>;
  outcome: 'published' | 'failed';
  message: string;
}): Promise<boolean> {
  const { job } = input;
  if (!job.bossJobId || !job.transportSchema) return Promise.resolve(false);
  return compareAndSetJobStatus({
    jobId: job.id,
    status: input.outcome === 'published' ? 'pending' : 'failed',
    expectedStatuses: ['pending'],
    expectedWorkspaceId: job.workspaceId,
    expectedSpecId: job.specId,
    expectedBossJobId: job.bossJobId,
    expectedTransportSchema: job.transportSchema,
    fields: input.outcome === 'published'
      ? { progressMessage: input.message }
      : { errorMessage: input.message, finishedAt: new Date() },
  });
}
