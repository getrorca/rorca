/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { gunzipSync, gzipSync } from 'zlib';
import { execute, query, queryOne, transaction } from '../db/index';
import { ConflictError, ForbiddenError, NotFoundError } from './errors';
import { logger } from './logger';
import { PtyCheckpointCoordinator, type PtyCheckpointCoordinatorOptions } from './pty-checkpoint-store';

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

export type PtyGenerationStatus = 'active' | 'superseded' | 'exited' | 'killed' | 'failed' | 'timed_out' | 'legacy';
export type PtyGenerationSource = 'native' | 'legacy';
export type PtyReplaySource = 'generation' | 'legacy_run_output' | 'legacy_pty_output';

export interface PtyGenerationIdentity {
  generationId: string;
  generationToken: string;
  runId: number;
  storyId: string;
  attempt: number;
  status: PtyGenerationStatus;
  isActive: boolean;
  source: PtyGenerationSource;
  replaySource: PtyReplaySource;
}

export interface PtyGenerationRef {
  runId: number;
  generationId: string;
  generationToken: string;
}

interface StoredPtyGenerationIdentityRow {
  id: string;
  generation_token: string;
  run_id: number | string;
  story_id: string;
  attempt: number;
  status: PtyGenerationStatus;
  is_active: boolean;
  source: PtyGenerationSource;
  replay_source: PtyReplaySource;
}

export interface RunPtyChunkRow {
  sequence: number;
  chunk: Buffer;
  generation: PtyGenerationIdentity;
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
  storyId: string;
  attempt: number;
  cwd: string;
  agentType: string;
  cols: number;
  rows: number;
  childPid: number | null;
  generationToken?: string;
  completionMarker?: string | null;
}

function toGenerationIdentity(row: StoredPtyGenerationIdentityRow): PtyGenerationIdentity {
  return {
    generationId: row.id,
    generationToken: row.generation_token,
    runId: Number(row.run_id),
    storyId: row.story_id,
    attempt: Number(row.attempt),
    status: row.status,
    isActive: row.is_active,
    source: row.source,
    replaySource: row.replay_source,
  };
}

