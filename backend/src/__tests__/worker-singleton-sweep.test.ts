/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-005: Worker singleton guard, heartbeat-aware stale job recovery,
 * and heartbeat-aware orphan sweep tests.
 *
 * Tests cover:
 *   (1) Singleton guard: first worker acquires lock
 *   (2) Singleton guard: second worker rejected when live heartbeat exists
 *   (3) Singleton guard: second worker takes over when heartbeat is stale (dead PID)
 *   (4) Stale recovery: active jobs with dead worker heartbeat are marked failed
 *   (5) Stale recovery: active jobs with live worker heartbeat are left alone
 *   (6) Stale recovery: uses correct pg-boss column name started_on (NOT startedon)
 *   (7) Orphan sweep: only kills processes whose worker has stale heartbeat
 *   (8) Orphan sweep: does NOT kill processes from a live worker
 */

// ── DB mock (must be before any imports that pull in worker.ts) ───────────────

const mockQuery = jest.fn().mockResolvedValue([]);
const mockExecute = jest.fn().mockResolvedValue({ rowCount: 1 });
const mockQueryOne = jest.fn().mockResolvedValue(undefined);
const mockBossFail = jest.fn().mockResolvedValue(undefined);
const mockBossRetry = jest.fn().mockResolvedValue(undefined);
const mockPersistHostRunCloseout = jest.fn().mockResolvedValue({});
const mockTransitionRunLifecycle = jest.fn().mockResolvedValue({});
const mockAdvanceQueue = jest.fn().mockResolvedValue(undefined);

jest.mock('../db/index', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  initDb: jest.fn().mockResolvedValue(undefined),
}));

// ── Mock heavy deps that worker.ts pulls in at module level ──────────────────

jest.mock('../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn(() => ({
    fail: (...args: unknown[]) => mockBossFail(...args),
    retry: (...args: unknown[]) => mockBossRetry(...args),
  })),
}));

jest.mock('../lib/pg-boss-schema', () => ({
  getPgBossSchemaSql: jest.fn(() => '"pgboss_cert_test"'),
}));

jest.mock('../lib/story-result-persistence', () => ({
  persistCanonicalStoryResult: jest.fn().mockResolvedValue({ duplicate: false }),
  recoverIntegratedValidatedStoryFinalizations: jest.fn().mockResolvedValue({
    scanned: 0, finalized: 0, duplicates: 0, blocked: 0, truncated: false, finalizedStoryIds: [],
  }),
  WORKER_RESULT_AUTHORITY: Symbol('worker-result-authority'),
}));

jest.mock('../lib/trusted-wal', () => ({
  ...jest.requireActual('../lib/trusted-wal'),
  GITHUB_GOVERNING_WAL_EVENTS: new Set(),
  persistTrustedWalEvent: jest.fn(),
  relayTrustedWalEvent: jest.fn(),
  relayUnacknowledgedTrustedRunEvents: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/run-closeout-authority', () => ({
  persistHostRunCloseout: (...args: unknown[]) => mockPersistHostRunCloseout(...args),
}));

jest.mock('../lib/run-lifecycle', () => ({
  transitionRunLifecycle: (...args: unknown[]) => mockTransitionRunLifecycle(...args),
}));

jest.mock('../lib/run-queue', () => ({
  advanceQueue: (...args: unknown[]) => mockAdvanceQueue(...args),
}));

jest.mock('../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
  },
}));

// ── Now import after mocks are in place ───────────────────────────────────────

import { checkSingletonGuard, recoverStaleJobs, sweepOrphanProcesses } from '../worker';

