/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import { execute, query, transaction } from '../db/index';
import { CheckpointCorruptionError } from './errors';
import { logger } from './logger';
import {
  decodePtyCheckpoint,
  DEFAULT_MAX_PTY_CHECKPOINT_BYTES,
  PtyCheckpointEmulator,
  type EncodedPtyCheckpoint,
} from './pty-checkpoint-codec';
import { broadcastTopic } from './sse-hub';
import type { PtyGenerationRef } from './run-pty-store';

const DEFAULT_CHECKPOINT_TRIGGER_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHECKPOINT_HISTORY = 3;

export type PtyCaptureTelemetryEvent =
  | 'checkpoint_ready'
  | 'checkpoint_failure'
  | 'checkpoint_corruption'
  | 'queue_overflow'
  | 'database_latency'
  | 'malformed_ansi'
  | 'capture_loss';

export interface PtyCheckpointReadyEvent {
  run_id: number;
  story_id: string;
  generation_id: string;
  checkpoint_id: string;
  checkpoint_seq: number;
  first_retained_seq: number;
}

export interface RunPtyCheckpointRow {
  id: string;
  generation_id: string;
  run_id: number | string;
  story_id: string;
  checkpoint_seq: number | string;
  first_retained_seq: number | string;
  compacted_byte_count: number | string;
  compressed_blob: Buffer;
  checksum: string;
  version: number;
  terminal_cols: number;
  terminal_rows: number;
  created_at: string;
}

export interface ValidRunPtyCheckpoint {
  id: string;
  generationId: string;
  runId: number;
  storyId: string;
  checkpointSequence: number;
  firstRetainedSequence: number;
  compactedByteCount: number;
  terminalCols: number;
  terminalRows: number;
  version: number;
  checksum: string;
  serializedState: Buffer;
  createdAt: string;
}

export function runPtyCheckpointTopic(runId: number): string {
  return `run:${runId}:pty-checkpoint`;
}