export interface RunPtySessionHealth extends PtyGenerationIdentity {
  status: PtyGenerationStatus;
  workspace_id: string;
  cwd: string;
  agent_type: string;
  child_pid: number | null;
  cols: number;
  rows: number;
  next_output_sequence: string | number;
  total_stored_bytes: string | number;
  pending_input_bytes: string | number;
  last_input_request_id: string | number | null;
  last_resize_request_id: string | number | null;
  checkpoint_sequence: string | number;
  first_retained_sequence: string | number;
  retained_output_bytes: string | number;
  compacted_byte_count: string | number;
  checkpoint_at: string | null;
  checkpoint_reference: string | null;
  archive_reference: string | null;
  archive_checksum: string | null;
  archived_at: string | null;
  started_at: string;
  superseded_at: string | null;
  exited_at: string | null;
  exit_code: number | null;
  exit_signal: string | null;
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

export async function startRunPtySession(params: StartRunPtySessionParams): Promise<PtyGenerationIdentity> {
  return transaction(async (client) => {
    // The run row is permanent lock authority even before its first generation.
    // This makes UPDATE-old + INSERT-new one atomic, serial transition and lets
    // the partial active index act as a final split-brain guard.
    const authority = await client.query<{ id: number }>(
      'SELECT id FROM pipeline_runs WHERE id = $1 FOR UPDATE',
      [params.runId],
    );
    if (!authority.rows[0]) throw new NotFoundError('Run not found');

    await client.query(
      `UPDATE pty_generations
       SET is_active = FALSE, status = 'superseded', superseded_at = NOW(), updated_at = NOW()
       WHERE run_id = $1 AND is_active = TRUE`,
      [params.runId],
    );
    // Controls are ephemeral. Removing every unclaimed prior-generation request
    // within the same transition prevents retention and accidental legacy reads.
    await client.query('DELETE FROM run_pty_input_requests WHERE run_id = $1 AND applied_at IS NULL', [params.runId]);
    await client.query('DELETE FROM run_pty_resize_requests WHERE run_id = $1 AND applied_at IS NULL', [params.runId]);

    const inserted = await client.query<StoredPtyGenerationIdentityRow>(
      `INSERT INTO pty_generations
        (run_id, workspace_id, story_id, attempt, cwd, agent_type, cols, rows,
         child_pid, completion_marker, generation_token, prompt_readiness_status, prompt_readiness_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         COALESCE($11::uuid, gen_random_uuid()), 'waiting', 'awaiting_cli_readiness')
       RETURNING id, generation_token, run_id, story_id, attempt, status, is_active, source, replay_source`,
      [params.runId, params.workspaceId, params.storyId, params.attempt, params.cwd, params.agentType,
        params.cols, params.rows, params.childPid, params.completionMarker ?? null, params.generationToken ?? null],
    );
    const generation = inserted.rows[0];
    if (!generation) throw new ConflictError('PTY generation could not be created');

    // Keep the run-level session as a compatibility projection for liveness and
    // retention code. Every mutable counter/evidence field is reset; identity
    // and replay authority live only in pty_generations.
    await client.query(
      `INSERT INTO run_pty_sessions
        (run_id, workspace_id, cwd, agent_type, cols, rows, child_pid, status,
         total_output_bytes, total_stored_bytes, dropped_output_bytes, started_at,
         last_output_at, completion_marker, completion_marker_seen_at,
         completion_file_seen_at, completion_file_error, terminal_marker_seen_at,
         prompt_readiness_status, prompt_readiness_reason, prompt_ready_at,
         prompt_injected_at, last_heartbeat_at, output_truncated_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', 0, 0, 0, NOW(), NULL,
         $8, NULL, NULL, NULL, NULL, 'waiting', 'awaiting_cli_readiness', NULL, NULL, NULL, NULL, NOW())
       ON CONFLICT (run_id) DO UPDATE SET
         workspace_id = EXCLUDED.workspace_id, cwd = EXCLUDED.cwd,
         agent_type = EXCLUDED.agent_type, cols = EXCLUDED.cols, rows = EXCLUDED.rows,
         child_pid = EXCLUDED.child_pid, status = 'active', total_output_bytes = 0,
         total_stored_bytes = 0, dropped_output_bytes = 0, started_at = NOW(),
         last_output_at = NULL, completion_marker = EXCLUDED.completion_marker,
         completion_marker_seen_at = NULL, completion_file_seen_at = NULL,
         completion_file_error = NULL, terminal_marker_seen_at = NULL,
         prompt_readiness_status = 'waiting', prompt_readiness_reason = 'awaiting_cli_readiness',
         prompt_ready_at = NULL, prompt_injected_at = NULL, last_heartbeat_at = NULL,
         output_truncated_at = NULL, exit_code = NULL, exit_signal = NULL,
         exited_at = NULL, updated_at = NOW()`,
      [params.runId, params.workspaceId, params.cwd, params.agentType, params.cols, params.rows,
        params.childPid, params.completionMarker ?? null],
    );
    return toGenerationIdentity(generation);
  });
}

export async function updateRunPtyChildPid(generation: PtyGenerationRef, childPid: number): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE pty_generations SET child_pid = $4, updated_at = NOW()
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE
       RETURNING id`,
      [generation.runId, generation.generationId, generation.generationToken, childPid],
    );
    if (updated.rows[0]) {
      await client.query(
        'UPDATE run_pty_sessions SET child_pid = $2, updated_at = NOW() WHERE run_id = $1',
        [generation.runId, childPid],
      );
    }
  });
}

export async function updateRunPtyDimensions(generation: PtyGenerationRef, cols: number, rows: number): Promise<void> {
  await transaction(async (client) => {
    const updated = await client.query(
      `UPDATE pty_generations SET cols = $4, rows = $5, updated_at = NOW()
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE
       RETURNING id`,
      [generation.runId, generation.generationId, generation.generationToken, cols, rows],
    );
    if (updated.rows[0]) {
      await client.query(
        `UPDATE run_pty_sessions SET cols = $2, rows = $3, updated_at = NOW() WHERE run_id = $1`,
        [generation.runId, cols, rows],
      );
    }
  });
}

interface AppendRunPtyOutputOptions {
  maxCaptureBytes?: number;
  droppedBytes?: number;
}

interface RunPtyOutputSessionRow {
  total_output_bytes: string | number;
  dropped_output_bytes: string | number;
  retained_output_bytes: string | number;
  next_output_sequence: string | number;
}

export interface AppendRunPtyOutputResult {
  chunks: Array<{ sequence: number; chunk: Buffer }>;
  retainedBytes: number;
  retentionExceeded: boolean;
}

/**
 * Commit a bounded batch atomically. `droppedBytes` represents bytes discarded
 * before reaching this writer because its in-memory queue was full. They are
 * accounted for durably so consumers can distinguish a truncated capture from
 * a completed terminal session.
 */
export async function appendRunPtyOutputBatch(
  generation: PtyGenerationRef,
  buffers: readonly Buffer[],
  sequenceRef: { value: number },
  options: AppendRunPtyOutputOptions = {},
): Promise<AppendRunPtyOutputResult> {
  const maxCaptureBytes = options.maxCaptureBytes ?? getRunPtyOutputLimits().maxCaptureBytes;
  const queueDroppedBytes = options.droppedBytes ?? 0;
  const rawBytes = buffers.reduce((total, buffer) => total + buffer.length, 0);
  if (rawBytes === 0 && queueDroppedBytes === 0) {
    return { chunks: [], retainedBytes: 0, retentionExceeded: false };
  }

  return transaction(async (client) => {
    const session = await client.query<RunPtyOutputSessionRow>(
      `SELECT total_output_bytes, dropped_output_bytes, retained_output_bytes,
              next_output_sequence
       FROM pty_generations
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE
       FOR UPDATE`,
      [generation.runId, generation.generationId, generation.generationToken],
    );
    const row = session.rows[0];
    if (!row) throw new ConflictError('PTY generation is no longer active');

    // The durable generation counter is authoritative after restart. Every raw
    // slice receives a logical sequence even when the delta budget is full; its
    // bytes still enter the emulator and the next checkpoint covers that range.
    sequenceRef.value = Math.max(sequenceRef.value, Number(row.next_output_sequence) || 1);
    let retainedBytes = Number(row.retained_output_bytes) || 0;
    let storedBytes = 0;
    let retentionExceeded = false;
    const acceptedChunks: Array<{ sequence: number; chunk: Buffer }> = [];
    const combined = buffers.length === 1 ? buffers[0] : Buffer.concat(buffers, rawBytes);
    let offset = 0;
    while (offset < combined.length) {
      const length = Math.min(CHUNK_SIZE, combined.length - offset);
      const slice = Buffer.from(combined.subarray(offset, offset + length));
      const sequence = sequenceRef.value++;
      acceptedChunks.push({ sequence, chunk: slice });
      if (retainedBytes + slice.length <= maxCaptureBytes) {
        const compressed = compressRunPtyChunk(slice);
        const inserted = await client.query(
          `INSERT INTO run_pty_output_chunks
            (run_id, generation_id, sequence, chunk, compression, byte_length, stored_byte_length)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT DO NOTHING RETURNING id`,
          [generation.runId, generation.generationId, sequence, compressed.chunk,
            compressed.compression, slice.length, compressed.chunk.length],
        );
        if (inserted.rows[0]) {
          retainedBytes += slice.length;
          storedBytes += compressed.chunk.length;
        }
      } else {
        retentionExceeded = true;
      }
      offset += length;
    }

    await client.query(
      `UPDATE pty_generations
       SET total_output_bytes = total_output_bytes + $4,
           total_stored_bytes = total_stored_bytes + $5,
           retained_output_bytes = $6,
           dropped_output_bytes = dropped_output_bytes + $7,
           next_output_sequence = GREATEST(next_output_sequence, $8),
           output_truncated_at = CASE WHEN $7 > 0 THEN COALESCE(output_truncated_at, NOW()) ELSE output_truncated_at END,
           last_output_at = CASE WHEN $4 > $7 THEN NOW() ELSE last_output_at END,
           updated_at = NOW()
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE`,
      [generation.runId, generation.generationId, generation.generationToken,
        rawBytes + queueDroppedBytes, storedBytes, retainedBytes, queueDroppedBytes, sequenceRef.value],
    );
    await client.query(
      `UPDATE run_pty_sessions
       SET total_output_bytes = total_output_bytes + $2,
           total_stored_bytes = total_stored_bytes + $3,
           dropped_output_bytes = dropped_output_bytes + $4,
           output_truncated_at = CASE WHEN $4 > 0 THEN COALESCE(output_truncated_at, NOW()) ELSE output_truncated_at END,
           last_output_at = CASE WHEN $2 > $4 THEN NOW() ELSE last_output_at END,
           updated_at = NOW()
       WHERE run_id = $1`,
      [generation.runId, rawBytes + queueDroppedBytes, storedBytes, queueDroppedBytes],
    );
    return { chunks: acceptedChunks, retainedBytes, retentionExceeded };
  });
}

export async function appendRunPtyOutput(
  generation: PtyGenerationRef,
  data: Buffer,
  sequenceRef: { value: number },
): Promise<void> {
  await appendRunPtyOutputBatch(generation, [data], sequenceRef);
}

export interface RunPtyOutputBatcher {
  enqueue(data: Buffer): void;
  resize(cols: number, rows: number): void;
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
  generation: PtyGenerationRef,
  sequenceRef: { value: number },
  limits: Partial<RunPtyOutputLimits> = {},
  checkpointOptions: Partial<PtyCheckpointCoordinatorOptions> & Pick<PtyCheckpointCoordinatorOptions, 'storyId'> = { storyId: 'unknown' },
): RunPtyOutputBatcher {
  const defaults = getRunPtyOutputLimits();
  const maxPendingBytes = limits.maxPendingBytes ?? defaults.maxPendingBytes;
  const batchBytes = limits.batchBytes ?? defaults.batchBytes;
  const batchChunks = limits.batchChunks ?? defaults.batchChunks;
  const maxCaptureBytes = limits.maxCaptureBytes ?? defaults.maxCaptureBytes;
  const checkpointCoordinator = new PtyCheckpointCoordinator(generation, {
    cols: checkpointOptions.cols ?? 120,
    rows: checkpointOptions.rows ?? 36,
    storyId: checkpointOptions.storyId,
    checkpointTriggerBytes: checkpointOptions.checkpointTriggerBytes ?? Math.min(maxCaptureBytes, 8 * 1024 * 1024),
    scrollback: checkpointOptions.scrollback,
    maxCheckpointBytes: checkpointOptions.maxCheckpointBytes,
  });
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
        const committed = await appendRunPtyOutputBatch(generation, batch, sequenceRef, { maxCaptureBytes, droppedBytes });
        checkpointCoordinator.accept(committed.chunks, committed.retainedBytes, committed.retentionExceeded);
      } catch (err) {
        // Do not put failed raw buffers back into the queue: doing so defeats
        // the memory bound. Persist their loss on a later successful batch.
        const lostBytes = droppedBytes + batch.reduce((total, buffer) => total + buffer.length, 0);
        pendingDroppedBytes += lostBytes;
        checkpointCoordinator.noteCaptureLoss(lostBytes, 'database_latency');
        retryRequired = true;
        logger.warn({ err, runId: generation.runId, generationId: generation.generationId, pendingBytes, pendingDroppedBytes }, '[run-pty-store] PTY output batch persistence failed; capture will retry as truncation metadata');
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
      // Queue pressure is rolling-newest, never prefix-only. Evict the oldest
      // not-yet-persisted bytes so a slow PostgreSQL transaction cannot put the
      // live process into a permanent drop-all-new-output state.
      let overflowBytes = Math.max(0, pendingBytes + data.length - maxPendingBytes);
      const bytesToEvict = overflowBytes;
      while (overflowBytes > 0 && pending.length > 0) {
        const oldest = pending[0];
        const drop = Math.min(oldest.length, overflowBytes);
        pendingBytes -= drop;
        overflowBytes -= drop;
        if (drop === oldest.length) pending.shift();
        else pending[0] = oldest.subarray(drop);
      }
      const keepBytes = Math.min(data.length, maxPendingBytes);
      if (keepBytes > 0) {
        pending.push(Buffer.from(data.subarray(data.length - keepBytes)));
        pendingBytes += keepBytes;
      }
      pendingDroppedBytes += bytesToEvict;
      if (bytesToEvict > 0) checkpointCoordinator.noteCaptureLoss(bytesToEvict, 'queue_overflow');
      schedulePump();
    },
    resize(cols: number, rows: number): void {
      checkpointCoordinator.resize(cols, rows);
    },
    async drain(): Promise<void> {
      let retries = 0;
      while (pending.length > 0 || pendingDroppedBytes > 0) {
        schedulePump();
        await pumping;
        if (!retryRequired) continue;
        retries += 1;
        if (retries >= 3) break;
        await new Promise<void>(resolve => setTimeout(resolve, retries * 25));
      }
      await checkpointCoordinator.flush();
      checkpointCoordinator.dispose();
    },
    getPendingBytes(): number {
      return pendingBytes;
    },
  };
}

/** Terminal marker is corroborating telemetry; it never completes a turn. */
export async function markRunPtyCompletionMarkerSeen(generation: PtyGenerationRef, marker: string): Promise<void> {
  await execute(
    `UPDATE pty_generations
     SET completion_marker = COALESCE(completion_marker, $4),
         completion_marker_seen_at = COALESCE(completion_marker_seen_at, NOW()),
         terminal_marker_seen_at = COALESCE(terminal_marker_seen_at, NOW()),
         updated_at = NOW()
     WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE`,
    [generation.runId, generation.generationId, generation.generationToken, marker],
  );
}

/** The agent-written completion file is the primary PTY turn-completion evidence. */
export async function markRunPtyCompletionFileSeen(generation: PtyGenerationRef, marker: string): Promise<void> {
  await execute(
    `UPDATE pty_generations
     SET completion_marker = COALESCE(completion_marker, $4),
         completion_file_seen_at = COALESCE(completion_file_seen_at, NOW()),
         completion_file_error = NULL,
         updated_at = NOW()
     WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE`,
    [generation.runId, generation.generationId, generation.generationToken, marker],
  );
}

export async function recordRunPtyCompletionFileError(generation: PtyGenerationRef, reason: string): Promise<void> {
  await execute(
    `UPDATE pty_generations SET completion_file_error = $4, updated_at = NOW()
     WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE`,
    [generation.runId, generation.generationId, generation.generationToken, reason.slice(0, 1000)],
  );
}

export async function recordRunPtyPromptReadiness(
  generation: PtyGenerationRef,
  status: 'waiting' | 'ready' | 'timeout_fallback' | 'injected' | 'failed',
  reason: string,
): Promise<void> {
  await execute(
    `UPDATE pty_generations
     SET prompt_readiness_status = $4,
         prompt_readiness_reason = $5,
         prompt_ready_at = CASE WHEN $4 = 'ready' THEN COALESCE(prompt_ready_at, NOW()) ELSE prompt_ready_at END,
         prompt_injected_at = CASE WHEN $4 = 'injected' THEN COALESCE(prompt_injected_at, NOW()) ELSE prompt_injected_at END,
         updated_at = NOW()
     WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE`,
    [generation.runId, generation.generationId, generation.generationToken, status, reason.slice(0, 1000)],
  );
}

export async function recordRunPtyHeartbeat(generation: PtyGenerationRef): Promise<void> {
  await execute(
    `UPDATE pty_generations SET last_heartbeat_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE`,
    [generation.runId, generation.generationId, generation.generationToken],
  );
}

export async function completeRunPtySession(
  generation: PtyGenerationRef,
  status: 'exited' | 'killed' | 'failed' | 'timed_out',
  exitCode: number | null,
  exitSignal: string | null,
): Promise<void> {
  await transaction(async (client) => {
    const completed = await client.query(
      `UPDATE pty_generations
       SET is_active = FALSE, status = $4, exit_code = $5, exit_signal = $6,
           exited_at = NOW(), updated_at = NOW()
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE
       RETURNING id`,
      [generation.runId, generation.generationId, generation.generationToken, status, exitCode, exitSignal],
    );
    // An old process completing after replacement cannot close the replacement's
    // compatibility session projection.
    if (completed.rows[0]) {
      await client.query(
        `UPDATE run_pty_sessions SET status = $2, exit_code = $3, exit_signal = $4,
         exited_at = NOW(), updated_at = NOW() WHERE run_id = $1`,
        [generation.runId, status, exitCode, exitSignal],
      );
    }
  });
}

export async function requestRunPtyResize(runId: number, generationToken: string, cols: number, rows: number): Promise<PtyGenerationIdentity> {
  return transaction(async (client) => {
    // Token admission and the control write share the same transaction. The
    // exact active row lock races safely with generation replacement.
    const active = await client.query<StoredPtyGenerationIdentityRow>(
      `SELECT id, generation_token, run_id, story_id, attempt, status, is_active, source, replay_source
       FROM pty_generations
       WHERE run_id = $1 AND is_active = TRUE AND generation_token = $2
       FOR UPDATE`,
      [runId, generationToken],
    );
    const row = active.rows[0];
    if (!row) {
      const current = await client.query<{ supplied_exists: boolean; active_exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pty_generations WHERE run_id = $1 AND generation_token = $2) AS supplied_exists,
                EXISTS(SELECT 1 FROM pty_generations WHERE run_id = $1 AND is_active = TRUE) AS active_exists`,
        [runId, generationToken],
      );
      if (current.rows[0]?.supplied_exists && !current.rows[0]?.active_exists) {
        throw new ConflictError('PTY generation is closed or exited');
      }
      throw new ForbiddenError('PTY generation token is stale or mismatched');
    }
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO run_pty_resize_requests (run_id, generation_id, cols, rows)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [runId, row.id, cols, rows],
    );
    await client.query(
      `UPDATE pty_generations SET cols = $3, rows = $4,
       last_resize_request_id = $5, updated_at = NOW() WHERE run_id = $1 AND id = $2`,
      [runId, row.id, cols, rows, inserted.rows[0]?.id ?? null],
    );
    await client.query('UPDATE run_pty_sessions SET cols = $2, rows = $3, updated_at = NOW() WHERE run_id = $1', [runId, cols, rows]);
    return toGenerationIdentity(row);
  });
}

