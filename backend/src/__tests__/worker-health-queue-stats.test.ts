/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-002: Worker health endpoint queue stats tests
 *
 * Tests cover:
 *   (1) Happy path — queueStats object returned with all fields
 *   (2) Empty queue — pending/active/failed all 0, oldestPendingAgeSeconds is null
 *   (3) Degraded health — failedInLast24h > 0
 *   (4) Critical health — failed jobs in pgboss.job (unarchived) detected
 *   (5) Parallel query execution — all 7 queries run via Promise.all
 *   (6) Per-queue breakdown — queues array populated with per-queue stats
 *   (7) Backward compatibility — existing fields unchanged
 */

// ── DB mock (must be before any imports that pull in worker.ts) ───────────────

const mockQuery = jest.fn().mockResolvedValue([]);
const mockExecute = jest.fn().mockResolvedValue({ rowCount: 1 });
const mockQueryOne = jest.fn().mockResolvedValue(undefined);

jest.mock('../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  initDb: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// ── Now import after mocks are in place ───────────────────────────────────────

import { once } from 'events';
import type { Server } from 'http';
import express from 'express';
import request from 'supertest';

// Build a minimal express app with just the pipeline worker health route
async function buildApp() {
  const app = express();
  app.use(express.json());
  // Dynamically import the router so it uses the already-mocked db
  const { default: pipelineRouter } = await import('../routes/pipeline');
  app.use('/api/pipeline', pipelineRouter);
  return app;
}


// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/pipeline/worker/health with queueStats', () => {
  let app: express.Application;
  let server: Server;

  function api() {
    return request(server);
  }

  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue([]);
    mockQueryOne.mockReset().mockResolvedValue(undefined);
    mockExecute.mockReset().mockResolvedValue({ rowCount: 0 });
    jest.clearAllMocks();
  });

  beforeAll(async () => {
    app = await buildApp();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  // ── (1) Happy path — queueStats object returned with all fields ────────────
  it('should return queueStats with all fields when queue has activity', async () => {
    // Mock worker heartbeat
    mockQueryOne.mockResolvedValueOnce({
      pid: 12345,
      started_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      active_jobs: 1,
    });

    // Mock active jobs query (pipeline:run with state='active')
    mockQuery.mockResolvedValueOnce([
      {
        run_id: '1',
        spec_path: 'forge/specs/approved/test-spec.json',
        started_at: new Date().toISOString(),
      },
    ]);

    // Mock queue depth (pipeline:run with state='created')
    mockQueryOne.mockResolvedValueOnce({ cnt: '3' });

    // Mock scheduled jobs
    mockQuery.mockResolvedValueOnce([
      { name: 'my-schedule', cron: '0 * * * *', timezone: null },
    ]);

    // Mock DLQ depth (failed archived jobs)
    mockQueryOne.mockResolvedValueOnce({ cnt: '2' });

    // Mock pg-boss version
    mockQueryOne.mockResolvedValueOnce({ version: '8.2.0' });

    // Mock reconciliation errors
    mockQueryOne.mockResolvedValueOnce({ cnt: '0' });

    // Mock queue stats — 7 queries in Promise.all
    // (1) pending, (2) active, (3) failed, (4) completed24h, (5) failedInLast24h,
    // (6) failedInLast7d, (7) archiveSize, (8) oldestPendingAgeSeconds
    mockQueryOne
      .mockResolvedValueOnce({ cnt: '3' }) // pending
      .mockResolvedValueOnce({ cnt: '1' }) // active
      .mockResolvedValueOnce({ cnt: '0' }) // failed
      .mockResolvedValueOnce({ cnt: '50' }) // completed24h
      .mockResolvedValueOnce({ cnt: '1' }) // failedInLast24h
      .mockResolvedValueOnce({ cnt: '5' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '100' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: 120 }); // oldestPendingAgeSeconds

    // Mock per-queue breakdown
    mockQuery.mockResolvedValueOnce([
      { name: 'pipeline:run', pending: '2', active: '1', failed: '0' },
      { name: 'pipeline:retry', pending: '1', active: '0', failed: '0' },
      { name: 'pipeline:cancel', pending: '0', active: '0', failed: '0' },
    ]);

    // Mock latency row (10th item in Promise.all)
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('workerActive');
    expect(res.body).toHaveProperty('queueHealth');
    expect(res.body).toHaveProperty('queueStats');

    const { queueStats, queueHealth } = res.body;

    // Verify key queueStats fields are present
    expect(queueStats.pending).toBe(3);
    expect(queueStats.active).toBe(1);
    expect(queueStats.failed).toBe(0);
    expect(queueStats.completed24h).toBe(50);
    expect(queueStats.failedInLast24h).toBe(1);
    expect(queueStats.failedInLast7d).toBe(5);
    expect(queueStats.archiveSize).toBe(100);
    expect(queueStats.oldestPendingAgeSeconds).toBe(120);
    expect(queueStats.queues).toEqual([
      { name: 'pipeline:run', pending: 2, active: 1, failed: 0 },
      { name: 'pipeline:retry', pending: 1, active: 0, failed: 0 },
      { name: 'pipeline:cancel', pending: 0, active: 0, failed: 0 },
    ]);
    expect(queueStats).toHaveProperty('pickupLatency');

    // Should be degraded because failedInLast24h > 0
    expect(queueHealth).toBe('degraded');
  });

  // ── (2) Empty queue — pending/active/failed all 0, oldestPendingAgeSeconds is null ─
  it('should handle empty queue gracefully', async () => {
    // Mock all queries to return empty/zero results
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        active_jobs: 0,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '0' }) // queue depth
      .mockResolvedValueOnce({ cnt: '0' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '0' }) // reconciliation errors
      .mockResolvedValueOnce({ cnt: '0' }) // pending
      .mockResolvedValueOnce({ cnt: '0' }) // active
      .mockResolvedValueOnce({ cnt: '0' }) // failed
      .mockResolvedValueOnce({ cnt: '0' }) // completed24h
      .mockResolvedValueOnce({ cnt: '0' }) // failedInLast24h
      .mockResolvedValueOnce({ cnt: '0' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '0' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: null }); // oldestPendingAgeSeconds (null)

    mockQuery
      .mockResolvedValueOnce([]) // active jobs
      .mockResolvedValueOnce([]) // scheduled jobs
      .mockResolvedValueOnce([]); // per-queue breakdown

    // Mock latency row (10th item in Promise.all)
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    expect(res.body.queueStats.pending).toBe(0);
    expect(res.body.queueStats.active).toBe(0);
    expect(res.body.queueStats.failed).toBe(0);
    expect(res.body.queueStats.oldestPendingAgeSeconds).toBeNull();
    expect(res.body.queueStats.queues).toEqual([]);
    expect(res.body.queueHealth).toBe('healthy');
  });

  // ── (3) Degraded health — failedInLast24h > 0 ───────────────────────────────
  it('should return degraded health when failedInLast24h > 0', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        active_jobs: 0,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '1' }) // queue depth
      .mockResolvedValueOnce({ cnt: '0' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '0' }) // reconciliation errors
      .mockResolvedValueOnce({ cnt: '1' }) // pending
      .mockResolvedValueOnce({ cnt: '0' }) // active
      .mockResolvedValueOnce({ cnt: '0' }) // failed
      .mockResolvedValueOnce({ cnt: '10' }) // completed24h
      .mockResolvedValueOnce({ cnt: '2' }) // failedInLast24h (triggers degraded)
      .mockResolvedValueOnce({ cnt: '5' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '50' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: 60 }); // oldestPendingAgeSeconds

    mockQuery
      .mockResolvedValueOnce([]) // active jobs
      .mockResolvedValueOnce([]) // scheduled jobs
      .mockResolvedValueOnce([{ name: 'pipeline:run', pending: '1', active: '0', failed: '0' }]); // per-queue

    // Mock latency row
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    expect(res.body.queueHealth).toBe('degraded');
    expect(res.body.queueStats.failedInLast24h).toBe(2);
  });

  // ── (4) Critical health — failed jobs in pgboss.job detected ─────────────────
  it('should return critical health when failed jobs exist in pgboss.job', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        active_jobs: 0,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '0' }) // queue depth
      .mockResolvedValueOnce({ cnt: '5' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '0' }) // reconciliation errors
      .mockResolvedValueOnce({ cnt: '0' }) // pending
      .mockResolvedValueOnce({ cnt: '0' }) // active
      .mockResolvedValueOnce({ cnt: '3' }) // failed (triggers critical)
      .mockResolvedValueOnce({ cnt: '10' }) // completed24h
      .mockResolvedValueOnce({ cnt: '0' }) // failedInLast24h
      .mockResolvedValueOnce({ cnt: '5' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '100' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: null }); // oldestPendingAgeSeconds

    mockQuery
      .mockResolvedValueOnce([]) // active jobs
      .mockResolvedValueOnce([]) // scheduled jobs
      .mockResolvedValueOnce([]); // per-queue

    // Mock latency row
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    expect(res.body.queueHealth).toBe('critical');
    expect(res.body.queueStats.failed).toBe(3);
  });

  // ── (5) Critical health — failedInLast24h > 5 ──────────────────────────────
  it('should return critical health when failedInLast24h > 5', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        active_jobs: 0,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '0' }) // queue depth
      .mockResolvedValueOnce({ cnt: '0' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '0' }) // reconciliation errors
      .mockResolvedValueOnce({ cnt: '0' }) // pending
      .mockResolvedValueOnce({ cnt: '0' }) // active
      .mockResolvedValueOnce({ cnt: '0' }) // failed
      .mockResolvedValueOnce({ cnt: '100' }) // completed24h
      .mockResolvedValueOnce({ cnt: '10' }) // failedInLast24h (> 5 triggers critical)
      .mockResolvedValueOnce({ cnt: '15' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '200' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: null }); // oldestPendingAgeSeconds

    mockQuery
      .mockResolvedValueOnce([]) // active jobs
      .mockResolvedValueOnce([]) // scheduled jobs
      .mockResolvedValueOnce([]); // per-queue

    // Mock latency row
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    expect(res.body.queueHealth).toBe('critical');
    expect(res.body.queueStats.failedInLast24h).toBe(10);
  });

  // ── (6) Degraded health — oldestPendingAgeSeconds > 300 ────────────────────
  it('should return degraded health when oldest pending job > 5 minutes', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        active_jobs: 0,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '5' }) // queue depth
      .mockResolvedValueOnce({ cnt: '0' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '0' }) // reconciliation errors
      .mockResolvedValueOnce({ cnt: '5' }) // pending
      .mockResolvedValueOnce({ cnt: '0' }) // active
      .mockResolvedValueOnce({ cnt: '0' }) // failed
      .mockResolvedValueOnce({ cnt: '50' }) // completed24h
      .mockResolvedValueOnce({ cnt: '0' }) // failedInLast24h
      .mockResolvedValueOnce({ cnt: '2' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '100' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: 450 }); // oldestPendingAgeSeconds (> 300)

    mockQuery
      .mockResolvedValueOnce([]) // active jobs
      .mockResolvedValueOnce([]) // scheduled jobs
      .mockResolvedValueOnce([{ name: 'pipeline:run', pending: '5', active: '0', failed: '0' }]); // per-queue

    // Mock latency row
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    expect(res.body.queueHealth).toBe('degraded');
    expect(res.body.queueStats.oldestPendingAgeSeconds).toBe(450);
  });

  // ── (7) Backward compatibility — existing fields unchanged ──────────────────
  it('should include all existing fields for backward compatibility', async () => {
    const now = new Date();
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: now.toISOString(),
        last_seen: now.toISOString(),
        active_jobs: 2,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '5' }) // queue depth
      .mockResolvedValueOnce({ cnt: '3' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '1' }) // reconciliation errors
      .mockResolvedValueOnce({ cnt: '5' }) // pending
      .mockResolvedValueOnce({ cnt: '2' }) // active
      .mockResolvedValueOnce({ cnt: '0' }) // failed
      .mockResolvedValueOnce({ cnt: '50' }) // completed24h
      .mockResolvedValueOnce({ cnt: '0' }) // failedInLast24h
      .mockResolvedValueOnce({ cnt: '2' }) // failedInLast7d
      .mockResolvedValueOnce({ cnt: '100' }) // archiveSize
      .mockResolvedValueOnce({ age_seconds: 30 }); // oldestPendingAgeSeconds

    mockQuery
      .mockResolvedValueOnce([
        {
          run_id: '1',
          spec_path: 'forge/specs/approved/test.json',
          started_at: now.toISOString(),
        },
      ]) // active jobs
      .mockResolvedValueOnce([{ name: 'test-schedule', cron: '0 0 * * *', timezone: 'UTC' }]) // scheduled jobs
      .mockResolvedValueOnce([]); // per-queue

    // Mock latency row
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await api().get('/api/pipeline/worker/health');

    expect(res.status).toBe(200);
    // Verify existing fields are present
    expect(res.body).toHaveProperty('workerActive');
    expect(res.body).toHaveProperty('workerPid', 12345);
    expect(res.body).toHaveProperty('workerStartedAt');
    expect(res.body).toHaveProperty('activeChildProcesses', 2);
    expect(res.body).toHaveProperty('activeJobs');
    expect(res.body).toHaveProperty('queueDepth', 5);
    expect(res.body).toHaveProperty('scheduledJobs');
    expect(res.body).toHaveProperty('dlqDepth', 3);
    expect(res.body).toHaveProperty('pgBossVersion', '8.2.0');
    expect(res.body).toHaveProperty('lastReconciliationErrors', 1);
    // New fields
    expect(res.body).toHaveProperty('queueHealth');
    expect(res.body).toHaveProperty('queueStats');
  });

  // ── (8) Error handling — DB errors must not become healthy-looking zeros ────
  it('returns unavailable when queue statistics cannot be queried', async () => {
    mockQueryOne
      .mockResolvedValueOnce({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_seen: new Date().toISOString(),
        active_jobs: 0,
      }) // heartbeat
      .mockResolvedValueOnce({ cnt: '1' }) // queue depth
      .mockResolvedValueOnce({ cnt: '0' }) // dlq depth
      .mockResolvedValueOnce({ version: '8.2.0' }) // version
      .mockResolvedValueOnce({ cnt: '0' }); // reconciliation errors

    // Simulate Promise.all rejection for queue stats
    mockQuery
      .mockResolvedValueOnce([]) // active jobs
      .mockResolvedValueOnce([]) // scheduled jobs
      .mockRejectedValueOnce(new Error('DB connection lost')); // per-queue queries fail

    const res = await api().get('/api/pipeline/worker/health');

    // A failed queue probe is unknown/unavailable, not an empty healthy queue.
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('queueStats');
    expect(res.body.error).toBeDefined();
  });
});
