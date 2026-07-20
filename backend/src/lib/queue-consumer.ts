/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { queryOne, execute } from '../db/index';
import { subscribe, broadcastAll, type WalEvent } from './sse-hub';
import { logger } from './logger';
import {
  currentWaveParallelPolicyEnvironment,
  enforceWaveParallelPolicy,
  WaveParallelPolicyError,
} from './wave-parallel-policy';

interface RunQueueEntry {
  id: number;
  workspace_id: number;
  spec_id: string;
  spec_path: string;
  parallelism: number;
  auto_worktree: number;
  position: number;
  status: string;
}

const RETRY_DELAY_MS = 5_000;

/**
 * Subscribes to WAL run_finished events and auto-triggers
 * the next pending queue entry for the same workspace.
 */
export function startQueueConsumer(): void {
  subscribe(handleWalEvent);
}

async function handleWalEvent(event: WalEvent): Promise<void> {
  if (event.event_type !== 'run_finished') return;
  if (!event.workspace_id) return;

  const workspaceId = event.workspace_id;

  // Find next pending entry for this workspace
  const entry = await queryOne<RunQueueEntry>(
    `SELECT * FROM run_queue WHERE workspace_id = $1 AND status = 'pending' ORDER BY position ASC LIMIT 1`,
    [Number(workspaceId)],
  );

  if (!entry) return; // Queue empty — no-op

  await triggerQueueEntry(entry);
}

async function triggerQueueEntry(entry: RunQueueEntry): Promise<void> {
  let wavePolicy;
  try {
    wavePolicy = enforceWaveParallelPolicy({
      source: 'run-queue-consumer',
      requestedMode: entry.parallelism > 1 ? 'wave-parallel' : 'sequential',
      requestedParallelism: entry.parallelism,
    }, currentWaveParallelPolicyEnvironment());
  } catch (error) {
    if (!(error instanceof WaveParallelPolicyError)) throw error;
    await markEntryFailed(entry, `${error.code}: ${error.message}`);
    return;
  }

  // Mark as triggering
  await execute(
    `UPDATE run_queue SET status = 'triggering' WHERE id = $1`,
    [entry.id],
  );

  // Make internal HTTP call to pipeline trigger (same code path as POST /api/pipeline/trigger)
  const port = process.env.PORT || 3030;
  const payload = JSON.stringify({
    specPath: entry.spec_path,
    workspaceId: String(entry.workspace_id),
    orchestrationMode: wavePolicy.mode,
    parallelism: wavePolicy.parallelism,
    autoWorktree: entry.auto_worktree === 1,
    triggerType: 'manual',
  });

  // Use dynamic import to avoid pulling in http at module level during tests
  const http = require('http') as typeof import('http');
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/api/pipeline/trigger',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
    (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', async () => {
        try {
          const result = JSON.parse(body);

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && result.ok) {
            // Success — mark triggered
            await execute(
              `UPDATE run_queue SET status = 'triggered', triggered_at = NOW() WHERE id = $1`,
              [entry.id],
            );

            // Emit WAL event
            await emitQueueTriggerEvent(entry);

            logger.info(`[QueueConsumer] Triggered run for spec ${entry.spec_id} (queue entry ${entry.id})`);
          } else if (result.conflict) {
            // Active run conflict — revert to pending, retry after delay
            await execute(
              `UPDATE run_queue SET status = 'pending' WHERE id = $1`,
              [entry.id],
            );

            logger.info(`[QueueConsumer] Conflict for workspace ${entry.workspace_id}, retrying in ${RETRY_DELAY_MS}ms`);
            setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
          } else {
            // Other error
            const errorMsg = result.error || `HTTP ${res.statusCode}`;
            await markEntryFailed(entry, errorMsg);
            setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
          }
        } catch (_parseErr) {
          await markEntryFailed(entry, `Response parse error: ${body.slice(0, 200)}`);
          setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
        }
      });
    },
  );

  req.on('error', async (err: Error) => {
    await markEntryFailed(entry, `Connection error: ${err.message}`);
    setTimeout(() => retryNextEntry(entry.workspace_id), RETRY_DELAY_MS);
  });

  req.write(payload);
  req.end();
}

async function markEntryFailed(entry: RunQueueEntry, errorMessage: string): Promise<void> {
  await execute(
    `UPDATE run_queue SET status = 'failed', error_message = $1 WHERE id = $2`,
    [errorMessage, entry.id],
  );
  logger.error(`[QueueConsumer] Failed to trigger spec ${entry.spec_id}: ${errorMessage}`);
}

async function retryNextEntry(workspaceId: number): Promise<void> {
  const next = await queryOne<RunQueueEntry>(
    `SELECT * FROM run_queue WHERE workspace_id = $1 AND status = 'pending' ORDER BY position ASC LIMIT 1`,
    [workspaceId],
  );

  if (next) {
    await triggerQueueEntry(next);
  }
}

async function emitQueueTriggerEvent(entry: RunQueueEntry): Promise<void> {
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, payload) VALUES ('run_queued_trigger', $1, $2, $3) RETURNING *`,
    [String(entry.workspace_id), entry.spec_id, JSON.stringify({ queuePosition: entry.position, queueEntryId: entry.id })],
  );

  if (walEvent) {
    broadcastAll(walEvent);
  }
}