export async function claimLatestRunPtyResize(generation: PtyGenerationRef): Promise<RunPtyResizeRequest | null> {
  return transaction(async (client) => {
    const authority = await client.query(
      `SELECT id FROM pty_generations
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE
       FOR UPDATE`,
      [generation.runId, generation.generationId, generation.generationToken],
    );
    if (!authority.rows[0]) return null;
    const result = await client.query<RunPtyResizeRequest>(
      `SELECT id, cols, rows FROM run_pty_resize_requests
       WHERE run_id = $1 AND generation_id = $2 AND applied_at IS NULL
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [generation.runId, generation.generationId],
    );
    const latest = result.rows[0];
    if (!latest) return null;
    await client.query(
      `DELETE FROM run_pty_resize_requests
       WHERE run_id = $1 AND generation_id = $2 AND applied_at IS NULL AND id <= $3`,
      [generation.runId, generation.generationId, latest.id],
    );
    return latest;
  });
}

/** Returns false when the per-run pending-input budget is exhausted. */
export async function requestRunPtyInput(runId: number, generationToken: string, input: Buffer): Promise<PtyGenerationIdentity | false> {
  return transaction(async (client) => {
    const active = await client.query<StoredPtyGenerationIdentityRow>(
      `SELECT id, generation_token, run_id, story_id, attempt, status, is_active, source, replay_source
       FROM pty_generations
       WHERE run_id = $1 AND is_active = TRUE AND generation_token = $2
       FOR UPDATE`,
      [runId, generationToken],
    );
    const row = active.rows[0];
    if (!row) {
      const current = await client.query<{ supplied_exists: boolean; active_exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pty_generations WHERE run_id = $1 AND generation_token = $2) AS supplied_exists,
                EXISTS(SELECT 1 FROM pty_generations WHERE run_id = $1 AND is_active = TRUE) AS active_exists`,
        [runId, generationToken],
      );
      if (current.rows[0]?.supplied_exists && !current.rows[0]?.active_exists) {
        throw new ConflictError('PTY generation is closed or exited');
      }
      throw new ForbiddenError('PTY generation token is stale or mismatched');
    }
    const pending = await client.query<{ bytes: string }>(
      `SELECT COALESCE(SUM(byte_length), 0)::text AS bytes
       FROM run_pty_input_requests WHERE generation_id = $1 AND applied_at IS NULL`,
      [row.id],
    );
    const pendingBytes = Number(pending.rows[0]?.bytes ?? 0);
    if (pendingBytes + input.length > MAX_PTY_PENDING_INPUT_BYTES) return false;
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO run_pty_input_requests (run_id, generation_id, input, byte_length)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [runId, row.id, input, input.length],
    );
    await client.query(
      `UPDATE pty_generations SET pending_input_bytes = $3,
       last_input_request_id = $4, updated_at = NOW() WHERE run_id = $1 AND id = $2`,
      [runId, row.id, pendingBytes + input.length, inserted.rows[0]?.id ?? null],
    );
    return toGenerationIdentity(row);
  });
}

