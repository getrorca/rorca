/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne, execute } from '../db/index';
import { ConflictError, NotFoundError, ServiceUnavailableError } from './errors';
import { revalidatePersistedWavePolicy } from './wave-production-governance';
import type { WavePolicyEnvelope } from './wave-production-policy';

export interface RunnerJobRow {
  id: string;
  run_id: number;
  environment_id: string;
  status: 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  payload: Record<string, unknown> | string;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  result: Record<string, unknown> | string | null;
  error: string | null;
}

function parsePayload(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return value;
}

function parseNullableObject(value: Record<string, unknown> | string | null): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}

export function serializeRunnerJob(row: RunnerJobRow) {
  return {
    id: row.id,
    runId: Number(row.run_id),
    environmentId: row.environment_id,
    status: row.status,
    payload: parsePayload(row.payload),
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at ? new Date(row.claimed_at).toISOString() : null,
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    result: parseNullableObject(row.result),
    error: row.error,
  };
}

export async function createRunnerJob(input: {
  runId: number;
  environmentId: string;
  payload: Record<string, unknown>;
}): Promise<RunnerJobRow> {
  const row = await queryOne<RunnerJobRow>(
    `INSERT INTO execution_runner_jobs (run_id, environment_id, payload, status)
     VALUES ($1, $2, $3::jsonb, 'queued')
     ON CONFLICT (run_id) DO UPDATE SET
       environment_id = EXCLUDED.environment_id,
       payload = EXCLUDED.payload,
       status = 'queued',
       claimed_by = NULL,
       claimed_at = NULL,
       started_at = NULL,
       completed_at = NULL,
       result = NULL,
       error = NULL,
       updated_at = NOW()
     RETURNING *`,
    [input.runId, input.environmentId, JSON.stringify(input.payload)],
  );
  return row!;
}

export async function claimNextRunnerJob(environmentId: string, runnerId: string): Promise<RunnerJobRow | null> {
  const row = await queryOne<RunnerJobRow>(
    `WITH next_job AS (
       SELECT id
       FROM execution_runner_jobs
       WHERE environment_id = $1 AND status = 'queued'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE execution_runner_jobs j
        SET status = 'claimed', claimed_by = $2, claimed_at = NOW(), updated_at = NOW()
       FROM next_job
      WHERE j.id = next_job.id
      RETURNING j.*`,
    [environmentId, runnerId],
  );
  if (row) {
    await execute(`UPDATE pipeline_runs SET status = 'queued', last_heartbeat = NOW() WHERE id = $1`, [row.run_id]);
  }
  return row ?? null;
}

export async function markRunnerJobRunning(jobId: string, runnerId: string): Promise<RunnerJobRow> {
  const row = await queryOne<RunnerJobRow>(
    `UPDATE execution_runner_jobs
        SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2 AND status IN ('claimed', 'running')
      RETURNING *`,
    [jobId, runnerId],
  );
  if (!row) throw new NotFoundError('Runner job', jobId);
  await execute(`UPDATE pipeline_runs SET status = 'running', started_at = COALESCE(started_at, NOW()), last_heartbeat = NOW() WHERE id = $1`, [row.run_id]);
  return row;
}

export async function revalidateRunnerJobPolicy(jobId: string, runnerId: string): Promise<WavePolicyEnvelope> {
  const row = await queryOne<RunnerJobRow>(
    `SELECT * FROM execution_runner_jobs
      WHERE id = $1 AND claimed_by = $2 AND status IN ('claimed', 'running')`,
    [jobId, runnerId],
  );
  if (!row) throw new NotFoundError('Runner job', jobId);
  const payload = parsePayload(row.payload);
  try {
    return await revalidatePersistedWavePolicy({ runId: Number(row.run_id), queueEnvelope: payload.wavePolicy });
  } catch (error) {
    await execute(
      `UPDATE execution_runner_jobs
          SET status = 'cancelled', completed_at = NOW(), error = 'wave_policy_revalidation_denied', updated_at = NOW()
        WHERE id = $1`,
      [jobId],
    );
    await execute(
      `UPDATE pipeline_runs SET status = 'cancelled', finished_at = NOW(), summary = 'wave_policy_revalidation_denied' WHERE id = $1`,
      [row.run_id],
    );
    throw error;
  }
}

export async function completeRunnerJob(input: {
  jobId: string;
  runnerId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;
  error?: string;
}): Promise<RunnerJobRow> {
  // local-user is retired until a signed host closeout/release protocol exists.
  // Historical transport success must converge to a truthful terminal failure,
  // never a stable release_pending run that no host can close.
  const pipelineStatus = input.status === 'cancelled' ? 'cancelled' : 'failed';
  const row = await queryOne<RunnerJobRow>(
    `UPDATE execution_runner_jobs
        SET status = $3,
            completed_at = NOW(),
            result = $4::jsonb,
            error = $5,
            updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2 AND status IN ('claimed', 'running')
      RETURNING *`,
    [input.jobId, input.runnerId, input.status, JSON.stringify(input.result ?? {}), input.error ?? null],
  );
  if (!row) throw new NotFoundError('Runner job', input.jobId);
  await execute(
    `UPDATE pipeline_runs
        SET status = $2,
            finished_at = NOW(),
            last_heartbeat = NOW(),
            summary = CASE WHEN $3 = 'succeeded'
              THEN 'local_user_execution_unavailable'
              ELSE summary
            END
      WHERE id = $1`,
    [row.run_id, pipelineStatus, input.status],
  );
  return row;
}

export async function cancelRunnerJobForRun(runId: number): Promise<void> {
  const row = await queryOne<{ id: string; status: string }>(`SELECT id, status FROM execution_runner_jobs WHERE run_id = $1`, [runId]);
  if (!row) return;
  if (!['queued', 'claimed', 'running'].includes(row.status)) {
    throw new ConflictError(`runner_job_not_cancellable:${row.status}`);
  }
  await execute(
    `UPDATE execution_runner_jobs SET status = 'cancelled', completed_at = NOW(), updated_at = NOW() WHERE run_id = $1`,
    [runId],
  );
}

export async function assertNoActiveRunnerJob(environmentId: string, maxConcurrency: number): Promise<void> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM execution_runner_jobs
      WHERE environment_id = $1 AND status IN ('claimed', 'running')`,
    [environmentId],
  );
  if (Number(row?.count ?? '0') >= maxConcurrency) {
    throw new ServiceUnavailableError('execution_runner_concurrency_exceeded');
  }
}
