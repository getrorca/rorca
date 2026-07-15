/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Tests for sweepOrphanProcesses() in worker.ts.
 *
 * Strategy: mock the DB helpers (query, execute) and global fetch (WAL emission),
 * then spy on process.kill to control which PIDs appear alive. The function is
 * exported from worker.ts so we import it directly.
 *
 * We do NOT start the worker event loop (no boss.start()), we only test the
 * exported pure function in isolation.
 */

// ── Mocks that must be declared before any import of worker.ts ────────────────

jest.mock('dotenv/config', () => ({}));

// Mock pg-boss so initBoss() / getBoss() calls in module scope don't throw
jest.mock('../../lib/pg-boss', () => ({
  initBoss: jest.fn().mockResolvedValue(undefined),
  getBoss: jest.fn().mockReturnValue({
    send: jest.fn().mockResolvedValue('mock-job-id'),
    work: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    getQueueSize: jest.fn().mockResolvedValue(0),
    createQueue: jest.fn().mockResolvedValue(undefined),
    schedule: jest.fn().mockResolvedValue(undefined),
  }),
}));

// Mock the scheduler so registerSchedulesWithBoss doesn't hit DB
jest.mock('../../lib/scheduler', () => ({
  registerSchedulesWithBoss: jest.fn().mockResolvedValue(undefined),
  triggerScheduledRun: jest.fn().mockResolvedValue(undefined),
  checkAndFireDueSchedules: jest.fn().mockResolvedValue(undefined),
}));

// Mock merge-handler
jest.mock('../../lib/merge-handler', () => ({
  performMerge: jest.fn().mockResolvedValue({ success: true, mergeCommitSha: 'abc' }),
}));

// Mock simple-git (used by agentic conflict resolution)
jest.mock('simple-git', () => jest.fn().mockReturnValue({}));

// Mock logger to silence output during tests
jest.mock('../../lib/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
  },
}));

// ── Mock DB helpers ───────────────────────────────────────────────────────────

const mockQuery = jest.fn();
const mockExecute = jest.fn();
const mockQueryOne = jest.fn();