export async function claimPendingRunPtyInput(generation: PtyGenerationRef, limit = 100): Promise<RunPtyInputRequest[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  return transaction(async (client) => {
    const authority = await client.query(
      `SELECT id FROM pty_generations
       WHERE run_id = $1 AND id = $2 AND generation_token = $3 AND is_active = TRUE
       FOR UPDATE`,
      [generation.runId, generation.generationId, generation.generationToken],
    );
    if (!authority.rows[0]) return [];
    const result = await client.query<RunPtyInputRequest & { byte_length: number }>(
      `DELETE FROM run_pty_input_requests
       WHERE id IN (
         SELECT id FROM run_pty_input_requests
         WHERE run_id = $1 AND generation_id = $2 AND applied_at IS NULL
         ORDER BY id ASC LIMIT $3 FOR UPDATE SKIP LOCKED
       ) RETURNING id, input, byte_length`,
      [generation.runId, generation.generationId, boundedLimit],
    );
    await client.query(
      `UPDATE pty_generations SET pending_input_bytes = GREATEST(0,
         pending_input_bytes - $3), updated_at = NOW() WHERE run_id = $1 AND id = $2`,
      [generation.runId, generation.generationId,
        result.rows.reduce((sum, item) => sum + Number(item.byte_length), 0)],
    );
    result.rows.sort((a, b) => Number(a.id) - Number(b.id));
    return result.rows.map((row) => ({
      id: row.id,
      input: Buffer.isBuffer(row.input) ? row.input : Buffer.from(row.input),
    }));
  });
}

