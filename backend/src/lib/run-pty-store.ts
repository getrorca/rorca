/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { gunzipSync, gzipSync } from 'zlib';
import { execute, query, queryOne, transaction } from '../db/index';
import { logger } from './logger';

const CHUNK_SIZE = 4 * 1024;
const GZIP_COMPRESSION = 'gzip';
const IDENTITY_COMPRESSION = 'identity';
const DEFAULT_PTY_RETENTION_DAYS = 14;
const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 1 * 1024 * 1024;
const DEFAULT_BATCH_BYTES = 64 * 1024;
const DEFAULT_BATCH_CHUNKS = 16;
const DEFAULT_REPLAY_BATCH_CHUNKS = 512;
export const MAX_PTY_PENDING_INPUT_BYTES = 256 * 1024;

function readBoundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export interface RunPtyOutputLimits {
  maxCaptureBytes: number;
  maxPendingBytes: number;
  batchBytes: number;
  batchChunks: number;
  replayBatchChunks: number;
}

/** Bounded limits keep terminal capture useful without making noisy agents unbounded. */
export function getRunPtyOutputLimits(): RunPtyOutputLimits {
  return {
    maxCaptureBytes: readBoundedIntegerEnv('RORCA_PTY_MAX_CAPTURE_BYTES', DEFAULT_MAX_CAPTURE_BYTES, CHUNK_SIZE, 1024 * 1024 * 1024),
    maxPendingBytes: readBoundedIntegerEnv('RORCA_PTY_MAX_PENDING_BYTES', DEFAULT_MAX_PENDING_BYTES, CHUNK_SIZE, 64 * 1024 * 1024),
    batchBytes: readBoundedIntegerEnv('RORCA_PTY_OUTPUT_BATCH_BYTES', DEFAULT_BATCH_BYTES, CHUNK_SIZE, 1024 * 1024),
    batchChunks: readBoundedIntegerEnv('RORCA_PTY_OUTPUT_BATCH_CHUNKS', DEFAULT_BATCH_CHUNKS, 1, 256),
    replayBatchChunks: readBoundedIntegerEnv('RORCA_PTY_REPLAY_BATCH_CHUNKS', DEFAULT_REPLAY_BATCH_CHUNKS, 1, 4_096),
  };
}

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
  completion_file_seen_at: string | null;
  completion_file_error: string | null;
  terminal_marker_seen_at: string | null;
  prompt_readiness_status: string | null;
  prompt_readiness_reason: string | null;
  prompt_ready_at: string | null;
  prompt_injected_at: string | null;
  total_output_bytes: string | number;
  dropped_output_bytes: string | number;
  output_truncated_at: string | null;
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
  await transaction(async (client) => {
    // Serialize the session generation boundary with input admission. If an
    // old-session input transaction wins the lock, its row is deleted below;
    // if this transaction wins, later input is admitted to the new session.
    await client.query('SELECT run_id FROM run_pty_sessions WHERE run_id = $1 FOR UPDATE', [params.runId]);
    // Input/resize requests are scoped to one sequential story attachment. A
    // request left behind by an exited story must never reach the next agent.
    await client.query('DELETE FROM run_pty_input_requests WHERE run_id = $1', [params.runId]);
    await client.query('DELETE FROM run_pty_resize_requests WHERE run_id = $1', [params.runId]);
    await client.query(
      `INSERT INTO run_pty_sessions
        (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status, started_at, last_output_at, completion_marker, completion_marker_seen_at, completion_file_seen_at, completion_file_error, terminal_marker_seen_at, prompt_readiness_status, prompt_readiness_reason, prompt_ready_at, prompt_injected_at, last_heartbeat_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NULL, $8, NULL, NULL, NULL, NULL, 'waiting', 'awaiting_cli_readiness', NULL, NULL, NULL, NOW())
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
         completion_file_seen_at = NULL,
         completion_file_error = NULL,
         terminal_marker_seen_at = NULL,
         prompt_readiness_status = 'waiting',
         prompt_readiness_reason = 'awaiting_cli_readiness',
         prompt_ready_at = NULL,
         prompt_injected_at = NULL,
         last_heartbeat_at = NULL,
         exit_code = NULL,
         exit_signal = NULL,
         exited_at = NULL,
         updated_at = NOW()`,
      [params.runId, params.workspaceId, params.cwd, params.agentType, params.cols, params.rows, params.childPid, params.completionMarker ?? null],
    );
  });
}