/** Logging/SSE remain observable even when PostgreSQL is the failing subsystem. */
export function emitPtyCaptureTelemetry(
  event: PtyCaptureTelemetryEvent,
  generation: PtyGenerationRef & { storyId?: string },
  details: Record<string, unknown> = {},
): void {
  const payload = {
    event,
    run_id: generation.runId,
    generation_id: generation.generationId,
    story_id: generation.storyId ?? 'unknown',
    occurred_at: new Date().toISOString(),
    ...details,
  };
  logger.warn({ component: 'pty-capture', ...payload }, '[pty-capture] telemetry');
  broadcastTopic(`${runPtyCheckpointTopic(generation.runId)}:telemetry`, payload);
  void execute(
    `INSERT INTO pty_capture_telemetry (generation_id, run_id, story_id, event_type, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [generation.generationId, generation.runId, generation.storyId ?? 'unknown', event, JSON.stringify(details)],
  ).catch((error: unknown) => {
    logger.warn({ error, event, runId: generation.runId }, '[pty-capture] durable telemetry unavailable');
  });
}

function checkpointFromRow(row: RunPtyCheckpointRow): ValidRunPtyCheckpoint {
  const compressedBlob = Buffer.isBuffer(row.compressed_blob)
    ? row.compressed_blob
    : Buffer.from(row.compressed_blob);
  const serializedState = decodePtyCheckpoint({
    version: Number(row.version),
    compressedBlob,
    checksum: row.checksum.trim(),
  });
  return {
    id: row.id,
    generationId: row.generation_id,
    runId: Number(row.run_id),
    storyId: row.story_id,
    checkpointSequence: Number(row.checkpoint_seq),
    firstRetainedSequence: Number(row.first_retained_seq),
    compactedByteCount: Number(row.compacted_byte_count),
    terminalCols: Number(row.terminal_cols),
    terminalRows: Number(row.terminal_rows),
    version: Number(row.version),
    checksum: row.checksum.trim(),
    serializedState,
    createdAt: row.created_at,
  };
}

/** Newest valid checkpoint wins; corrupt rows are rejected before client reset. */
export async function getLatestValidRunPtyCheckpoint(
  generation: PtyGenerationRef & { storyId?: string },
): Promise<ValidRunPtyCheckpoint | null> {
  const rows = await query<RunPtyCheckpointRow>(
    `SELECT id, generation_id, run_id, story_id, checkpoint_seq,
            first_retained_seq, compacted_byte_count, compressed_blob,
            checksum, version, terminal_cols, terminal_rows, created_at
     FROM pty_checkpoints
     WHERE run_id = $1 AND generation_id = $2
     ORDER BY checkpoint_seq DESC, created_at DESC LIMIT 10`,
    [generation.runId, generation.generationId],
  );
  for (const row of rows) {
    try {
      return checkpointFromRow(row);
    } catch (error) {
      emitPtyCaptureTelemetry('checkpoint_corruption', generation, {
        checkpoint_id: row.id,
        checkpoint_seq: Number(row.checkpoint_seq),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

export async function getValidRunPtyCheckpointById(
  generation: PtyGenerationRef & { storyId?: string },
  checkpointId: string,
): Promise<ValidRunPtyCheckpoint> {
  const rows = await query<RunPtyCheckpointRow>(
    `SELECT id, generation_id, run_id, story_id, checkpoint_seq,
            first_retained_seq, compacted_byte_count, compressed_blob,
            checksum, version, terminal_cols, terminal_rows, created_at
     FROM pty_checkpoints
     WHERE id = $1 AND run_id = $2 AND generation_id = $3 LIMIT 1`,
    [checkpointId, generation.runId, generation.generationId],
  );
  const row = rows[0];
  if (!row) throw new CheckpointCorruptionError('PTY checkpoint is unavailable');
  try {
    return checkpointFromRow(row);
  } catch (error) {
    emitPtyCaptureTelemetry('checkpoint_corruption', generation, {
      checkpoint_id: row.id,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function persistCheckpointAndEvict(
  generation: PtyGenerationRef & { storyId: string },
  checkpointSequence: number,
  checkpoint: EncodedPtyCheckpoint,
): Promise<PtyCheckpointReadyEvent> {
  const checkpointId = randomUUID();
  const firstRetainedSequence = checkpointSequence + 1;

  // The insert is deliberately its own durable, fire-and-forget side effect at
  // the coordinator boundary. Eviction cannot begin until it has committed.
  await execute(
    `INSERT INTO pty_checkpoints
      (id, generation_id, run_id, story_id, checkpoint_seq, first_retained_seq,
       compressed_blob, checksum, version, terminal_cols, terminal_rows)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (generation_id, checkpoint_seq) DO NOTHING`,
    [checkpointId, generation.generationId, generation.runId, generation.storyId,
      checkpointSequence, firstRetainedSequence, checkpoint.compressedBlob,
      checkpoint.checksum, checkpoint.version, checkpoint.terminalCols, checkpoint.terminalRows],
  );

  const committed = await transaction(async (client) => {
    const locked = await client.query<RunPtyCheckpointRow>(
      `SELECT id, generation_id, run_id, story_id, checkpoint_seq,
              first_retained_seq, compacted_byte_count, compressed_blob,
              checksum, version, terminal_cols, terminal_rows, created_at
       FROM pty_checkpoints
       WHERE generation_id = $1 AND checkpoint_seq = $2 FOR UPDATE`,
      [generation.generationId, checkpointSequence],
    );
    const row = locked.rows[0];
    if (!row) throw new CheckpointCorruptionError('Committed PTY checkpoint could not be locked');
    // Validate the exact durable bytes, not the in-memory object, before delete.
    checkpointFromRow(row);

    // Preserve one valid fallback checkpoint plus the deltas after it. If the
    // newest blob later corrupts, the prior checkpoint can still reconstruct
    // forward without a historical repaint stream. The first checkpoint keeps
    // its covered raw rows until a second valid checkpoint commits.
    const priorRows = await client.query<RunPtyCheckpointRow>(
      `SELECT id, generation_id, run_id, story_id, checkpoint_seq,
              first_retained_seq, compacted_byte_count, compressed_blob,
              checksum, version, terminal_cols, terminal_rows, created_at
       FROM pty_checkpoints
       WHERE generation_id = $1 AND checkpoint_seq < $2
       ORDER BY checkpoint_seq DESC LIMIT 10 FOR UPDATE`,
      [generation.generationId, checkpointSequence],
    );
    let evictionSequence = 0;
    for (const prior of priorRows.rows) {
      try {
        checkpointFromRow(prior);
        evictionSequence = Number(prior.checkpoint_seq);
        break;
      } catch {
        // Invalid fallback rows are never used as eviction authority.
      }
    }
    const deleted = await client.query<{ byte_length: number }>(
      `DELETE FROM run_pty_output_chunks
       WHERE generation_id = $1 AND sequence <= $2
       RETURNING byte_length`,
      [generation.generationId, evictionSequence],
    );
    const compactedBytes = deleted.rows.reduce((sum, item) => sum + Number(item.byte_length), 0);
    const firstRetained = await client.query<{ sequence: number | string | null }>(
      `SELECT MIN(sequence) AS sequence FROM run_pty_output_chunks
       WHERE generation_id = $1`,
      [generation.generationId],
    );
    const actualFirstRetainedSequence = Number(firstRetained.rows[0]?.sequence ?? firstRetainedSequence);
    await client.query(
      `UPDATE pty_checkpoints
       SET first_retained_seq = $3, compacted_byte_count = $4
       WHERE generation_id = $1 AND checkpoint_seq = $2`,
      [generation.generationId, checkpointSequence, actualFirstRetainedSequence, compactedBytes],
    );
    await client.query(
      `UPDATE pty_generations
       SET checkpoint_sequence = GREATEST(checkpoint_sequence, $3),
           checkpoint_at = NOW(), checkpoint_reference = $4,
           first_retained_sequence = $5,
           retained_output_bytes = GREATEST(0, retained_output_bytes - $6),
           compacted_byte_count = compacted_byte_count + $6,
           updated_at = NOW()
       WHERE run_id = $1 AND id = $2`,
      [generation.runId, generation.generationId, checkpointSequence,
        `pty-checkpoint:${row.id}`, actualFirstRetainedSequence, compactedBytes],
    );
    return { checkpointId: row.id, compactedBytes, actualFirstRetainedSequence };
  });

  // Keep checkpoint storage bounded independently of delta retention.
  void execute(
    `DELETE FROM pty_checkpoints WHERE generation_id = $1 AND id NOT IN (
       SELECT id FROM pty_checkpoints WHERE generation_id = $1
       ORDER BY checkpoint_seq DESC, created_at DESC LIMIT $2
     )`,
    [generation.generationId, DEFAULT_CHECKPOINT_HISTORY],
  ).catch((error: unknown) => emitPtyCaptureTelemetry('checkpoint_failure', generation, {
    stage: 'checkpoint_prune', reason: error instanceof Error ? error.message : String(error),
  }));

  const event: PtyCheckpointReadyEvent = {
    run_id: generation.runId,
    story_id: generation.storyId,
    generation_id: generation.generationId,
    checkpoint_id: committed.checkpointId,
    checkpoint_seq: checkpointSequence,
    first_retained_seq: committed.actualFirstRetainedSequence,
  };
  broadcastTopic(runPtyCheckpointTopic(generation.runId), event);
  logger.info({ component: 'pty-capture', event: 'checkpoint_ready', ...event, compactedBytes: committed.compactedBytes }, '[pty-capture] telemetry');
  return event;
}

export interface PtyCheckpointCoordinatorOptions {
  cols: number;
  rows: number;
  storyId: string;
  checkpointTriggerBytes?: number;
  scrollback?: number;
  maxCheckpointBytes?: number;
}

/**
 * Owns terminal emulation and serial checkpoint scheduling for one generation.
 * `accept` never waits for xterm, compression, or PostgreSQL. At most one
 * checkpoint write is active; a newer requested sequence is coalesced behind it.
 */
export class PtyCheckpointCoordinator {
  private readonly generation: PtyGenerationRef & { storyId: string };
  private readonly emulator: PtyCheckpointEmulator;
  private readonly checkpointTriggerBytes: number;
  private latestSequence = 0;
  private requestedSequence = 0;
  private committedSequence = 0;
  private retainedBytes = 0;
  private checkpointPromise: Promise<void> | null = null;

  constructor(generation: PtyGenerationRef, options: PtyCheckpointCoordinatorOptions) {
    this.generation = { ...generation, storyId: options.storyId };
    this.checkpointTriggerBytes = options.checkpointTriggerBytes ?? DEFAULT_CHECKPOINT_TRIGGER_BYTES;
    this.emulator = new PtyCheckpointEmulator({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      maxCheckpointBytes: options.maxCheckpointBytes ?? DEFAULT_MAX_PTY_CHECKPOINT_BYTES,
      onMalformedInput: details => emitPtyCaptureTelemetry('malformed_ansi', this.generation, details),
    });
  }

  accept(chunks: readonly { sequence: number; chunk: Buffer }[], retainedBytes: number, retentionExceeded: boolean): void {
    for (const item of chunks) {
      this.emulator.accept(item.chunk);
      this.latestSequence = Math.max(this.latestSequence, item.sequence);
    }
    this.retainedBytes = retainedBytes;
    if (this.latestSequence > 0
      && this.emulator.isCheckpointBoundary()
      && (retentionExceeded || retainedBytes >= this.checkpointTriggerBytes)) {
      this.requestCheckpoint(this.latestSequence);
    }
  }

  resize(cols: number, rows: number): void {
    this.emulator.resize(cols, rows);
    if (this.latestSequence > this.committedSequence && this.emulator.isCheckpointBoundary()) {
      this.requestCheckpoint(this.latestSequence);
    }
  }

  noteCaptureLoss(bytes: number, reason: 'queue_overflow' | 'database_latency'): void {
    if (bytes <= 0) return;
    emitPtyCaptureTelemetry(reason, this.generation, { lost_bytes: bytes });
    emitPtyCaptureTelemetry('capture_loss', this.generation, { lost_bytes: bytes, reason });
  }

  async flush(): Promise<void> {
    if (this.latestSequence > this.committedSequence && this.emulator.isCheckpointBoundary()) {
      this.requestCheckpoint(this.latestSequence);
    }
    while (this.checkpointPromise) {
      const active = this.checkpointPromise;
      await active;
      // A coalesced newer snapshot may have been installed by active.finally().
      if (this.checkpointPromise === active) break;
    }
  }

  dispose(): void {
    this.emulator.dispose();
  }

  private requestCheckpoint(sequence: number): void {
    this.requestedSequence = Math.max(this.requestedSequence, sequence);
    if (this.checkpointPromise) return;
    // Calling capture immediately places the emulator snapshot barrier before
    // any later accept() writes, while the returned promise remains non-blocking.
    const captureSequence = this.requestedSequence;
    const snapshot = this.emulator.serialize();
    this.checkpointPromise = snapshot
      .then(checkpoint => persistCheckpointAndEvict(this.generation, captureSequence, checkpoint))
      .then(() => {
        this.committedSequence = Math.max(this.committedSequence, captureSequence);
        this.retainedBytes = 0;
      })
      .catch((error: unknown) => {
        emitPtyCaptureTelemetry('checkpoint_failure', this.generation, {
          checkpoint_seq: captureSequence,
          reason: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.checkpointPromise = null;
        if (this.requestedSequence > captureSequence) this.requestCheckpoint(this.requestedSequence);
      });
  }
}
