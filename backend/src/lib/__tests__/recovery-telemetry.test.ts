/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({ query: jest.fn() }));
jest.mock('../run-queue', () => ({ getWorkspaceRecoveryQueueSummary: jest.fn() }));
jest.mock('../worker-heartbeat', () => ({
  getLatestWorkerHeartbeat: jest.fn(),
  isWorkerHeartbeatStale: jest.fn(),
  WORKER_HEARTBEAT_STALE_MS: 90_000,
}));

import { query } from '../../db/index';
import { getWorkspaceRecoveryQueueSummary } from '../run-queue';
import { getLatestWorkerHeartbeat, isWorkerHeartbeatStale } from '../worker-heartbeat';
import { getRecoveryTelemetry } from '../recovery-telemetry';

const mockedQuery = query as jest.Mock;
const mockedQueue = getWorkspaceRecoveryQueueSummary as jest.Mock;
const mockedHeartbeat = getLatestWorkerHeartbeat as jest.Mock;
const mockedStale = isWorkerHeartbeatStale as jest.Mock;

describe('getRecoveryTelemetry', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockedQueue.mockResolvedValue({ queued: 2, active: 1, oldestQueuedAgeSeconds: 44, staleActive: 0 });
    mockedHeartbeat.mockResolvedValue({ last_seen: new Date().toISOString(), active_jobs: 1 });
    mockedStale.mockReturnValue(false);
    mockedQuery.mockResolvedValue([
      {
        id: 42,
        status: 'failed',
        queued_at: new Date(Date.now() - 10_000).toISOString(),
        started_at: new Date(Date.now() - 8_000).toISOString(),
        finished_at: new Date().toISOString(),
        last_heartbeat: null,
        // Deliberately not part of the selected projection.
        data: { token: 'must-not-leak' },
        log_path: '/secret/log',
      },
    ]);
  });

  it('returns a bounded redacted projection and never queue payload fields', async () => {
    const telemetry = await getRecoveryTelemetry('ws-recovery');

    expect(telemetry).toMatchObject({
      contractVersion: 'v1',
      available: true,
      redacted: true,
      workspaceId: 'ws-recovery',
      runs: [{ runId: 42, status: 'failed' }],
      worker: { staleAfterSeconds: 90 },
      limits: { maxRuns: 20, returnedRuns: 1 },
    });
    expect(JSON.stringify(telemetry)).not.toContain('must-not-leak');
    expect(JSON.stringify(telemetry)).not.toContain('/secret/log');
    expect(JSON.stringify(telemetry)).not.toMatch(/payload|env|path/i);
    expect(mockedQuery).toHaveBeenCalledWith(expect.stringContaining('LIMIT $2'), ['ws-recovery', 20]);
  });

  it('propagates unavailable canonical telemetry rather than fabricating queue truth', async () => {
    mockedQueue.mockRejectedValue(new Error('worker capability unavailable'));
    await expect(getRecoveryTelemetry('ws-recovery')).rejects.toThrow('worker capability unavailable');
  });
});
