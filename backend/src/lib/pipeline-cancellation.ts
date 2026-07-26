/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PoolClient } from 'pg';
import { query, transaction } from '../db/index';
import { ConflictError } from './errors';

export interface CancellationChild {
  kill(signal: NodeJS.Signals): unknown;
}

export interface CancellationProcessSnapshot {
  child: CancellationChild | null;
  enginePid: number | null;
  ptyPid: number | null;
}

export async function quiesceCancellationProcesses(input: {
  read: () => Promise<CancellationProcessSnapshot>;
  signalPid: (pid: number, signal: NodeJS.Signals) => void;
  signalPty: (pid: number, signal: NodeJS.Signals) => void;
  isPidAlive: (pid: number | null) => boolean;
  wait?: (ms: number) => Promise<void>;
  graceMs?: number;
  settleMs?: number;
}): Promise<{ quiescent: boolean; observations: number; final: CancellationProcessSnapshot }> {
  const wait = input.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const graceMs = Math.max(0, Math.trunc(input.graceMs ?? 5_000));
  const settleMs = Math.max(0, Math.trunc(input.settleMs ?? 100));
  let observations = 0;
  const read = async () => {
    observations += 1;
    return input.read();
  };
  const signal = (snapshot: CancellationProcessSnapshot, signalName: NodeJS.Signals) => {
    if (snapshot.child) {
      try { snapshot.child.kill(signalName); } catch { /* process already exited */ }
    }
    if (input.isPidAlive(snapshot.enginePid)) {
      try { input.signalPid(snapshot.enginePid!, signalName); } catch { /* process already exited */ }
    }
    if (input.isPidAlive(snapshot.ptyPid)) {
      try { input.signalPty(snapshot.ptyPid!, signalName); } catch { /* process group already exited */ }
    }
  };

  const initial = await read();
  signal(initial, 'SIGTERM');
  await wait(graceMs);

  // Re-read every source after the grace period. A child/PID can be registered
  // after cancellation intent commits but before launch-gate release.
  const afterGrace = await read();
  signal(afterGrace, 'SIGTERM');
  signal(afterGrace, 'SIGKILL');
  await wait(settleMs);

  const final = await read();
  const quiescent = final.child === null
    && !input.isPidAlive(final.enginePid)
    && !input.isPidAlive(final.ptyPid);
  return { quiescent, observations, final };
}

export async function releaseLaunchGateWithCancellationFence(input: {
  runId: number;
  owner: string;
  fence: string;
  release: () => boolean;
}): Promise<'released' | 'cancellation_requested' | 'stale_owner' | 'release_failed'> {
  return transaction(async (client: PoolClient) => {
    const run = (await client.query<{
      status: string;
      dispatch_owner: string | null;
      dispatch_fence: string | null;
    }>(
      `SELECT status, dispatch_owner, dispatch_fence
         FROM pipeline_runs WHERE id = $1 FOR UPDATE`,
      [input.runId],
    )).rows[0];
    if (!run || run.status !== 'running'
      || run.dispatch_owner !== input.owner || run.dispatch_fence !== input.fence) {
      return 'stale_owner';
    }
    const cancellation = (await client.query<{ run_id: number }>(
      `SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id = $1 FOR UPDATE`,
      [input.runId],
    )).rows[0];
    if (cancellation) return 'cancellation_requested';
    return input.release() ? 'released' : 'release_failed';
  });
}

export async function reconcilePendingCancellationRequests(input: {
  limit?: number;
  reconcile: (runId: number) => Promise<{ quiescent: boolean }>;
}): Promise<{ scanned: number; pending: number }> {
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)));
  const rows = await query<{ run_id: number }>(
    `SELECT cancellation.run_id
       FROM pipeline_run_cancellation_requests cancellation
       JOIN pipeline_runs run ON run.id = cancellation.run_id
       LEFT JOIN governed_retry_dispatches retry ON retry.retry_run_id = run.id
      WHERE cancellation.terminalized_at IS NULL
        AND retry.retry_run_id IS NULL
      ORDER BY cancellation.requested_at, cancellation.run_id
      LIMIT $1`,
    [limit],
  );
  let pending = 0;
  for (const row of rows) {
    const result = await input.reconcile(Number(row.run_id));
    if (!result.quiescent) pending += 1;
  }
  return { scanned: rows.length, pending };
}

export type CanonicalCancellationOutcome =
  | 'terminalized'
  | 'already_terminal'
  | 'needs_process_quiescence'
  | 'no_intent'
  | 'superseded_terminal';

export interface CanonicalCancellationResult {
  outcome: CanonicalCancellationOutcome;
  runId: number;
  workspaceId: string | null;
  priorStatus: string | null;
}