export async function updateRunPtyDimensions(runId: number, cols: number, rows: number): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions SET cols = $2, rows = $3, updated_at = NOW() WHERE run_id = $1`,
    [runId, cols, rows],
  );
}

interface AppendRunPtyOutputOptions {
  maxCaptureBytes?: number;
  droppedBytes?: number;
}

interface RunPtyOutputSessionRow {
  total_output_bytes: string | number;
  dropped_output_bytes: string | number;
}

/**
 * Commit a bounded batch atomically. `droppedBytes` represents bytes discarded
 * before reaching this writer because its in-memory queue was full. They are
 * accounted for durably so consumers can distinguish a truncated capture from
 * a completed terminal session.
 */
export async function appendRunPtyOutputBatch(
  runId: number,
  buffers: readonly Buffer[],
  sequenceRef: { value: number },
  options: AppendRunPtyOutputOptions = {},
): Promise<void> {
  const maxCaptureBytes = options.maxCaptureBytes ?? getRunPtyOutputLimits().maxCaptureBytes;
  const queueDroppedBytes = options.droppedBytes ?? 0;
  const rawBytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
  if (rawBytes === 0 && queueDroppedBytes === 0) return;

  await transaction(async (client) => {
    const session = await client.query<RunPtyOutputSessionRow>(
      `SELECT total_output_bytes, dropped_output_bytes
       FROM run_pty_sessions WHERE run_id = $1 FOR UPDATE`,
      [runId],
    );
    const row = session.rows[0];
    if (!row) throw new Error(`PTY session ${runId} does not exist`);

    const totalOutputBytes = Number(row.total_output_bytes) || 0;
    const droppedOutputBytes = Number(row.dropped_output_bytes) || 0;
    const capturedBytes = Math.max(0, totalOutputBytes - droppedOutputBytes);
    let remainingCaptureBytes = Math.max(0, maxCaptureBytes - capturedBytes);
    let acceptedBytes = 0;
    let storedBytes = 0;

    // Coalesce callback-sized fragments before the durable 4 KiB split. This
    // preserves byte order while preventing a small-chunk flood from creating
    // one PostgreSQL row per keystroke/terminal callback.
    const combined = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, rawBytes);
    let offset = 0;
    while (offset < combined.length && remainingCaptureBytes > 0) {
      const length = Math.min(CHUNK_SIZE, combined.length - offset, remainingCaptureBytes);
      const slice = combined.subarray(offset, offset + length);
      const compressed = compressRunPtyChunk(slice);
      await client.query(
        `INSERT INTO run_pty_output_chunks (run_id, sequence, chunk, compression, byte_length, stored_byte_length)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (run_id, sequence) DO NOTHING`,
        [runId, sequenceRef.value, compressed.chunk, compressed.compression, slice.length, compressed.chunk.length],
      );
      sequenceRef.value += 1;
      acceptedBytes += slice.length;
      storedBytes += compressed.chunk.length;
      remainingCaptureBytes -= slice.length;
      offset += length;
    }

    const captureDroppedBytes = rawBytes - acceptedBytes;
    const droppedBytes = queueDroppedBytes + captureDroppedBytes;
    await client.query(
      `UPDATE run_pty_sessions
       SET total_output_bytes = total_output_bytes + $2,
           total_stored_bytes = total_stored_bytes + $3,
           dropped_output_bytes = dropped_output_bytes + $4,
           output_truncated_at = CASE WHEN $4 > 0 THEN COALESCE(output_truncated_at, NOW()) ELSE output_truncated_at END,
           last_output_at = CASE WHEN $2 > $4 THEN NOW() ELSE last_output_at END,
           updated_at = NOW()
       WHERE run_id = $1`,
      [runId, rawBytes + queueDroppedBytes, storedBytes, droppedBytes],
    );
  });
}

export async function appendRunPtyOutput(
  runId: number,
  data: Buffer,
  sequenceRef: { value: number },
): Promise<void> {
  await appendRunPtyOutputBatch(runId, [data], sequenceRef);
}

export interface RunPtyOutputBatcher {
  enqueue(data: Buffer): void;
  drain(): Promise<void>;
  getPendingBytes(): number;
}

/**
 * A small single-writer queue for node-pty's push-only data callback. It keeps
 * only a bounded amount of raw data in memory, batches database work, and
 * records overflow as durable truncation metadata instead of growing promises
 * and buffers without bound under a noisy process or slow database.
 */
export function createRunPtyOutputBatcher(
  runId: number,
  sequenceRef: { value: number },
  limits: Partial<RunPtyOutputLimits> = {},
): RunPtyOutputBatcher {
  const defaults = getRunPtyOutputLimits();
  const maxPendingBytes = limits.maxPendingBytes ?? defaults.maxPendingBytes;
  const batchBytes = limits.batchBytes ?? defaults.batchBytes;
  const batchChunks = limits.batchChunks ?? defaults.batchChunks;
  const maxCaptureBytes = limits.maxCaptureBytes ?? defaults.maxCaptureBytes;
  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let pendingDroppedBytes = 0;
  let pumping: Promise<void> | null = null;
  let retryRequired = false;

  const takeBatch = (): Buffer[] => {
    const batch: Buffer[] = [];
    let bytes = 0;
    while (pending.length > 0 && batch.length < batchChunks && bytes < batchBytes) {
      const next = pending[0];
      const remaining = batchBytes - bytes;
      const take = Math.min(next.length, remaining);
      batch.push(next.subarray(0, take));
      bytes += take;
      pendingBytes -= take;
      if (take === next.length) pending.shift();
      else pending[0] = next.subarray(take);
    }
    return batch;
  };

  const pump = async (): Promise<void> => {
    retryRequired = false;
    while (pending.length > 0 || pendingDroppedBytes > 0) {
      const batch = takeBatch();
      const droppedBytes = pendingDroppedBytes;
      pendingDroppedBytes = 0;
      try {
        await appendRunPtyOutputBatch(runId, batch, sequenceRef, { maxCaptureBytes, droppedBytes });
      } catch (err) {
        // Do not put failed raw buffers back into the queue: doing so defeats
        // the memory bound. Persist their loss on a later successful batch.
        pendingDroppedBytes += droppedBytes + batch.reduce((total, buffer) => total + buffer.length, 0);
        retryRequired = true;
        logger.warn({ err, runId, pendingBytes, pendingDroppedBytes }, '[run-pty-store] PTY output batch persistence failed; capture will retry as truncation metadata');
        return;
      }
    }
  };

  const schedulePump = (): void => {
    if (pumping) return;
    pumping = Promise.resolve()
      .then(pump)
      .finally(() => { pumping = null; });
  };

  return {
    enqueue(data: Buffer): void {
      if (data.length === 0) return;
      const available = Math.max(0, maxPendingBytes - pendingBytes);
      const accepted = Math.min(data.length, available);
      if (accepted > 0) {
        pending.push(Buffer.from(data.subarray(0, accepted)));
        pendingBytes += accepted;
      }
      pendingDroppedBytes += data.length - accepted;
      schedulePump();
    },
    async drain(): Promise<void> {
      do {
        schedulePump();
        await pumping;
      } while (!retryRequired && (pending.length > 0 || pendingDroppedBytes > 0));
    },
    getPendingBytes(): number {
      return pendingBytes;
    },
  };
}

/** Terminal marker is corroborating telemetry; it never completes a turn. */
export async function markRunPtyCompletionMarkerSeen(runId: number, marker: string): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET completion_marker = COALESCE(completion_marker, $2),
         completion_marker_seen_at = COALESCE(completion_marker_seen_at, NOW()),
         terminal_marker_seen_at = COALESCE(terminal_marker_seen_at, NOW()),
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, marker],
  );
}

/** The agent-written completion file is the primary PTY turn-completion evidence. */
export async function markRunPtyCompletionFileSeen(runId: number, marker: string): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET completion_marker = COALESCE(completion_marker, $2),
         completion_file_seen_at = COALESCE(completion_file_seen_at, NOW()),
         completion_file_error = NULL,
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, marker],
  );
}

export async function recordRunPtyCompletionFileError(runId: number, reason: string): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET completion_file_error = $2, updated_at = NOW()
     WHERE run_id = $1`,
    [runId, reason.slice(0, 1000)],
  );
}

