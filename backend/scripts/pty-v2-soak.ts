/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { closePool, execute, queryOne } from '../src/db/index';
import { getLatestValidRunPtyCheckpoint } from '../src/lib/pty-checkpoint-store';
import {
  completeRunPtySession,
  createRunPtyOutputBatcher,
  initializeRunPtySequence,
  startRunPtySession,
  type PtyGenerationRef,
} from '../src/lib/run-pty-store';

const CURRENT_RETENTION_BYTES = 64 * 1024 * 1024;
// Acceptance fixture: at least four times the historical prefix-only limit.
const TARGET_BYTES = Number.parseInt(process.env.RORCA_PTY_SOAK_BYTES ?? '', 10) || 4 * CURRENT_RETENTION_BYTES;
const BATCH_BYTES = 64 * 1024;
const SMALL_CHUNKS = 10_000;
const FINAL_VIEWPORT_MARKER = '__PTY_ROLLING_FINAL_VIEWPORT__';

function assertTestDatabase(): void {
  const raw = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL || '';
  let database = '';
  try { database = new URL(raw).pathname.replace(/^\//, ''); } catch { /* rejected below */ }
  if (!database.endsWith('_test')) {
    throw new Error('PTY soak refuses to run unless DATABASE_URL_TEST or DATABASE_URL names a *_test database');
  }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

async function yieldUntilBelow(writer: ReturnType<typeof createRunPtyOutputBatcher>, bytes: number): Promise<void> {
  while (writer.getPendingBytes() > bytes) {
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function main(): Promise<void> {
  assertTestDatabase();
  const workspaceId = `pty-soak-${randomUUID()}`;
  let runId = 0;
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  const eluStart = performance.eventLoopUtilization();
  const rssStart = process.memoryUsage().rss;
  const started = performance.now();

  try {
    await execute('INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)', [workspaceId, 'PTY rolling soak', process.cwd()]);
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode, agent, agent_type)
       VALUES ('forge/specs/approved/pty-soak.json', $1, 'running', 'pty', 'pi', 'pi') RETURNING id`,
      [workspaceId],
    );
    runId = Number(run!.id);
    const generation = await startRunPtySession({
      runId,
      workspaceId,
      storyId: 'PTY-SOAK',
      attempt: 1,
      cwd: process.cwd(),
      agentType: 'pi',
      cols: 120,
      rows: 36,
      childPid: null,
    });
    const generationRef: PtyGenerationRef = {
      runId,
      generationId: generation.generationId,
      generationToken: generation.generationToken,
    };
    const sequence = await initializeRunPtySequence(generationRef);
    const writer = createRunPtyOutputBatcher(generationRef, sequence, {
      maxCaptureBytes: CURRENT_RETENTION_BYTES,
      maxPendingBytes: CURRENT_RETENTION_BYTES,
      batchBytes: BATCH_BYTES,
      batchChunks: 16,
    }, { storyId: 'PTY-SOAK', cols: 120, rows: 36 });

    const enqueueLatenciesMs: number[] = [];
    let written = 0;
    let batchIndex = 0;
    while (written < TARGET_BYTES) {
      const length = Math.min(BATCH_BYTES, TARGET_BYTES - written);
      // Repaint-heavy output proves checkpoint recovery does not retain/replay
      // the complete historical TUI stream.
      const line = Buffer.from(`\r\x1b[2Kbatch=${batchIndex}; utf8=🙂漢字; ${'x'.repeat(512)}`, 'utf8');
      const buffer = Buffer.alloc(length, 0x20);
      for (let offset = 0; offset < buffer.length; offset += line.length) {
        line.copy(buffer, offset, 0, Math.min(line.length, buffer.length - offset));
      }
      const before = performance.now();
      writer.enqueue(buffer);
      enqueueLatenciesMs.push(performance.now() - before);
      written += length;
      batchIndex += 1;
      if (writer.getPendingBytes() > CURRENT_RETENTION_BYTES / 2) {
        await yieldUntilBelow(writer, CURRENT_RETENTION_BYTES / 4);
      } else if (batchIndex % 16 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    const floodChunk = Buffer.from('x🙂y\r\n', 'utf8');
    for (let index = 0; index < SMALL_CHUNKS; index += 1) writer.enqueue(floodChunk);
    written += floodChunk.length * SMALL_CHUNKS;
    writer.enqueue(Buffer.from(`\r\n${FINAL_VIEWPORT_MARKER}\r\n`, 'utf8'));
    written += Buffer.byteLength(`\r\n${FINAL_VIEWPORT_MARKER}\r\n`);
    await writer.drain();
    await completeRunPtySession(generationRef, 'exited', 0, null);

    const checkpoint = await getLatestValidRunPtyCheckpoint({ ...generationRef, storyId: 'PTY-SOAK' });
    const health = await queryOne<{
      total_output_bytes: string;
      total_stored_bytes: string;
      retained_output_bytes: string;
      dropped_output_bytes: string;
      compacted_byte_count: string;
      checkpoint_sequence: string;
      first_retained_sequence: string;
      chunks: string;
      db_bytes: string;
      db_row_bytes: string;
    }>(
      `SELECT g.total_output_bytes::text, g.total_stored_bytes::text,
              g.retained_output_bytes::text, g.dropped_output_bytes::text,
              g.compacted_byte_count::text, g.checkpoint_sequence::text,
              g.first_retained_sequence::text,
              COUNT(c.sequence)::text AS chunks,
              COALESCE(SUM(octet_length(c.chunk)), 0)::text AS db_bytes,
              COALESCE(SUM(pg_column_size(c)), 0)::text AS db_row_bytes
       FROM pty_generations g
       LEFT JOIN run_pty_output_chunks c ON c.generation_id = g.id
       WHERE g.id = $1 GROUP BY g.id`,
      [generation.generationId],
    );

    const elapsedMs = performance.now() - started;
    const elu = performance.eventLoopUtilization(eluStart);
    eventLoop.disable();
    const result = {
      platform: `${process.platform}/${process.arch}`,
      targetBytes: TARGET_BYTES,
      observedBytes: Number(health?.total_output_bytes ?? 0),
      droppedBytes: Number(health?.dropped_output_bytes ?? 0),
      retainedBytes: Number(health?.retained_output_bytes ?? 0),
      compactedBytes: Number(health?.compacted_byte_count ?? 0),
      checkpointSequence: Number(health?.checkpoint_sequence ?? 0),
      firstRetainedSequence: Number(health?.first_retained_sequence ?? 1),
      checkpointCompressedBytes: checkpoint?.serializedState.length ?? 0,
      finalViewportRecoverable: checkpoint?.serializedState.toString('utf8').includes(FINAL_VIEWPORT_MARKER) ?? false,
      chunks: Number(health?.chunks ?? 0),
      dbPayloadBytes: Number(health?.db_bytes ?? 0),
      dbLogicalRowBytes: Number(health?.db_row_bytes ?? 0),
      throughputMiBPerSecond: round((written / (1024 * 1024)) / (elapsedMs / 1000)),
      enqueueLatencyMs: {
        p50: round(percentile(enqueueLatenciesMs, 0.50)),
        p95: round(percentile(enqueueLatenciesMs, 0.95)),
        p99: round(percentile(enqueueLatenciesMs, 0.99)),
        max: round(Math.max(...enqueueLatenciesMs)),
      },
      eventLoop: {
        utilization: round(elu.utilization, 4),
        delayMeanMs: round(eventLoop.mean / 1e6),
        delayP99Ms: round(eventLoop.percentile(99) / 1e6),
        delayMaxMs: round(eventLoop.max / 1e6),
      },
      rssDeltaBytes: process.memoryUsage().rss - rssStart,
      elapsedMs: round(elapsedMs),
      smallChunkFloodCount: SMALL_CHUNKS,
    };

    if (result.observedBytes !== written
      || result.droppedBytes !== 0
      || result.retainedBytes > CURRENT_RETENTION_BYTES
      || result.checkpointSequence <= 0
      || !result.finalViewportRecoverable
      || TARGET_BYTES < CURRENT_RETENTION_BYTES * 4) {
      throw new Error(`PTY rolling soak integrity failure: ${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    eventLoop.disable();
    if (workspaceId) await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