function decodeRunPtyChunkRows(rows: StoredRunPtyChunkRow[], generation: PtyGenerationIdentity): RunPtyChunkRow[] {
  return rows.map((row) => ({
    sequence: Number(row.sequence),
    chunk: decompressRunPtyChunk(Buffer.isBuffer(row.chunk) ? row.chunk : Buffer.from(row.chunk), row.compression),
    generation,
  }));
}

/** Active generation wins; after exit the newest native generation wins; only
 * runs with no native generation fall back to their migration-created sentinel. */
export async function getRunPtyGeneration(runId: number, generationToken?: string | null): Promise<PtyGenerationIdentity | null> {
  const params: unknown[] = [runId];
  const tokenFilter = generationToken ? 'AND generation_token = $2' : '';
  if (generationToken) params.push(generationToken);
  const row = await queryOne<StoredPtyGenerationIdentityRow>(
    `SELECT id, generation_token, run_id, story_id, attempt, status, is_active, source, replay_source
     FROM pty_generations WHERE run_id = $1 ${tokenFilter}
     ORDER BY is_active DESC, (source = 'native') DESC, started_at DESC, id DESC LIMIT 1`,
    params,
  );
  return row ? toGenerationIdentity(row) : null;
}

export async function listRunPtyChunks(
  runId: number,
  afterSequence = 0,
  limit = getRunPtyOutputLimits().replayBatchChunks,
  selectedGeneration?: PtyGenerationIdentity | null,
): Promise<RunPtyChunkRow[]> {
  const boundedLimit = Math.min(4_096, Math.max(1, Math.floor(limit)));
  const generation = selectedGeneration ?? await getRunPtyGeneration(runId);
  if (!generation) return [];
  const rows = generation.source === 'legacy'
    ? generation.replaySource === 'legacy_run_output'
      ? await query<StoredRunPtyChunkRow>(
          `SELECT sequence, chunk, NULL::text AS compression FROM run_output_chunks
           WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3`,
          [runId, afterSequence, boundedLimit],
        )
      : await query<StoredRunPtyChunkRow>(
          `SELECT sequence, chunk, compression FROM run_pty_output_chunks
           WHERE run_id = $1 AND generation_id IS NULL AND sequence > $2
           ORDER BY sequence ASC LIMIT $3`,
          [runId, afterSequence, boundedLimit],
        )
    : await query<StoredRunPtyChunkRow>(
        `SELECT sequence, chunk, compression FROM run_pty_output_chunks
         WHERE run_id = $1 AND generation_id = $2 AND sequence > $3
         ORDER BY sequence ASC LIMIT $4`,
        [runId, generation.generationId, afterSequence, boundedLimit],
      );
  return decodeRunPtyChunkRows(rows, generation);
}

