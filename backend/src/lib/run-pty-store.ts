/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { gunzipSync, gzipSync } from 'zlib';
import { execute, query, queryOne } from '../db/index';
import { logger } from './logger';

const CHUNK_SIZE = 4 * 1024;
const GZIP_COMPRESSION = 'gzip';
const IDENTITY_COMPRESSION = 'identity';
const DEFAULT_PTY_RETENTION_DAYS = 14;

interface StoredRunPtyChunkRow {
  sequence: number | string;
  chunk: Buffer;
  compression: string | null;
}

export interface RunPtyChunkRow {
  sequence: number;
  chunk: Buffer;
}

export interface RunPtyResizeRequest {
  id: number;
  cols: number;
  rows: number;
}

export interface RunPtyInputRequest {
  id: number;
  input: Buffer;
}

export interface StartRunPtySessionParams {
  runId: number;
  workspaceId: string;
  cwd: string;
  agentType: string;
  cols: number;
  rows: number;
  childPid: number | null;
  completionMarker?: string | null;
}

export interface RunPtySessionHealth {
  status: string;
  child_pid: number | null;
  last_output_at: string | null;
  last_heartbeat_at: string | null;
  completion_marker: string | null;
  completion_marker_seen_at: string | null;
  total_output_bytes: string | number;
}

function compressRunPtyChunk(chunk: Buffer): { chunk: Buffer; compression: string } {
  if (chunk.length === 0) {
    return { chunk, compression: IDENTITY_COMPRESSION };
  }

  const gzipped = gzipSync(chunk, { level: 6 });
  if (gzipped.length >= chunk.length) {
    return { chunk, compression: IDENTITY_COMPRESSION };
  }

  return { chunk: gzipped, compression: GZIP_COMPRESSION };
}

function decompressRunPtyChunk(chunk: Buffer, compression: string | null): Buffer {
  if (compression !== GZIP_COMPRESSION) {
    return chunk;
  }

  return gunzipSync(chunk);
}

