/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne } from '../db/index';
import { logger } from './logger';

const CHUNK_SIZE = 4 * 1024;

export interface RunPtyChunkRow {
  sequence: number;
  chunk: Buffer;
}

export interface RunPtyResizeRequest {
  id: number;
  cols: number;
  rows: number;
}

export interface StartRunPtySessionParams {
  runId: number;
  workspaceId: string;
  cwd: string;
  agentType: string;
  cols: number;
  rows: number;
  childPid: number | null;
}

export async function startRunPtySession(params: StartRunPtySessionParams): Promise<void> {
  await execute(
    `INSERT INTO run_pty_sessions
      (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW(), NOW())
     ON CONFLICT (run_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       cwd = EXCLUDED.cwd,
       agent_type = EXCLUDED.agent_type,
       cols = EXCLUDED.cols,
       rows = EXCLUDED.rows,
       child_pid = EXCLUDED.child_pid,
       status = 'active',
       exit_code = NULL,
       exit_signal = NULL,
       exited_at = NULL,
       updated_at = NOW()`,
    [params.runId, params.workspaceId, params.cwd, params.agentType, params.cols, params.rows, params.childPid],
  );
}

export async function updateRunPtyDimensions(runId: number, cols: number, rows: number): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions SET cols = $2, rows = $3, updated_at = NOW() WHERE run_id = $1`,
    [runId, cols, rows],
  );
}

export async function appendRunPtyOutput(
  runId: number,
  data: Buffer,
  sequenceRef: { value: number },
): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const slice = data.subarray(offset, offset + CHUNK_SIZE);
    await execute(
      `INSERT INTO run_pty_output_chunks (run_id, sequence, chunk)
       VALUES ($1, $2, $3)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, sequenceRef.value, slice],
    );
    sequenceRef.value += 1;
    offset += CHUNK_SIZE;
  }

  await execute(
    `UPDATE run_pty_sessions
     SET total_output_bytes = total_output_bytes + $2,
         last_output_at = NOW(),
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, data.length],
  );
}

export async function completeRunPtySession(
  runId: number,
  status: 'exited' | 'killed' | 'failed' | 'timed_out',
  exitCode: number | null,
  exitSignal: string | null,
): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET status = $2,
         exit_code = $3,
         exit_signal = $4,
         exited_at = NOW(),
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, status, exitCode, exitSignal],
  );
}

export async function requestRunPtyResize(runId: number, cols: number, rows: number): Promise<void> {
  await execute(
    `INSERT INTO run_pty_resize_requests (run_id, cols, rows) VALUES ($1, $2, $3)`,
    [runId, cols, rows],
  );
  await updateRunPtyDimensions(runId, cols, rows);
}

export async function claimLatestRunPtyResize(runId: number): Promise<RunPtyResizeRequest | null> {
  const latest = await queryOne<RunPtyResizeRequest>(
    `SELECT id, cols, rows
     FROM run_pty_resize_requests
     WHERE run_id = $1 AND applied_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
    [runId],
  );

  if (!latest) return null;

  await execute(
    `UPDATE run_pty_resize_requests
     SET applied_at = NOW()
     WHERE run_id = $1 AND applied_at IS NULL AND id <= $2`,
    [runId, latest.id],
  );

  return latest;
}

export async function listRunPtyChunks(runId: number, afterSequence = 0): Promise<RunPtyChunkRow[]> {
  return query<RunPtyChunkRow>(
    `SELECT sequence, chunk
     FROM run_pty_output_chunks
     WHERE run_id = $1 AND sequence > $2
     ORDER BY sequence ASC`,
    [runId, afterSequence],
  );
}

export async function getRunPtySequence(runId: number): Promise<number> {
  const row = await queryOne<{ max_sequence: number | null }>(
    'SELECT MAX(sequence) AS max_sequence FROM run_pty_output_chunks WHERE run_id = $1',
    [runId],
  );
  return row?.max_sequence ?? 0;
}

export async function getRunPtySessionStatus(runId: number): Promise<string | null> {
  const row = await queryOne<{ status: string }>(
    'SELECT status FROM run_pty_sessions WHERE run_id = $1',
    [runId],
  );
  return row?.status ?? null;
}

export async function initializeRunPtySequence(runId: number): Promise<{ value: number }> {
  return { value: (await getRunPtySequence(runId)) + 1 };
}

export function logRunPtyStoreError(context: string, runId: number, err: unknown): void {
  logger.warn({ err, runId }, `[run-pty-store] ${context}`);
}