/** Bounded tail replay for first-time terminal attachments. */
export async function listRecentRunPtyChunks(
  runId: number,
  limit: number,
  selectedGeneration?: PtyGenerationIdentity | null,
): Promise<RunPtyChunkRow[]> {
  const generation = selectedGeneration ?? await getRunPtyGeneration(runId);
  if (!generation) return [];
  const table = generation.source === 'legacy' && generation.replaySource === 'legacy_run_output'
    ? 'run_output_chunks'
    : 'run_pty_output_chunks';
  const generationPredicate = generation.source === 'legacy'
    ? table === 'run_pty_output_chunks' ? 'AND generation_id IS NULL' : ''
    : 'AND generation_id = $3';
  const params: unknown[] = generation.source === 'native'
    ? [runId, limit, generation.generationId]
    : [runId, limit];
  const rows = await query<StoredRunPtyChunkRow>(
    `SELECT sequence, chunk, compression FROM (
       SELECT sequence, chunk, ${table === 'run_output_chunks' ? 'NULL::text' : 'compression'} AS compression
       FROM ${table} WHERE run_id = $1 ${generationPredicate}
       ORDER BY sequence DESC LIMIT $2
     ) recent ORDER BY sequence ASC`,
    params,
  );
  return decodeRunPtyChunkRows(rows, generation);
}