export function getRunPtyRetentionDays(): number {
  const raw = parseInt(process.env.RORCA_PTY_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PTY_RETENTION_DAYS;
}

export async function startRunPtySession(params: StartRunPtySessionParams): Promise<void> {
  await execute(
    `INSERT INTO run_pty_sessions
      (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, completion_marker, completion_marker_seen_at, last_heartbeat_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NULL, $8, NULL, NULL, NOW())
     ON CONFLICT (run_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       cwd = EXCLUDED.cwd,
       agent_type = EXCLUDED.agent_type,
       cols = EXCLUDED.cols,
       rows = EXCLUDED.rows,
       child_pid = EXCLUDED.child_pid,
       status = 'active',
       last_output_at = CASE WHEN run_pty_sessions.total_output_bytes > 0 THEN run_pty_sessions.last_output_at ELSE NULL END,
       completion_marker = EXCLUDED.completion_marker,
       completion_marker_seen_at = NULL,
       last_heartbeat_at = NULL,
       exit_code = NULL,
       exit_signal = NULL,
       exited_at = NULL,
       updated_at = NOW()`,
    [params.runId, params.workspaceId, params.cwd, params.agentType, params.cols, params.rows, params.childPid, params.completionMarker ?? null],
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
  let storedBytes = 0;

  while (offset < data.length) {
    const slice = data.subarray(offset, offset + CHUNK_SIZE);
    const compressed = compressRunPtyChunk(slice);
    storedBytes += compressed.chunk.length;

    await execute(
      `INSERT INTO run_pty_output_chunks (run_id, sequence, chunk, compression, byte_length, stored_byte_length)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id, sequence) DO NOTHING`,
      [runId, sequenceRef.value, compressed.chunk, compressed.compression, slice.length, compressed.chunk.length],
    );

    sequenceRef.value += 1;
    offset += CHUNK_SIZE;
  }

  await execute(
    `UPDATE run_pty_sessions
     SET total_output_bytes = total_output_bytes + $2,
         total_stored_bytes = total_stored_bytes + $3,
         last_output_at = NOW(),
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, data.length, storedBytes],
  );
}

export async function markRunPtyCompletionMarkerSeen(runId: number, marker: string): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET completion_marker = COALESCE(completion_marker, $2),
         completion_marker_seen_at = COALESCE(completion_marker_seen_at, NOW()),
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, marker],
  );
}

export async function recordRunPtyHeartbeat(runId: number): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET last_heartbeat_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND status = 'active'`,
    [runId],
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
    `SELECT r.id, r.cols, r.rows
     FROM run_pty_resize_requests r
     JOIN run_pty_sessions s ON s.run_id = r.run_id
     WHERE r.run_id = $1 AND r.applied_at IS NULL AND s.status = 'active'
     ORDER BY r.id DESC
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

export async function requestRunPtyInput(runId: number, input: Buffer): Promise<void> {
  await execute(
    `INSERT INTO run_pty_input_requests (run_id, input, byte_length)
     VALUES ($1, $2, $3)`,
    [runId, input, input.length],
  );
}

export async function claimPendingRunPtyInput(runId: number, limit = 100): Promise<RunPtyInputRequest[]> {
  const rows = await query<RunPtyInputRequest>(
    `SELECT id, input
     FROM run_pty_input_requests
     WHERE run_id = $1 AND applied_at IS NULL
     ORDER BY id ASC
     LIMIT $2`,
    [runId, limit],
  );

  if (rows.length === 0) return [];

  await execute(
    `UPDATE run_pty_input_requests
     SET applied_at = NOW()
     WHERE run_id = $1 AND id = ANY($2::bigint[])`,
    [runId, rows.map((row) => row.id)],
  );

  return rows.map((row) => ({
    id: row.id,
    input: Buffer.isBuffer(row.input) ? row.input : Buffer.from(row.input),
  }));
}

function decodeRunPtyChunkRows(rows: StoredRunPtyChunkRow[]): RunPtyChunkRow[] {
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    chunk: decompressRunPtyChunk(Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk), row.compression),
  }));
}

export async function listRunPtyChunks(runId: number, afterSequence = 0): Promise<RunPtyChunkRow[]> {
  const rows = await query<StoredRunPtyChunkRow>(
    `SELECT sequence, chunk, compression
     FROM run_pty_output_chunks
     WHERE run_id = $1 AND sequence > $2
     ORDER BY sequence ASC`,
    [runId, afterSequence],
  );

  return decodeRunPtyChunkRows(rows);
}

/** Bounded tail replay for first-time terminal attachments. */
export async function listRecentRunPtyChunks(runId: number, limit: number): Promise<RunPtyChunkRow[]> {
  const rows = await query<StoredRunPtyChunkRow>(
    `SELECT sequence, chunk, compression
     FROM (
       SELECT sequence, chunk, compression
       FROM run_pty_output_chunks
       WHERE run_id = $1
       ORDER BY sequence DESC
       LIMIT $2
     ) recent
     ORDER BY sequence ASC`,
    [runId, limit],
  );
  return decodeRunPtyChunkRows(rows);
}

export async function getRunPtySequence(runId: number): Promise<number> {
  const row = await queryOne<{ max_sequence: number | string | null }>(
    'SELECT MAX(sequence) AS max_sequence FROM run_pty_output_chunks WHERE run_id = $1',
    [runId],
  );
  return Number(row?.max_sequence ?? 0);
}

export async function getRunPtySessionStatus(runId: number): Promise<string | null> {
  const row = await queryOne<{ status: string }>(
    'SELECT status FROM run_pty_sessions WHERE run_id = $1',
    [runId],
  );
  return row?.status ?? null;
}

export async function getRunPtySessionHealth(runId: number): Promise<RunPtySessionHealth | null> {
  const row = await queryOne<RunPtySessionHealth>(
    `SELECT status,
            child_pid,
            last_output_at,
            last_heartbeat_at,
            completion_marker,
            completion_marker_seen_at,
            total_output_bytes
     FROM run_pty_sessions
     WHERE run_id = $1`,
    [runId],
  );
  return row ?? null;
}

export async function initializeRunPtySequence(runId: number): Promise<{ value: number }> {
  return { value: (await getRunPtySequence(runId)) + 1 };
}

export async function pruneExpiredRunPtyCaptures(retentionDays = getRunPtyRetentionDays()): Promise<number> {
  try {
    const result = await execute(
      `DELETE FROM run_pty_sessions
       WHERE status <> 'active'
         AND COALESCE(exited_at, last_output_at, updated_at, started_at) < NOW() - ($1 * INTERVAL '1 day')`,
      [retentionDays],
    );
    return result.rowCount;
  } catch (err) {
    logger.warn({ err, retentionDays }, '[run-pty-store] retention prune failed');
    return 0;
  }
}

export function logRunPtyStoreError(context: string, runId: number, err: unknown): void {
  logger.warn({ err, runId }, `[run-pty-store] ${context}`);
}
