/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Run-failure watchdog contract tests.
 *
 * The invariant under test: the watchdog never misfires. It restarts a worker
 * only when the heartbeat is stale AND the heartbeating pid is dead, re-drives
 * only worker-interruption failures through the exact governed retry API, and
 * escalates (never silently re-runs) everything else. Single-flight via the
 * advisory lock means a second instance does nothing.
 */

import { startRunFailureWatchdog, startRunFailureWatchdogFromEnv } from '../run-failure-watchdog';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const walEvents: Array<{ eventType: string; payload: string }> = [];

jest.mock('../../db/index', () => {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql);
    if (text.includes('pg_try_advisory_lock')) return [{ ok: true }];
    if (text.includes('pg_advisory_unlock')) return [];
    if (text.includes('FROM worker_heartbeat')) {
      return mockHeartbeatRow ? [{ pid: mockHeartbeatRow.pid, last_seen: mockHeartbeatRow.last_seen }] : [];
    }
    if (text.includes('FROM pipeline_runs') && text.includes("status = 'failed'")) {
      return mockFailedRuns;
    }
    if (text.includes('FROM story_results')) {
      return mockStoryReasons;
    }
    if (text.includes('INSERT INTO wal_events')) {
      walEvents.push({ eventType: String(params[0]), payload: String(params[2]) });
      return [];
    }
    return [];
  });
  const queryOne = jest.fn(async (sql: string, params: unknown[] = []) => {
    const rows = await query(sql, params);
    return rows[0] ?? null;
  });
  return { query, queryOne };
});

jest.mock('../worker-heartbeat', () => {
  return {
    getLatestWorkerHeartbeat: jest.fn(async () => {
      return mockHeartbeatRow ? { ...mockHeartbeatRow } : undefined;
    }),
    isWorkerHeartbeatStale: jest.fn((lastSeen: string, now = Date.now()) => {
      return now - new Date(lastSeen).getTime() > 90_000;
    }),
    WORKER_HEARTBEAT_STALE_MS: 90_000,
  };
});

import { query } from '../../db/index';
import { getLatestWorkerHeartbeat } from '../worker-heartbeat';

let mockHeartbeatRow: { pid: number; last_seen: string } | null = null;
let mockFailedRuns: Array<{ id: number; spec_path: string }> = [];
let mockStoryReasons: Array<{ reason: string | null }> = [];
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

const realFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    fetchCalls.push({ url: String(url), body });
    const urlText = String(url);
    if (urlText.endsWith('/retry') && Object.keys(body).length === 0) {
      // Phase 1 preview
      return new Response(JSON.stringify({
        ok: true,
        preview: {
          previewHash: 'sha256:preview',
          requiresApproval: mockPreviewRequiresApproval,
          scope: { executable: [{ storyId: 'X-001' }] },
        },
        previewIdentity: { schemaVersion: 'retry-preview-identity.v1', previewHash: 'sha256:preview', expiresAt: '2026-08-21T08:00:00Z', signature: 'sha256:sig' },
        worktreePreflight: mockPreviewRequiresApproval ? undefined : { ok: true, classification: 'fresh' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlText.endsWith('/retry')) {
      // Phase 2 dispatch
      return new Response(JSON.stringify({ ok: true, retryRunId: 999 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
});
afterAll(() => {
  global.fetch = realFetch;
});

let mockPreviewRequiresApproval = false;

beforeEach(() => {
  jest.clearAllMocks();
  walEvents.length = 0;
  fetchCalls.length = 0;
  mockHeartbeatRow = null;
  mockFailedRuns = [];
  mockStoryReasons = [];
  mockPreviewRequiresApproval = false;
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const BASE = { apiBaseUrl: 'http://127.0.0.1:3030', backendRoot: '/backend' };

function runSweep(opts: Record<string, unknown> = {}) {
  const handle = startRunFailureWatchdog({
    ...BASE,
    dryRun: true,
    intervalMs: 60_000,
    ...opts,
  });
  handle.stop();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('run-failure-watchdog', () => {
  it('does nothing when the worker heartbeat is fresh', async () => {
    mockHeartbeatRow = { pid: 4242, last_seen: new Date(Date.now() - 10_000).toISOString() };
    mockFailedRuns = [];
    runSweep({ autoRestartWorker: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getLatestWorkerHeartbeat).toHaveBeenCalled();
    expect(walEvents.filter((e) => e.eventType.startsWith('watchdog_'))).toEqual([]);
  });

  it('restarts the worker only when the heartbeat is stale AND the pid is dead', async () => {
    mockHeartbeatRow = { pid: 999_999, last_seen: new Date(Date.now() - 300_000).toISOString() };
    mockFailedRuns = [];
    runSweep({ autoRestartWorker: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const restarts = walEvents.filter((e) => e.eventType === 'watchdog_worker_restarted');
    expect(restarts).toHaveLength(1);
    expect(JSON.parse(restarts[0].payload).reason).toBe('stale_heartbeat');
  });

  it('does not restart when the heartbeating pid is still alive (hung worker)', async () => {
    mockHeartbeatRow = { pid: process.pid, last_seen: new Date(Date.now() - 300_000).toISOString() };
    mockFailedRuns = [];
    runSweep({ autoRestartWorker: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(walEvents.filter((e) => e.eventType === 'watchdog_worker_restarted')).toEqual([]);
  });

  it('re-drives a worker-interrupted failed run through the two-phase governed retry', async () => {
    mockHeartbeatRow = { pid: 4242, last_seen: new Date().toISOString() };
    mockFailedRuns = [{ id: 77, spec_path: 'forge/specs/approved/s.json' }];
    mockStoryReasons = [{ reason: 'engine_interrupted' }, { reason: 'engine_exit_incomplete' }];
    runSweep({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0].url).toContain('/api/pipeline/runs/77/retry');
    expect(Object.keys(fetchCalls[1].body as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['previewHash', 'approvedPreview', 'previewIdentity']),
    );
    const redriven = walEvents.filter((e) => e.eventType === 'watchdog_run_redriven');
    expect(redriven).toHaveLength(1);
    expect(JSON.parse(redriven[0].payload).runId).toBe(77);
  });

  it('escalates non-auto failures instead of re-running them', async () => {
    mockHeartbeatRow = { pid: 4242, last_seen: new Date().toISOString() };
    mockFailedRuns = [{ id: 78, spec_path: 'forge/specs/approved/s.json' }];
    mockStoryReasons = [{ reason: 'test_failure' }, { reason: 'merge_conflict' }];
    runSweep({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toHaveLength(0);
    const escalated = walEvents.filter((e) => e.eventType === 'watchdog_escalated');
    expect(escalated).toHaveLength(1);
    expect(JSON.parse(escalated[0].payload).reasonCode).toBe('non_auto_redrive_failure');
  });

  it('escalates when the governed retry preview requires approval', async () => {
    mockHeartbeatRow = { pid: 4242, last_seen: new Date().toISOString() };
    mockFailedRuns = [{ id: 79, spec_path: 'forge/specs/approved/s.json' }];
    mockStoryReasons = [{ reason: 'worker_shutdown' }];
    mockPreviewRequiresApproval = true;
    runSweep({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toHaveLength(1); // preview only, no dispatch
    const escalated = walEvents.filter((e) => e.eventType === 'watchdog_escalated');
    expect(escalated).toHaveLength(1);
    expect(JSON.parse(escalated[0].payload).reasonCode).toBe('governed_retry_requires_approval');
  });

  it('does nothing when the advisory lock is held by another instance', async () => {
    (query as jest.Mock).mockImplementationOnce(async (sql: string) => {
      if (String(sql).includes('pg_try_advisory_lock')) return [{ ok: false }];
      return [];
    });
    mockFailedRuns = [{ id: 80, spec_path: 'forge/specs/approved/s.json' }];
    mockStoryReasons = [{ reason: 'engine_interrupted' }];
    runSweep({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchCalls).toHaveLength(0);
    expect(walEvents.filter((e) => e.eventType.startsWith('watchdog_'))).toEqual([]);
  });

  it('is disabled in test environments via the env factory', async () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(startRunFailureWatchdogFromEnv(3030)).toBeNull();
    } finally {
      process.env.NODE_ENV = previousEnv;
    }
  });
});