export async function recordRunPtyPromptReadiness(
  runId: number,
  status: 'waiting' | 'ready' | 'timeout_fallback' | 'injected' | 'failed',
  reason: string,
): Promise<void> {
  await execute(
    `UPDATE run_pty_sessions
     SET prompt_readiness_status = $2,
         prompt_readiness_reason = $3,
         prompt_ready_at = CASE WHEN $2 = 'ready' THEN COALESCE(prompt_ready_at, NOW()) ELSE prompt_ready_at END,
         prompt_injected_at = CASE WHEN $2 = 'injected' THEN COALESCE(prompt_injected_at, NOW()) ELSE prompt_injected_at END,
         updated_at = NOW()
     WHERE run_id = $1`,
    [runId, status, reason.slice(0, 1000)],
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
  return transaction(async (client) => {
    const result = await client.query<RunPtyResizeRequest>(
      `SELECT r.id, r.cols, r.rows
       FROM run_pty_resize_requests r
       JOIN run_pty_sessions s ON s.run_id = r.run_id
       WHERE r.run_id = $1 AND r.applied_at IS NULL AND s.status = 'active'
       ORDER BY r.id DESC
       LIMIT 1
       FOR UPDATE OF r`,
      [runId],
    );
    const latest = result.rows[0];
    if (!latest) return null;

    // Only the newest dimensions matter. Delete consumed/coalesced requests so
    // a long-running attached terminal cannot grow this table without bound.
    await client.query(
      'DELETE FROM run_pty_resize_requests WHERE run_id = $1 AND applied_at IS NULL AND id <= $2',
      [runId, latest.id],
    );
    return latest;
  });
}

/** Returns false when the per-run pending-input budget is exhausted. */
export async function requestRunPtyInput(runId: number, input: Buffer): Promise<boolean> {
  return transaction(async (client) => {
    const session = await client.query<{ status: string }>(
      'SELECT status FROM run_pty_sessions WHERE run_id = $1 FOR UPDATE',
      [runId],
    );
    if (session.rows[0]?.status !== 'active') return false;
    const pending = await client.query<{ bytes: string }>(
      `SELECT COALESCE(SUM(byte_length), 0)::text AS bytes
       FROM run_pty_input_requests WHERE run_id = $1 AND applied_at IS NULL`,
      [runId],
    );
    const pendingBytes = Number(pending.rows[0]?.bytes ?? 0);
    if (pendingBytes + input.length > MAX_PTY_PENDING_INPUT_BYTES) return false;
    await client.query(
      `INSERT INTO run_pty_input_requests (run_id, input, byte_length)
       VALUES ($1, $2, $3)`,
      [runId, input, input.length],
    );
    return true;
  });
}

export async function claimPendingRunPtyInput(runId: number, limit = 100): Promise<RunPtyInputRequest[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await query<RunPtyInputRequest>(
    `DELETE FROM run_pty_input_requests
     WHERE id IN (
       SELECT id FROM run_pty_input_requests
       WHERE run_id = $1 AND applied_at IS NULL
       ORDER BY id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, input`,
    [runId, boundedLimit],
  );

  rows.sort((a, b) => Number(a.id) - Number(b.id));
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

export async function listRunPtyChunks(
  runId: number,
  afterSequence = 0,
  limit = getRunPtyOutputLimits().replayBatchChunks,
): Promise<RunPtyChunkRow[]> {
  const boundedLimit = Math.min(4_096, Math.max(1, Math.floor(limit)));
  const rows = await query<StoredRunPtyChunkRow>(
    `SELECT sequence, chunk, compression
     FROM run_pty_output_chunks
     WHERE run_id = $1 AND sequence > $2
     ORDER BY sequence ASC
     LIMIT $3`,
    [runId, afterSequence, boundedLimit],
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
            completion_file_seen_at,
            completion_file_error,
            terminal_marker_seen_at,
            prompt_readiness_status,
            prompt_readiness_reason,
            prompt_ready_at,
            prompt_injected_at,
            total_output_bytes,
            dropped_output_bytes,
            output_truncated_at
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