export async function getRunPtySequence(generation: PtyGenerationRef): Promise<number> {
  const row = await queryOne<{ max_sequence: number | string | null }>(
    `SELECT MAX(sequence) AS max_sequence FROM run_pty_output_chunks
     WHERE run_id = $1 AND generation_id = $2`,
    [generation.runId, generation.generationId],
  );
  return Number(row?.max_sequence ?? 0);
}

export async function getRunPtySessionStatus(runId: number): Promise<PtyGenerationStatus | null> {
  return (await getRunPtyGeneration(runId))?.status ?? null;
}

export async function getRunPtySessionHealth(runId: number, generationToken?: string | null): Promise<RunPtySessionHealth | null> {
  const params: unknown[] = [runId];
  const tokenFilter = generationToken ? 'AND generation_token = $2' : '';
  if (generationToken) params.push(generationToken);
  const row = await queryOne<StoredPtyGenerationIdentityRow & Omit<RunPtySessionHealth, keyof PtyGenerationIdentity>>(
    `SELECT id, generation_token, run_id, story_id, attempt, status, is_active, source, replay_source,
            workspace_id, cwd, agent_type, child_pid, cols, rows, next_output_sequence,
            total_stored_bytes, pending_input_bytes, last_input_request_id,
            last_resize_request_id, checkpoint_sequence, first_retained_sequence,
            retained_output_bytes, compacted_byte_count, checkpoint_at,
            checkpoint_reference, archive_reference, archive_checksum, archived_at,
            started_at, superseded_at, exited_at, exit_code, exit_signal,
            last_output_at, last_heartbeat_at, completion_marker,
            completion_marker_seen_at, completion_file_seen_at, completion_file_error,
            terminal_marker_seen_at, prompt_readiness_status, prompt_readiness_reason,
            prompt_ready_at, prompt_injected_at, total_output_bytes,
            dropped_output_bytes, output_truncated_at
     FROM pty_generations WHERE run_id = $1 ${tokenFilter}
     ORDER BY is_active DESC, (source = 'native') DESC, started_at DESC, id DESC LIMIT 1`,
    params,
  );
  return row ? { ...row, ...toGenerationIdentity(row) } : null;
}

export async function initializeRunPtySequence(generation: PtyGenerationRef): Promise<{ value: number }> {
  const row = await queryOne<{ next_output_sequence: number | string }>(
    `SELECT next_output_sequence FROM pty_generations
     WHERE run_id = $1 AND id = $2 AND generation_token = $3`,
    [generation.runId, generation.generationId, generation.generationToken],
  );
  // The generation counter survives complete delta eviction; MAX(chunk.sequence)
  // does not. This preserves monotonic logical sequencing after restart.
  return { value: Number(row?.next_output_sequence ?? 1) || 1 };
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
