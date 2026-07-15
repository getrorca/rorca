/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { closePool, execute, queryOne } from '../src/db/index';
import {
  appendRunPtyOutputBatch,
  completeRunPtySession,
  createRunPtyOutputBatcher,
  initializeRunPtySequence,
  listRunPtyChunks,
  startRunPtySession,
} from '../src/lib/run-pty-store';

const TARGET_BYTES = Number.parseInt(process.env.RORCA_PTY_SOAK_BYTES ?? '', 10) || 8 * 1024 * 1024;
const BATCH_BYTES = 64 * 1024;
const SMALL_CHUNKS = 10_000;

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
    await execute('INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)', [workspaceId, 'PTY v2 soak', process.cwd()]);
    const run = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_runs (spec_path, workspace_id, status, terminal_mode, agent, agent_type)
       VALUES ('forge/specs/approved/pty-soak.json', $1, 'running', 'pty', 'pi', 'pi') RETURNING id`,
      [workspaceId],
    );
    runId = Number(run!.id);
    await startRunPtySession({ runId, workspaceId, cwd: process.cwd(), agentType: 'pi', cols: 120, rows: 36, childPid: null });

    const sequence = await initializeRunPtySequence(runId);
    const latenciesMs: number[] = [];
    const expectedHash = createHash('sha256');
    let written = 0;
    let batchIndex = 0;
    while (written < TARGET_BYTES) {
      const length = Math.min(BATCH_BYTES, TARGET_BYTES - written);
      const prefix = Buffer.from(`batch=${batchIndex}; utf8=🙂漢字;\r\n`, 'utf8');
      const buffer = Buffer.alloc(length, batchIndex % 251);
      prefix.copy(buffer, 0, 0, Math.min(prefix.length, buffer.length));
      expectedHash.update(buffer);
      const before = performance.now();
      await appendRunPtyOutputBatch(runId, [buffer], sequence);
      latenciesMs.push(performance.now() - before);
      written += length;
      batchIndex += 1;
    }

    // A small-chunk flood exercises the push-only callback queue and batching.
    const flood = createRunPtyOutputBatcher(runId, sequence, { maxPendingBytes: 2 * 1024 * 1024 });
    const floodChunk = Buffer.from('x🙂y\r\n', 'utf8');
    for (let index = 0; index < SMALL_CHUNKS; index += 1) {
      flood.enqueue(floodChunk);
      expectedHash.update(floodChunk);
    }
    await flood.drain();
    written += floodChunk.length * SMALL_CHUNKS;
    await completeRunPtySession(runId, 'exited', 0, null);

    // Replay in bounded cursor pages and verify byte/UTF-8 boundaries exactly.
    const replayHash = createHash('sha256');
    let cursor = 0;
    let replayed = 0;
    let pages = 0;
    while (true) {
      const rows = await listRunPtyChunks(runId, cursor, 512);
      if (rows.length === 0) break;
      pages += 1;
      for (const row of rows) {
        replayHash.update(row.chunk);
        replayed += row.chunk.length;
        cursor = row.sequence;
      }
    }

    const health = await queryOne<{
      total_output_bytes: string;
      total_stored_bytes: string;
      dropped_output_bytes: string;
      chunks: string;
      db_bytes: string;
      db_row_bytes: string;
    }>(
      `SELECT s.total_output_bytes::text, s.total_stored_bytes::text, s.dropped_output_bytes::text,
              COUNT(c.sequence)::text AS chunks,
              COALESCE(SUM(octet_length(c.chunk)), 0)::text AS db_bytes,
              COALESCE(SUM(pg_column_size(c)), 0)::text AS db_row_bytes
       FROM run_pty_sessions s
       LEFT JOIN run_pty_output_chunks c ON c.run_id = s.run_id
       WHERE s.run_id = $1
       GROUP BY s.run_id`,
      [runId],
    );

    const elapsedMs = performance.now() - started;
    const rssDelta = process.memoryUsage().rss - rssStart;
    const elu = performance.eventLoopUtilization(eluStart);
    eventLoop.disable();
    const result = {
      platform: `${process.platform}/${process.arch}`,
      targetBytes: TARGET_BYTES,
      observedBytes: Number(health?.total_output_bytes ?? 0),
      replayedBytes: replayed,
      droppedBytes: Number(health?.dropped_output_bytes ?? 0),
      chunks: Number(health?.chunks ?? 0),
      replayPages: pages,
      dbPayloadBytes: Number(health?.db_bytes ?? 0),
      dbLogicalRowBytes: Number(health?.db_row_bytes ?? 0),
      storedBytesAccounted: Number(health?.total_stored_bytes ?? 0),
      hashMatch: replayHash.digest('hex') === expectedHash.digest('hex'),
      throughputMiBPerSecond: round((written / (1024 * 1024)) / (elapsedMs / 1000)),
      batchLatencyMs: {
        p50: round(percentile(latenciesMs, 0.50)),
        p95: round(percentile(latenciesMs, 0.95)),
        p99: round(percentile(latenciesMs, 0.99)),
        max: round(Math.max(...latenciesMs)),
      },
      eventLoop: {
        utilization: round(elu.utilization, 4),
        delayMeanMs: round(eventLoop.mean / 1e6),
        delayP99Ms: round(eventLoop.percentile(99) / 1e6),
        delayMaxMs: round(eventLoop.max / 1e6),
      },
      rssDeltaBytes: rssDelta,
      elapsedMs: round(elapsedMs),
      smallChunkFloodCount: SMALL_CHUNKS,
    };

    if (!result.hashMatch || result.replayedBytes !== result.observedBytes || result.droppedBytes !== 0) {
      throw new Error(`PTY soak integrity failure: ${JSON.stringify(result)}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    eventLoop.disable();
    if (workspaceId) {
      await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]).catch(() => undefined);
    }
    await closePool();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