jest.mock('../../db/index', () => ({
  initDb: jest.fn().mockResolvedValue(undefined),
  query: (...args: unknown[]) => mockQuery(...args),
  execute: (...args: unknown[]) => mockExecute(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  closePool: jest.fn().mockResolvedValue(undefined),
}));

// ── Import the function under test ────────────────────────────────────────────

import { sweepOrphanProcesses } from '../../worker';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal orphan pipeline_run row */
function makeRun(id: number, pid: number | null, workspaceId = 1) {
  return { id, pid, workspace_id: workspaceId };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sweepOrphanProcesses', () => {
  let processKillSpy: jest.SpyInstance;

  beforeEach(() => {
    // Reset all mock state (implementations + call counts) before each test
    mockQuery.mockReset();
    mockExecute.mockReset();
    mockQueryOne.mockReset();

    // Restore any existing spy before creating a new one
    if (processKillSpy) processKillSpy.mockRestore();

    // Default: process.kill(pid, 0) throws ESRCH (dead process)
    processKillSpy = jest.spyOn(process, 'kill').mockImplementation((_pid, _sig) => {
      if (_sig === 0) {
        const err: NodeJS.ErrnoException = new Error('ESRCH');
        err.code = 'ESRCH';
        throw err;
      }
      return true;
    });

    // Default execute mock: success
    mockExecute.mockResolvedValue({ rowCount: 1 });

    // Default queryOne: not used in sweep, but keep it safe
    mockQueryOne.mockResolvedValue(undefined);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  // ── Happy path: no orphan runs ───────────────────────────────────────────

  test('returns empty array when no orphan runs exist', async () => {
    mockQuery.mockResolvedValueOnce([]); // orphan pipeline_runs query

    const results = await sweepOrphanProcesses();

    expect(results).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled(); // no DB writes needed
  });

  // ── PID is already dead ──────────────────────────────────────────────────

  test('marks run failed and emits WAL even when PID is already dead', async () => {
    const run = makeRun(42, 9999);
    mockQuery
      .mockResolvedValueOnce([run])  // orphan runs
      .mockResolvedValueOnce([]);    // story_results (no incomplete stories)

    // process.kill(9999, 0) throws ESRCH — PID is dead
    processKillSpy.mockImplementation((_pid, _sig) => {
      if (_sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      return true;
    });

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 42, pid: 9999, killed: false, ptyPid: 0, ptyKilled: false });

    // pipeline_runs must be updated
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      expect.arrayContaining([42]),
    );

    // run_finished WAL event emitted
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('wal_events'),
      expect.arrayContaining(['run_finished']),
    );
  });

  // ── PID is alive, SIGTERM is sufficient ──────────────────────────────────

  test('sends SIGTERM and marks killed=true when PID exits within 5s', async () => {
    const ALIVE_PID = 12345;
    const run = makeRun(7, ALIVE_PID);

    mockQuery
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([]); // no incomplete stories

    let killCount = 0;
    processKillSpy.mockImplementation((_pid: number, sig: number | string) => {
      if (sig === 0) {
        // First call (liveness check) → alive; second call (post-SIGTERM) → dead
        killCount++;
        if (killCount <= 1) return true; // alive
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); // dead after SIGTERM
      }
      return true; // SIGTERM / SIGKILL succeed silently
    });

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 7, pid: ALIVE_PID, killed: true, ptyPid: 0, ptyKilled: false });

    // SIGTERM was sent
    expect(processKillSpy).toHaveBeenCalledWith(ALIVE_PID, 'SIGTERM');
    // SIGKILL was NOT sent (process exited after SIGTERM)
    expect(processKillSpy).not.toHaveBeenCalledWith(ALIVE_PID, 'SIGKILL');
  });

  // ── PID is alive, ignores SIGTERM → SIGKILL ──────────────────────────────

  test('sends SIGKILL when process ignores SIGTERM', async () => {
    const STUBBORN_PID = 55555;
    const run = makeRun(99, STUBBORN_PID);

    mockQuery
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([]); // no incomplete stories

    // Process is always alive until explicitly killed
    processKillSpy.mockImplementation((_pid: number, sig: number | string) => {
      if (sig === 0) return true; // always reports alive
      return true; // SIGTERM / SIGKILL silently succeed
    });

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 99, pid: STUBBORN_PID, killed: true });

    // Both SIGTERM and SIGKILL were sent
    expect(processKillSpy).toHaveBeenCalledWith(STUBBORN_PID, 'SIGTERM');
    expect(processKillSpy).toHaveBeenCalledWith(STUBBORN_PID, 'SIGKILL');
  });

  // ── WAL events for incomplete stories ────────────────────────────────────

  test('emits story_failed WAL events for each incomplete story', async () => {
    const run = makeRun(10, null); // pid=null → no kill attempt
    mockQuery
      .mockResolvedValueOnce([run])  // orphan runs
      .mockResolvedValueOnce([      // incomplete stories
        { story_id: 'US-001' },
        { story_id: 'US-002' },
      ]);

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(1);

    // Collect all wal_events INSERT calls
    const walInserts = mockQueryOne.mock.calls.filter(
      ([sql]: [string]) => sql.includes('wal_events'),
    );

    // Should have: run_finished + story_failed×2
    expect(walInserts).toHaveLength(3);

    const eventTypes = walInserts.map(([, params]: [string, string[]]) => params[0]);
    expect(eventTypes).toContain('run_finished');
    expect(eventTypes.filter((t: string) => t === 'story_failed')).toHaveLength(2);
  });

  // ── run_finished payload includes reason:'orphan_sweep' ──────────────────

  test('run_finished WAL event payload contains reason:orphan_sweep and swept_pid', async () => {
    const run = makeRun(20, 7777, 2);
    mockQuery
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([]);

    await sweepOrphanProcesses();

    const walInserts = mockQueryOne.mock.calls.filter(
      ([sql]: [string]) => sql.includes('wal_events'),
    );
    expect(walInserts.length).toBeGreaterThan(0);

    const [, [eventType, workspaceId, _storyId, payloadJson]] = walInserts[0];
    expect(eventType).toBe('run_finished');
    expect(workspaceId).toBe(2);
    const payload = JSON.parse(payloadJson as string);
    expect(payload.reason).toBe('orphan_sweep');
    expect(payload.swept_pid).toBe(7777);
    expect(payload.run_id).toBe(20);
  });

  // ── story_failed payload includes reason:'orphan_sweep' ──────────────────

  test('story_failed WAL event payload contains reason:orphan_sweep and story_id', async () => {
    const run = makeRun(30, null, 5);
    mockQuery
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([{ story_id: 'US-003' }]);

    await sweepOrphanProcesses();

    const walInserts = mockQueryOne.mock.calls.filter(
      ([sql]: [string]) => sql.includes('wal_events'),
    );
    const storyFailedCall = walInserts.find(
      ([, params]: [string, string[]]) => params[0] === 'story_failed',
    );
    expect(storyFailedCall).toBeDefined();
    const [, [, , _storyId, payloadJson]] = storyFailedCall!;
    const payload = JSON.parse(payloadJson as string);
    expect(payload.reason).toBe('orphan_sweep');
    expect(payload.story_id).toBe('US-003');
    expect(payload.run_id).toBe(30);
  });

  // ── Error isolation: one bad run doesn't block the rest ─────────────────

  test('continues sweeping remaining runs when one run throws', async () => {
    const run1 = makeRun(100, null);
    const run2 = makeRun(101, null);

    mockQuery
      .mockResolvedValueOnce([run1, run2]) // orphan runs
      .mockRejectedValueOnce(new Error('DB timeout'))  // story_results for run1 fails
      .mockResolvedValueOnce([]);                       // story_results for run2 succeeds

    // execute fails on the first pipeline_runs UPDATE (run1) only
    mockExecute
      .mockRejectedValueOnce(new Error('connection reset')) // run1 UPDATE fails
      .mockResolvedValue({ rowCount: 1 });                  // run2 succeeds

    // Should not throw
    const results = await sweepOrphanProcesses();

    // run1 errored and is not in results; run2 succeeded
    expect(results).toHaveLength(1);
    expect(results[0].runId).toBe(101);
  });

  // ── Null PID: skips kill, still updates DB ────────────────────────────────

  test('handles null pid gracefully — no kill attempt, run still marked failed', async () => {
    const run = makeRun(200, null);
    mockQuery
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([]);

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 200, pid: 0, killed: false, ptyPid: 0, ptyKilled: false });

    // process.kill was never called
    expect(processKillSpy).not.toHaveBeenCalled();

    // DB update still happened
    expect(mockExecute).toHaveBeenCalledWith(
      expect.stringContaining("status = 'failed'"),
      expect.arrayContaining([200]),
    );
  });

  // ── DB query failure: returns empty array, doesn't throw ─────────────────

  test('returns empty array when orphan runs query fails', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    const results = await sweepOrphanProcesses();

    expect(results).toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── EPERM: treated as dead process (not ours) ────────────────────────────

  test('treats EPERM on liveness check as dead process, skips kill', async () => {
    const run = makeRun(300, 88888);
    mockQuery
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([]);

    processKillSpy.mockImplementation((_pid: number, sig: number | string) => {
      if (sig === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return true;
    });

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ runId: 300, pid: 88888, killed: false, ptyPid: 0, ptyKilled: false });

    // No SIGTERM or SIGKILL sent
    expect(processKillSpy).not.toHaveBeenCalledWith(88888, 'SIGTERM');
    expect(processKillSpy).not.toHaveBeenCalledWith(88888, 'SIGKILL');
  });

  // ── Multiple orphan runs all processed ───────────────────────────────────

  test('processes multiple orphan runs in sequence', async () => {
    const runs = [makeRun(1, null), makeRun(2, null), makeRun(3, null)];
    // One mockResolvedValueOnce per orphan run for story_results
    mockQuery
      .mockResolvedValueOnce(runs)
      .mockResolvedValueOnce([]) // run 1 stories
      .mockResolvedValueOnce([]) // run 2 stories
      .mockResolvedValueOnce([]); // run 3 stories

    const results = await sweepOrphanProcesses();

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.runId)).toEqual([1, 2, 3]);
  });
});
