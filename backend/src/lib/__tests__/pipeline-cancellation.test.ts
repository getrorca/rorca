/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { execute, queryOne } from '../../db/index';
import { claimDispatchPublication } from '../dispatch-publication';
import { advanceClaimedWaveDispatch } from '../wave-production-governance';
import {
  quiesceCancellationProcesses,
  reconcilePendingCancellationRequests,
  releaseLaunchGateWithCancellationFence,
  terminalizeCanonicalCancellation,
  type CancellationProcessSnapshot,
} from '../pipeline-cancellation';

const WORKSPACE_ID = 'ws-canonical-cancellation';

beforeEach(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Cancellation test', '/tmp/rorca-cancellation-test')
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label`,
    [WORKSPACE_ID],
  );
});

afterAll(async () => {
  await execute('DELETE FROM pipeline_runs WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
});

async function seedCancellation(status: 'queued' | 'starting' = 'queued') {
  const run = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type, branch_name)
     VALUES ('forge/specs/approved/cancel.json', $1, $2, 'manual', 'main') RETURNING id`,
    [WORKSPACE_ID, status],
  );
  await execute(
    `INSERT INTO pipeline_run_cancellation_requests (run_id, workspace_id, requested_by, reason)
     VALUES ($1, $2, 'operator', 'adversarial_test')`,
    [run!.id, WORKSPACE_ID],
  );
  return Number(run!.id);
}

test('queued-before-preparation cancellation terminalizes application run and publication exactly once without transport', async () => {
  const runId = await seedCancellation('queued');
  const first = await terminalizeCanonicalCancellation({
    runId,
    source: 'api_queued',
    processQuiescent: true,
  });
  const replay = await terminalizeCanonicalCancellation({
    runId,
    source: 'restart_replay',
    processQuiescent: true,
  });

  expect(first).toMatchObject({ outcome: 'terminalized', runId, workspaceId: WORKSPACE_ID });
  expect(replay).toMatchObject({ outcome: 'already_terminal', runId, workspaceId: WORKSPACE_ID });
  await expect(queryOne(
    `SELECT run.status, run.lifecycle_status, publication.state AS publication_state,
            cancellation.terminalized_at
       FROM pipeline_runs run
       JOIN pipeline_dispatch_publications publication ON publication.run_id = run.id
       JOIN pipeline_run_cancellation_requests cancellation ON cancellation.run_id = run.id
      WHERE run.id = $1`,
    [runId],
  )).resolves.toMatchObject({
    status: 'cancelled',
    lifecycle_status: 'cancelled',
    publication_state: 'cancelled',
    terminalized_at: expect.anything(),
  });
  await expect(queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM wal_events
      WHERE ingest_key = $1 AND event_type = 'run_cancelled'`,
    [`pipeline-cancellation:${runId}`],
  )).resolves.toEqual({ count: '1' });
});

test('restart scanner recovers unterminated cancellation intent without a notification', async () => {
  const runId = await seedCancellation('queued');
  const result = await reconcilePendingCancellationRequests({
    reconcile: async (candidateRunId) => {
      const terminal = await terminalizeCanonicalCancellation({
        runId: candidateRunId,
        source: 'restart_test',
        processQuiescent: true,
      });
      return { quiescent: ['terminalized', 'already_terminal'].includes(terminal.outcome) };
    },
  });

  expect(result).toMatchObject({ scanned: 1, pending: 0 });
  expect(runId).toBeGreaterThan(0);
  await expect(queryOne<{ status: string }>('SELECT status FROM pipeline_runs WHERE id = $1', [runId]))
    .resolves.toEqual({ status: 'cancelled' });
});

test('starting owner cannot be terminalized until process quiescence is proved', async () => {
  const runId = await seedCancellation('starting');
  await execute(
    `UPDATE pipeline_runs SET dispatch_owner = 'worker-a', pid = 424242 WHERE id = $1`,
    [runId],
  );
  await expect(terminalizeCanonicalCancellation({
    runId,
    source: 'concurrent_cancel',
    processQuiescent: false,
  })).resolves.toMatchObject({ outcome: 'needs_process_quiescence' });
  await expect(queryOne<{ status: string }>('SELECT status FROM pipeline_runs WHERE id = $1', [runId]))
    .resolves.toEqual({ status: 'starting' });
});

test('cancellation fences publication claim, lifecycle advance, and post-spawn launch-gate release', async () => {
  const queuedRunId = await seedCancellation('queued');
  await expect(claimDispatchPublication({
    runId: queuedRunId,
    workspaceId: WORKSPACE_ID,
  })).rejects.toThrow('fenced by cancellation intent');

  const startingRunId = await seedCancellation('starting');
  const owner = '11111111-1111-4111-8111-111111111997';
  const fence = `sha256:${'d'.repeat(64)}`;
  await execute(
    `UPDATE pipeline_runs
        SET dispatch_owner = $2, dispatch_fence = $3,
            dispatch_lease_expires_at = NOW() + INTERVAL '5 minutes'
      WHERE id = $1`,
    [startingRunId, owner, fence],
  );
  await expect(advanceClaimedWaveDispatch({
    runId: startingRunId,
    owner,
    fence,
    lifecycle: 'running',
  })).resolves.toBe(false);

  await execute(`UPDATE pipeline_runs SET status = 'running' WHERE id = $1`, [startingRunId]);
  const release = jest.fn(() => true);
  await expect(releaseLaunchGateWithCancellationFence({
    runId: startingRunId,
    owner,
    fence,
    release,
  })).resolves.toBe('cancellation_requested');
  expect(release).not.toHaveBeenCalled();
});

test('process quiescence re-reads child, durable PID, and PTY after grace before terminal authority', async () => {
  const lateChild = { kill: jest.fn() };
  const snapshots: CancellationProcessSnapshot[] = [
    { child: null, enginePid: null, ptyPid: null },
    { child: lateChild, enginePid: 424242, ptyPid: 434343 },
    { child: null, enginePid: null, ptyPid: null },
  ];
  const read = jest.fn(async () => snapshots.shift() ?? { child: null, enginePid: null, ptyPid: null });
  const signalPid = jest.fn();
  const signalPty = jest.fn();
  const wait = jest.fn(async () => undefined);

  const result = await quiesceCancellationProcesses({
    read,
    signalPid,
    signalPty,
    isPidAlive: (pid) => pid === 424242 || pid === 434343,
    wait,
    graceMs: 1,
    settleMs: 1,
  });

  expect(result).toMatchObject({ quiescent: true, observations: 3 });
  expect(read).toHaveBeenCalledTimes(3);
  expect(lateChild.kill).toHaveBeenCalledWith('SIGTERM');
  expect(lateChild.kill).toHaveBeenCalledWith('SIGKILL');
  expect(signalPid).toHaveBeenCalledWith(424242, 'SIGTERM');
  expect(signalPid).toHaveBeenCalledWith(424242, 'SIGKILL');
  expect(signalPty).toHaveBeenCalledWith(434343, 'SIGTERM');
  expect(signalPty).toHaveBeenCalledWith(434343, 'SIGKILL');
});