async function bindCancellationTerminalMetadata(
  client: PoolClient,
  input: { runId: number; workspaceId: string; source: string; priorStatus: string },
): Promise<void> {
  await client.query(
    `UPDATE pipeline_dispatch_publications
        SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
      WHERE run_id = $1 AND state NOT IN ('completed','failed')`,
    [input.runId],
  );
  await client.query(
    `UPDATE pipeline_run_cancellation_requests
        SET terminalized_at = COALESCE(terminalized_at, NOW())
      WHERE run_id = $1`,
    [input.runId],
  );
  await client.query(
    `INSERT INTO wal_events (
       event_type, workspace_id, payload, ingest_key
     ) VALUES ('run_cancelled', $1, $2::jsonb, $3)
     ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING`,
    [
      input.workspaceId,
      JSON.stringify({
        run_id: input.runId,
        cancelledAt: new Date().toISOString(),
        source: input.source,
        prior_status: input.priorStatus,
        application_cancellation_authority: true,
      }),
      `pipeline-cancellation:${input.runId}`,
    ],
  );
}

/**
 * Canonical application-state cancellation terminalizer. The caller may set
 * processQuiescent only after re-reading worker child, durable engine PID, and
 * PTY process state. Queued rows have no process and can terminalize directly.
 */
export async function terminalizeCanonicalCancellation(input: {
  runId: number;
  source: string;
  processQuiescent: boolean;
}): Promise<CanonicalCancellationResult> {
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    throw new ConflictError('Cancellation run identity is invalid');
  }
  return transaction(async (client: PoolClient) => {
    const run = (await client.query<{
      workspace_id: string;
      status: string;
      pid: number | null;
      pty_active: boolean;
    }>(
      `SELECT run.workspace_id, run.status, run.pid,
              EXISTS (
                SELECT 1 FROM run_pty_sessions pty
                 WHERE pty.run_id = run.id AND pty.status IN ('starting','active')
              ) AS pty_active
         FROM pipeline_runs run
        WHERE run.id = $1
        FOR UPDATE OF run`,
      [input.runId],
    )).rows[0];
    if (!run) return { outcome: 'no_intent', runId: input.runId, workspaceId: null, priorStatus: null };
    const cancellation = (await client.query<{ terminalized_at: Date | string | null }>(
      `SELECT terminalized_at FROM pipeline_run_cancellation_requests
        WHERE run_id = $1 FOR UPDATE`,
      [input.runId],
    )).rows[0];
    if (!cancellation) {
      return { outcome: 'no_intent', runId: input.runId, workspaceId: run.workspace_id, priorStatus: run.status };
    }
    if (run.status === 'cancelled') {
      await bindCancellationTerminalMetadata(client, {
        runId: input.runId,
        workspaceId: run.workspace_id,
        source: input.source,
        priorStatus: run.status,
      });
      return { outcome: 'already_terminal', runId: input.runId, workspaceId: run.workspace_id, priorStatus: run.status };
    }
    if (['done', 'failed', 'partial_failure'].includes(run.status)) {
      await client.query(
        `UPDATE pipeline_run_cancellation_requests
            SET terminalized_at = COALESCE(terminalized_at, NOW()) WHERE run_id = $1`,
        [input.runId],
      );
      return { outcome: 'superseded_terminal', runId: input.runId, workspaceId: run.workspace_id, priorStatus: run.status };
    }
    const processMayExist = ['starting', 'running', 'paused', 'pi_native'].includes(run.status)
      || run.pid !== null || run.pty_active;
    if (processMayExist && !input.processQuiescent) {
      return { outcome: 'needs_process_quiescence', runId: input.runId, workspaceId: run.workspace_id, priorStatus: run.status };
    }
    const terminalized = await client.query(
      `UPDATE pipeline_runs
          SET status = 'cancelled', lifecycle_status = 'cancelled', lifecycle_updated_at = NOW(),
              finished_at = COALESCE(finished_at, NOW()), pid = NULL, worker_id = NULL,
              dispatch_owner = NULL, dispatch_lease_expires_at = NULL, queue_position = NULL
        WHERE id = $1 AND status NOT IN ('done','failed','partial_failure','cancelled')
        RETURNING id`,
      [input.runId],
    );
    if (terminalized.rowCount !== 1) {
      throw new ConflictError('Cancellation terminalizer lost canonical run authority');
    }
    await client.query(
      `UPDATE run_pty_sessions
          SET status = 'killed', exit_signal = COALESCE(exit_signal, 'SIGTERM'),
              exited_at = COALESCE(exited_at, NOW()), updated_at = NOW()
        WHERE run_id = $1 AND status IN ('starting','active')`,
      [input.runId],
    );
    await bindCancellationTerminalMetadata(client, {
      runId: input.runId,
      workspaceId: run.workspace_id,
      source: input.source,
      priorStatus: run.status,
    });
    return { outcome: 'terminalized', runId: input.runId, workspaceId: run.workspace_id, priorStatus: run.status };
  });
}