// ── Helpers ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue([]);
  mockExecute.mockReset().mockResolvedValue({ rowCount: 1 });
  mockQueryOne.mockReset().mockResolvedValue(undefined);
  mockBossFail.mockReset().mockResolvedValue(undefined);
  mockPersistHostRunCloseout.mockReset().mockResolvedValue({});
  mockTransitionRunLifecycle.mockReset().mockResolvedValue({});
  mockAdvanceQueue.mockReset().mockResolvedValue(undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Singleton Guard Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkSingletonGuard', () => {
  let killSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as any);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── (1) First worker acquires the singleton lock ──────────────────────────

  it('allows startup when no other live workers exist', async () => {
    // No live workers in heartbeat table
    mockQuery.mockResolvedValueOnce([]);

    await checkSingletonGuard();

    // Should query worker_heartbeat for live workers
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('worker_heartbeat'),
      expect.arrayContaining([expect.any(String)]),
    );

    // Should NOT call process.exit
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── (2) Second worker rejected when live heartbeat exists ─────────────────

  it('rejects startup when another worker has a live heartbeat and alive PID', async () => {
    const liveWorker = {
      worker_id: 'existing-worker-uuid',
      pid: 12345,
      last_seen: new Date().toISOString(),
    };
    mockQuery.mockResolvedValueOnce([liveWorker]);

    // PID liveness check succeeds (process is alive)
    killSpy.mockImplementation((pid: number, sig: number | string) => {
      if (sig === 0) return true;
      return true as any;
    });

    const allowed = await checkSingletonGuard();

    // Should have checked PID liveness
    expect(killSpy).toHaveBeenCalledWith(12345, 0);

    // Should decline startup without hard-exiting the process
    expect(allowed).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── (3) Second worker takes over when heartbeat is stale (dead PID) ───────

  it('cleans stale heartbeat and continues when existing worker PID is dead', async () => {
    const staleWorker = {
      worker_id: 'dead-worker-uuid',
      pid: 99999,
      last_seen: new Date(Date.now() - 60_000).toISOString(), // 60s ago but still within 90s window per SQL
    };
    mockQuery.mockResolvedValueOnce([staleWorker]);

    // PID liveness check fails (ESRCH — process is dead)
    killSpy.mockImplementation((pid: number, sig: number | string) => {
      if (sig === 0) {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true as any;
    });

    await checkSingletonGuard();

    // Should have tried PID liveness check
    expect(killSpy).toHaveBeenCalledWith(99999, 0);

    // Should NOT exit — stale heartbeat is cleaned up
    expect(exitSpy).not.toHaveBeenCalled();

    // Should delete the stale heartbeat row
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM worker_heartbeat'),
      ['dead-worker-uuid'],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Heartbeat-Aware Stale Job Recovery Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('recoverStaleJobs', () => {
  beforeEach(() => {
    mockQuery.mockReset().mockResolvedValue([]);
    mockExecute.mockReset().mockResolvedValue({ rowCount: 1 });
    mockQueryOne.mockReset().mockResolvedValue(undefined);
    mockBossFail.mockReset().mockResolvedValue(undefined);
    mockBossRetry.mockReset().mockResolvedValue(undefined);
    mockPersistHostRunCloseout.mockReset().mockResolvedValue({});
    mockTransitionRunLifecycle.mockReset().mockResolvedValue({});
    mockAdvanceQueue.mockReset().mockResolvedValue(undefined);
  });

  // ── (4) Active jobs with dead worker heartbeat are reconciled ──────────────

  it('terminalizes application state before notifying pg-boss about a stale dispatch', async () => {
    const staleJob = {
      id: 'job-uuid-1',
      name: 'pipeline:run',
      data: { runId: 42, specPath: 'forge/specs/approved/test.json' },
    };

    // recoverStaleJobs query returns one stale job
    mockQuery.mockResolvedValueOnce([staleJob]);

    // queryOne for workspace_id lookup, then frozen-story inventory
    mockQueryOne
      .mockResolvedValueOnce({ workspace_id: '7' })
      .mockResolvedValueOnce({ expected_story_ids: [] });

    await recoverStaleJobs();

    expect(mockPersistHostRunCloseout).toHaveBeenCalledWith({
      runId: 42,
      status: 'failed',
      terminalizeRun: true,
    });
    expect(mockTransitionRunLifecycle).toHaveBeenCalledWith(42, 'failed', {
      owner: 'worker_crash_recovery',
      process: 'stale_pgboss_job',
      pgbossJobId: 'job-uuid-1',
    });
    expect(mockBossFail).toHaveBeenCalledWith(
      'pipeline:run',
      'job-uuid-1',
      { reason: 'application_state_reconciled' },
    );

    // Application-owned terminalization must precede the transport notification.
    expect(mockPersistHostRunCloseout.mock.invocationCallOrder[0])
      .toBeLessThan(mockBossFail.mock.invocationCallOrder[0]);
    expect(mockTransitionRunLifecycle.mock.invocationCallOrder[0])
      .toBeLessThan(mockBossFail.mock.invocationCallOrder[0]);

    // pg-boss transport tables are never hand-mutated by recovery.
    expect(mockExecute.mock.calls.some(
      ([sql]) => typeof sql === 'string' && sql.includes('pgboss_cert_test'),
    )).toBe(false);
  });

  it('restarts an exact never-started direct job after a crash under saturated budget', async () => {
    const staleJob = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'pipeline:run:direct',
      data: { runId: 43, specPath: 'forge/specs/approved/direct.json' },
    };
    mockQuery.mockResolvedValueOnce([staleJob]);
    mockQueryOne.mockResolvedValueOnce({
      workspace_id: 'workspace-direct',
      status: 'queued',
      dispatch_owner: null,
      publication_state: 'published',
      publication_lease_owner: null,
      cancellation_requested: false,
    });

    await recoverStaleJobs();

    expect(mockPersistHostRunCloseout).not.toHaveBeenCalled();
    expect(mockTransitionRunLifecycle).not.toHaveBeenCalled();
    expect(mockBossFail).toHaveBeenCalledWith(
      'pipeline:run:direct',
      staleJob.id,
      { reason: 'worker_restarted_before_budget_admission' },
    );
    expect(mockBossRetry).toHaveBeenCalledWith('pipeline:run:direct', staleJob.id);
  });

  it('restarts an exact pre-claim governed retry after a crash under saturated budget', async () => {
    const staleJob = {
      id: '33333333-3333-4333-8333-333333333333',
      name: 'pipeline:retry',
      data: { runId: 44, originalRunId: 42 },
    };
    mockQuery.mockResolvedValueOnce([staleJob]);
    mockQueryOne.mockResolvedValueOnce({
      workspace_id: 'workspace-retry',
      status: 'queued',
      pid: null,
      dispatch_owner: null,
      publication_state: null,
      publication_lease_owner: null,
      cancellation_requested: false,
      retry_dispatch_state: 'dispatched',
      retry_boss_job_id: staleJob.id,
      retry_lease_owner: null,
      retry_lease_expires_at: null,
      retry_launch_pid: null,
      retry_cancellation_requested: false,
    });

    await recoverStaleJobs();

    expect(mockPersistHostRunCloseout).not.toHaveBeenCalled();
    expect(mockTransitionRunLifecycle).not.toHaveBeenCalled();
    expect(mockBossFail).toHaveBeenCalledWith(
      'pipeline:retry',
      staleJob.id,
      { reason: 'worker_restarted_before_budget_admission' },
    );
    expect(mockBossRetry).toHaveBeenCalledWith('pipeline:retry', staleJob.id);
  });

  // ── (5) Active jobs with live worker heartbeat are left alone ──────────────

  it('leaves active jobs alone when owning worker has a live heartbeat', async () => {
    // The SQL query in recoverStaleJobs uses NOT EXISTS with worker_heartbeat
    // to filter out jobs whose owning worker is still alive. When the DB returns
    // no rows (because all active jobs have live owning workers), no recovery runs.
    mockQuery.mockResolvedValueOnce([]);

    await recoverStaleJobs();

    // No pgboss.job updates
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── (6) Uses correct pg-boss column name started_on ────────────────────────

  it('queries pgboss.job using started_on (not startedon) column name', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await recoverStaleJobs();

    // Verify the SQL query uses started_on (underscore) not startedon
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall).toBeDefined();
    const sql = queryCall[0] as string;

    // Must contain started_on (correct)
    expect(sql).toContain('started_on');

    // Must NOT contain startedon without underscore (incorrect)
    // Use regex to check for startedon NOT preceded by underscore
    expect(sql).not.toMatch(/\bstartedon\b/);

    // Also verify completed_on is used in the UPDATE (tested via stale job path)
    // This ensures the column names are consistently correct
  });

  it('reads stale jobs from the validated configured schema and never updates transport rows directly', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await recoverStaleJobs();

    const sql = mockQuery.mock.calls[0]?.[0] as string;
    expect(sql).toContain('FROM "pgboss_cert_test".job');
    expect(sql).toContain('started_on');
    expect(mockExecute.mock.calls.some(
      ([statement]) => typeof statement === 'string' && statement.includes('pgboss_cert_test'),
    )).toBe(false);
    expect(mockBossFail).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Heartbeat-Aware Orphan Sweep Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('sweepOrphanProcesses (heartbeat-aware)', () => {
  let killSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    mockQuery.mockReset().mockResolvedValue([]);
    mockExecute.mockReset().mockResolvedValue({ rowCount: 1 });
    mockQueryOne.mockReset().mockResolvedValue(undefined);
    mockTransitionRunLifecycle.mockReset().mockResolvedValue({});
    mockAdvanceQueue.mockReset().mockResolvedValue(undefined);
    killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true as any);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ── (7) Only kills processes whose worker has stale heartbeat ─────────────

  it('kills orphan process when owning worker heartbeat is stale', async () => {
    const orphanRun = { id: 88, pid: 5555, workspace_id: 10 };

    // The SQL query uses LEFT JOIN worker_heartbeat with 90s threshold.
    // Runs returned by the query have already been filtered to only include
    // those whose worker_id has no live heartbeat.
    mockQuery.mockResolvedValueOnce([orphanRun]);
    // story_results query
    mockQuery.mockResolvedValueOnce([]);

    // PID is alive → SIGTERM → dies after 5s
    let killCallIndex = 0;
    killSpy.mockImplementation((pid: number, sig: number | string) => {
      killCallIndex++;
      if (sig === 0) {
        if (killCallIndex === 1) return true; // alive on first check
        // Dead after SIGTERM
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true as any;
    });

    const promise = sweepOrphanProcesses();
    await jest.advanceTimersByTimeAsync(5_001);
    const results = await promise;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 88, pid: 5555, killed: true });

    // SIGTERM was sent to the orphan process
    expect(killSpy).toHaveBeenCalledWith(5555, 'SIGTERM');

    // pipeline_runs marked as failed
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pipeline_runs'),
      [88],
    );

    // WAL event emitted with reason:'orphan_sweep'
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO wal_events'),
      expect.arrayContaining([
        'run_finished',
        10,
        expect.stringContaining('"reason":"orphan_sweep"'),
      ]),
    );
  });

  // ── (8) Does NOT kill processes from a live worker ────────────────────────

  it('does not kill processes when owning worker has a live heartbeat', async () => {
    // The SQL query filters using LEFT JOIN worker_heartbeat with the 90s
    // threshold. When the owning worker's heartbeat is fresh (last_seen < 90s),
    // the LEFT JOIN produces a non-NULL wh.worker_id, which is excluded by the
    // WHERE clause (wh.worker_id IS NULL). So the query returns no rows.
    mockQuery.mockResolvedValueOnce([]);

    const results = await sweepOrphanProcesses();

    expect(results).toEqual([]);

    // Verify the SQL uses the heartbeat JOIN for filtering
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall).toBeDefined();
    const sql = queryCall[0] as string;
    expect(sql).toContain('worker_heartbeat');
    expect(sql).toContain('90 seconds');

    // No process.kill calls
    expect(killSpy).not.toHaveBeenCalled();

    // No pipeline_runs updates
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('sweep SQL passes worker self-exclusion and protected genesis-run fences', async () => {
    mockQuery.mockResolvedValueOnce([]);

    await sweepOrphanProcesses();

    // The sweep query uses WORKER_ID ($1) to exclude this worker's runs and
    // the immutable protected Genesis run ID ($2) to keep it outside cleanup.
    const queryCall = mockQuery.mock.calls[0];
    expect(queryCall).toBeDefined();
    const params = queryCall[1] as unknown[];
    expect(params).toHaveLength(2);
    expect(typeof params[0]).toBe('string');
    expect((params[0] as string).length).toBe(36); // UUID format
    expect(params[1]).toBe(20260316000549);
  });
});
