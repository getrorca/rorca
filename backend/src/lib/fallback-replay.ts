/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Replay execution-engine fallback journals after the child has fully closed. */

import { createHash } from 'crypto';
import { queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import {
  deleteFallbackFile,
  flushFallbackWrites,
  readFallbackResults,
  type FallbackResultEntry,
} from './resilient-post';
import { logger } from './logger';

export interface FallbackReplayResult {
  total: number;
  inserted: number;
  duplicates: number;
  invalid: number;
  retained: boolean;
}

function derivedIngestKey(entry: FallbackResultEntry): string {
  if (entry.idempotencyKey) return entry.idempotencyKey;
  return `fallback:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}`;
}

async function isLegacyWalDuplicate(entry: FallbackResultEntry, workspaceId: string): Promise<boolean> {
  if (entry.idempotencyKey) return false;
  const payload = entry.payload;
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM wal_events
      WHERE event_type = $1
        AND workspace_id IS NOT DISTINCT FROM $2
        AND story_id IS NOT DISTINCT FROM $3
        AND payload IS NOT DISTINCT FROM $4::jsonb
        AND ts BETWEEN $5::timestamptz - INTERVAL '2 minutes' AND $5::timestamptz + INTERVAL '2 minutes'
      ORDER BY id DESC LIMIT 1`,
    [
      payload.event_type ?? entry.status,
      payload.workspace_id ?? workspaceId,
      payload.story_id ?? entry.storyId,
      JSON.stringify(payload.payload ?? payload),
      entry.ts,
    ],
  );
  return Boolean(existing);
}

async function replayWal(entry: FallbackResultEntry, workspaceId: string): Promise<'inserted' | 'duplicate' | 'invalid'> {
  const payload = entry.payload;
  const eventType = payload.event_type ?? entry.status;
  if (typeof eventType !== 'string' || eventType.length === 0) return 'invalid';
  if (await isLegacyWalDuplicate(entry, workspaceId)) return 'duplicate';

  const ingestKey = derivedIngestKey(entry);
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload, ingest_key, ts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
     ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      eventType,
      payload.workspace_id ?? workspaceId,
      payload.spec_id ?? null,
      payload.story_id ?? entry.storyId,
      JSON.stringify(payload.payload ?? payload),
      ingestKey,
      payload.occurred_at ?? entry.ts,
    ],
  );
  if (!walEvent) return 'duplicate';
  broadcastAll(walEvent);
  return 'inserted';
}

async function isLegacyStoryResultDuplicate(entry: FallbackResultEntry): Promise<boolean> {
  if (entry.idempotencyKey) return false;
  const payload = entry.payload;
  const runId = Number(payload.runId ?? entry.runId);
  const storyId = payload.storyId ?? entry.storyId;
  const status = payload.status ?? entry.status;
  const existing = await queryOne<{ id: number }>(
    `SELECT id FROM story_results
      WHERE run_id = $1 AND story_id = $2 AND status = $3
      ORDER BY id DESC LIMIT 1`,
    [runId, storyId, status],
  );
  return Boolean(existing);
}

async function replayStoryResult(entry: FallbackResultEntry): Promise<'inserted' | 'duplicate' | 'invalid'> {
  const payload = entry.payload;
  const runId = Number(payload.runId ?? entry.runId);
  const storyId = payload.storyId ?? entry.storyId;
  const status = payload.status ?? entry.status;
  if (!Number.isSafeInteger(runId) || runId <= 0 || typeof storyId !== 'string' || typeof status !== 'string') {
    return 'invalid';
  }
  if (await isLegacyStoryResultDuplicate(entry)) return 'duplicate';

  const inserted = await queryOne<{ id: number }>(
    `INSERT INTO story_results
       (run_id, story_id, status, finished_at, worktree_path, worktree_branch,
        input_tokens, output_tokens, model_used, cost_usd, log_path, blocked_by,
        active_skills, ingest_key)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      runId,
      storyId,
      status,
      entry.ts,
      payload.worktreePath ?? null,
      payload.worktreeBranch ?? null,
      payload.inputTokens ?? null,
      payload.outputTokens ?? null,
      payload.modelUsed ?? null,
      payload.costUsd ?? null,
      payload.logPath ?? null,
      Array.isArray(payload.blockedBy) ? JSON.stringify(payload.blockedBy) : null,
      Array.isArray(payload.activeSkills) ? JSON.stringify(payload.activeSkills) : null,
      derivedIngestKey(entry),
    ],
  );
  return inserted ? 'inserted' : 'duplicate';
}

/**
 * Replay is all-or-retain: the journal is removed only when every valid row was
 * inserted or recognized as a duplicate. A DB failure leaves the complete file
 * for the next worker reconciliation, and ingest keys make reprocessing safe.
 */
export async function replayFallbackResults(cwd: string, workspaceId: string): Promise<FallbackReplayResult> {
  await flushFallbackWrites(cwd);
  const entries = readFallbackResults(cwd);
  const result: FallbackReplayResult = {
    total: entries.length,
    inserted: 0,
    duplicates: 0,
    invalid: 0,
    retained: false,
  };
  if (entries.length === 0) return result;

  try {
    for (const entry of entries) {
      const outcome = entry.type === 'wal'
        ? await replayWal(entry, workspaceId)
        : await replayStoryResult(entry);
      result[outcome === 'inserted' ? 'inserted' : outcome === 'duplicate' ? 'duplicates' : 'invalid']++;
    }
    if (result.invalid === 0) {
      deleteFallbackFile(cwd);
      logger.info({ cwd, ...result }, '[fallback-replay] Journal replay complete');
    } else {
      result.retained = true;
      logger.warn({ cwd, ...result }, '[fallback-replay] Invalid entries retained for operator review');
    }
  } catch (err) {
    result.retained = true;
    logger.warn({ err, cwd, ...result }, '[fallback-replay] Replay interrupted; journal retained');
  }
  return result;
}
