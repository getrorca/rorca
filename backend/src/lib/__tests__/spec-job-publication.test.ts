/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

export {};

const mockCompareAndSetJobStatus = jest.fn();

jest.mock('../../db/spec-jobs', () => ({
  compareAndSetJobStatus: (...args: unknown[]) => mockCompareAndSetJobStatus(...args),
}));

const job = {
  id: '22222222-2222-4222-8222-222222222222',
  workspaceId: 'ws-1',
  specId: 'spec-1',
  bossJobId: '11111111-1111-4111-8111-111111111111',
  transportSchema: 'pgboss',
};

describe('spec job publication lifecycle fence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompareAndSetJobStatus.mockResolvedValue(true);
  });

  test.each([
    ['published', 'pending', { progressMessage: 'Queued spec:enrich job' }],
    ['failed', 'failed', { errorMessage: 'publication failed', finishedAt: expect.any(Date) }],
  ] as const)('records %s only while the exact application job remains pending', async (outcome, status, fields) => {
    const { recordSpecJobPublication } = await import('../spec-job-publication');

    await recordSpecJobPublication({
      job,
      outcome,
      message: outcome === 'published' ? 'Queued spec:enrich job' : 'publication failed',
    });

    expect(mockCompareAndSetJobStatus).toHaveBeenCalledWith({
      jobId: job.id,
      status,
      expectedStatuses: ['pending'],
      expectedWorkspaceId: job.workspaceId,
      expectedSpecId: job.specId,
      expectedBossJobId: job.bossJobId,
      expectedTransportSchema: job.transportSchema,
      fields,
    });
  });

  test('cannot overwrite a worker or cancellation that already won the status CAS', async () => {
    mockCompareAndSetJobStatus.mockResolvedValue(false);
    const { recordSpecJobPublication } = await import('../spec-job-publication');

    await expect(recordSpecJobPublication({
      job,
      outcome: 'published',
      message: 'Queued spec:enrich job',
    })).resolves.toBe(false);

    expect(mockCompareAndSetJobStatus).toHaveBeenCalledTimes(1);
  });
});
