/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Canonical PostgreSQL ownership for governed retry worker/process launch. */
import type { PoolClient } from 'pg';
import { transaction } from '../db/index';
import { ConflictError } from './errors';
import { retryHash } from './retry-governance';
import { assertNotProtectedWave1Run } from './wave-1-stabilization';

async function lockRunFence(client: PoolClient, runId: number): Promise<void> {
  assertNotProtectedWave1Run(runId);
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`pipeline-run-authority:${runId}`],
  );
}

export interface GovernedRetryLeaseClaim {
  fencingToken: number;
  state: string;
  hostAttemptFence: string;
}

export async function claimGovernedRetryExecutionLease(input: {
  runId: number;
  previewHash: string;
  dispatchIdentityHash: string;
  leaseOwner: string;
}): Promise<GovernedRetryLeaseClaim | undefined> {
  assertNotProtectedWave1Run(input.runId);
  return transaction(async (client) => {
    await lockRunFence(client, input.runId);
    const preview = (await client.query<{ status: string; preparation_state: string }>(`
      SELECT status,preparation_state FROM pipeline_retry_previews
       WHERE preview_hash=$1 AND retry_run_id=$2 FOR UPDATE
    `, [input.previewHash, input.runId])).rows[0];
    const dispatch = (await client.query<{ state: string; cancellation_requested_at: Date | string | null }>(`
      SELECT state,cancellation_requested_at FROM governed_retry_dispatches
       WHERE identity_hash=$1 AND retry_run_id=$2 FOR UPDATE
    `, [input.dispatchIdentityHash, input.runId])).rows[0];
    const run = (await client.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (preview?.status !== 'dispatched' || preview.preparation_state !== 'published'
      || !dispatch || dispatch.state === 'cancelled' || dispatch.cancellation_requested_at
      || !['queued', 'running'].includes(run?.status ?? '') || cancellation) return undefined;
    const claimed = await client.query<{ fencing_token: string | number; state: string }>(`
      UPDATE governed_retry_dispatches
         SET state=CASE WHEN state='dispatched' THEN 'claimed' ELSE state END,
             fencing_token=CASE WHEN state='dispatched' THEN fencing_token ELSE fencing_token+1 END,
             lease_owner=$2,lease_expires_at=NOW()+INTERVAL '5 minutes'
       WHERE identity_hash=$1 AND retry_run_id=$3
         AND (state='dispatched' OR (state IN ('claimed','executing') AND lease_expires_at<=NOW()))
         AND cancellation_requested_at IS NULL
       RETURNING fencing_token,state
    `, [input.dispatchIdentityHash, input.leaseOwner, input.runId]);
    const row = claimed.rows[0];
    if (!row) return undefined;
    const fencingToken = Number(row.fencing_token);
    const hostAttemptFence = retryHash({
      dispatchIdentity: input.dispatchIdentityHash,
      fencingToken,
      leaseOwner: input.leaseOwner,
    });
    const fencedRun = await client.query(`
      UPDATE pipeline_runs SET dispatch_fence=$2
       WHERE id=$1 AND status IN ('queued','running')
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_run_cancellation_requests cancellation
            WHERE cancellation.run_id=pipeline_runs.id
         )
       RETURNING id
    `, [input.runId, hostAttemptFence]);
    if (fencedRun.rowCount !== 1) {
      throw new ConflictError('Governed retry lease could not fence the canonical run generation');
    }
    return { fencingToken, state: row.state, hostAttemptFence };
  });
}

export async function markGovernedRetryLeaseExecuting(input: {
  runId: number;
  dispatchIdentityHash: string;
  fencingToken: number;
  leaseOwner: string;
}): Promise<boolean> {
  assertNotProtectedWave1Run(input.runId);
  return transaction(async (client) => {
    await lockRunFence(client, input.runId);
    const run = (await client.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (!['queued', 'running'].includes(run?.status ?? '') || cancellation) return false;
    const result = await client.query(`
      UPDATE governed_retry_dispatches SET state='executing'
       WHERE identity_hash=$1 AND retry_run_id=$4 AND fencing_token=$2 AND lease_owner=$3
         AND state IN ('claimed','executing') AND cancellation_requested_at IS NULL
    `, [input.dispatchIdentityHash, input.fencingToken, input.leaseOwner, input.runId]);
    if (result.rowCount !== 1) return false;
    await client.query(`UPDATE governed_retry_story_attempts SET state='executing'
      WHERE dispatch_identity_hash=$1 AND state='pending'`, [input.dispatchIdentityHash]);
    return true;
  });
}

export async function bindGovernedRetryProcessLaunch(input: {
  runId: number;
  dispatchIdentityHash: string;
  fencingToken: number;
  leaseOwner: string;
  launchTokenHash: string;
  pid: number;
  workerId: string;
  expectedPriorPid?: number | null;
}): Promise<boolean> {
  assertNotProtectedWave1Run(input.runId);
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) throw new ConflictError('Retry launch PID is invalid');
  return transaction(async (client) => {
    await lockRunFence(client, input.runId);
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (cancellation) return false;
    // Bind the canonical run first. A stale PID/generation therefore returns
    // without partially replacing durable dispatch launch identity. If the
    // dispatch CAS then loses its fence, throwing rolls both writes back.
    const run = await client.query(`
      UPDATE pipeline_runs SET pid=$1,status='running',started_at=COALESCE(started_at,NOW()),worker_id=$3
       WHERE id=$2
         AND (status='queued' OR (status='running' AND pid IS NOT DISTINCT FROM $4::integer))
         AND NOT EXISTS (
           SELECT 1 FROM pipeline_run_cancellation_requests cancellation
            WHERE cancellation.run_id=pipeline_runs.id
         )
       RETURNING id
    `, [input.pid, input.runId, input.workerId, input.expectedPriorPid ?? null]);
    if (run.rowCount !== 1) return false;
    const dispatch = await client.query(`
      UPDATE governed_retry_dispatches
         SET launch_token_hash=$4,launch_pid=$5
       WHERE identity_hash=$1 AND fencing_token=$2 AND lease_owner=$3
         AND retry_run_id=$6 AND state='executing' AND cancellation_requested_at IS NULL
    `, [input.dispatchIdentityHash, input.fencingToken, input.leaseOwner,
      input.launchTokenHash, input.pid, input.runId]);
    if (dispatch.rowCount !== 1) {
      throw new ConflictError('Governed retry process launch lost its dispatch generation');
    }
    return true;
  });
}

export async function renewGovernedRetryExecutionLease(input: {
  runId: number;
  dispatchIdentityHash: string;
  fencingToken: number;
  leaseOwner: string;
}): Promise<boolean> {
  assertNotProtectedWave1Run(input.runId);
  return transaction(async (client) => {
    await lockRunFence(client, input.runId);
    const run = (await client.query<{ status: string }>(
      'SELECT status FROM pipeline_runs WHERE id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    const cancellation = (await client.query<{ run_id: number }>(
      'SELECT run_id FROM pipeline_run_cancellation_requests WHERE run_id=$1 FOR UPDATE', [input.runId],
    )).rows[0];
    if (!['queued', 'running'].includes(run?.status ?? '') || cancellation) return false;
    const result = await client.query(`
      UPDATE governed_retry_dispatches SET lease_expires_at=NOW()+INTERVAL '5 minutes'
       WHERE identity_hash=$1 AND retry_run_id=$4 AND fencing_token=$2 AND lease_owner=$3
         AND state='executing' AND cancellation_requested_at IS NULL
    `, [input.dispatchIdentityHash, input.fencingToken, input.leaseOwner, input.runId]);
    return result.rowCount === 1;
  });
}
