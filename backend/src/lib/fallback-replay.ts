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
  readFallbackJournal,
  type FallbackResultEntry,
} from './resilient-post';
import { logger } from './logger';
import { AppError } from './errors';
import {
  persistCanonicalStoryResult,
  STORY_RESULT_STATUSES,
  type CanonicalStoryResultInput,
  type CanonicalStoryResultStatus,
} from './story-result-persistence';

export interface FallbackReplayResult {
  total: number;
  inserted: number;
  duplicates: number;
  invalid: number;
  retained: boolean;
  incomplete: boolean;
  criticalTotal: number;
  criticalCompleted: number;
  criticalInvalid: number;
  criticalIncomplete: boolean;
  blocksCompletion: boolean;
}

function isCriticalEntry(entry: FallbackResultEntry): boolean {
  return entry.type === 'story_result' || !entry.coalesceKey;
}

export function fallbackReplayBlocksCompletion(result: FallbackReplayResult): boolean {
  return result.blocksCompletion
    || result.criticalInvalid > 0
    || result.criticalIncomplete
    || (result.retained && result.criticalTotal > 0);
}

function refreshReplayCompleteness(result: FallbackReplayResult): void {
  result.incomplete = result.inserted + result.duplicates + result.invalid !== result.total;
  result.criticalIncomplete = result.criticalCompleted + result.criticalInvalid !== result.criticalTotal;
  result.blocksCompletion = result.criticalInvalid > 0
    || result.criticalIncomplete
    || (result.retained && result.criticalTotal > 0);
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

function optionalString(value: unknown): string | undefined | null {
  return value === undefined ? undefined : typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | undefined | null {
  return value === undefined ? undefined : typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  return value === undefined ? undefined : typeof value === 'boolean' ? value : null;
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  return value === undefined
    ? undefined
    : Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null;
}

async function replayStoryResult(
  entry: FallbackResultEntry,
  workspaceId: string,
): Promise<'inserted' | 'duplicate' | 'invalid'> {
  const payload = entry.payload;
  const runId = Number(payload.runId ?? entry.runId);
  const storyId = payload.storyId ?? entry.storyId;
  const status = payload.status ?? entry.status;
  const ingestKey = derivedIngestKey(entry);
  const payloadIngestKey = optionalString(payload.idempotencyKey);
  const worktreePath = optionalString(payload.worktreePath);
  const worktreeBranch = optionalString(payload.worktreeBranch);
  const integrated = optionalBoolean(payload.integrated);
  const commitSha = optionalString(payload.commitSha);
  const commitMessage = optionalString(payload.commitMessage);
  const inputTokens = optionalNumber(payload.inputTokens);
  const outputTokens = optionalNumber(payload.outputTokens);
  const reasoningTokens = optionalNumber(payload.reasoningTokens);
  const modelUsed = optionalString(payload.modelUsed);
  const costUsd = optionalNumber(payload.costUsd);
  const logPath = optionalString(payload.logPath);
  const reason = optionalString(payload.reason);
  const blockedBy = optionalStringArray(payload.blockedBy);
  const activeSkills = optionalStringArray(payload.activeSkills);
  const completionPacket = payload.completionPacket;

  if (!Number.isSafeInteger(runId) || runId <= 0
    || typeof storyId !== 'string' || storyId.length === 0
    || typeof status !== 'string' || !STORY_RESULT_STATUSES.includes(status as CanonicalStoryResultStatus)
    || payloadIngestKey === null || (payloadIngestKey !== undefined && payloadIngestKey !== ingestKey)
    || integrated === null || (integrated === false && commitSha !== undefined)
    || worktreePath === null || worktreeBranch === null || commitSha === null || commitMessage === null
    || inputTokens === null || outputTokens === null || reasoningTokens === null
    || modelUsed === null || costUsd === null || logPath === null || reason === null
    || blockedBy === null || activeSkills === null
    || (commitSha !== undefined && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitSha))
    || (completionPacket !== undefined && (completionPacket === null
      || Array.isArray(completionPacket) || typeof completionPacket !== 'object'))) {
    return 'invalid';
  }

  const input: CanonicalStoryResultInput = {
    runId,
    storyId,
    status: status as CanonicalStoryResultStatus,
    worktreePath,
    worktreeBranch,
    integrated,
    commitSha,
    commitMessage,
    inputTokens,
    outputTokens,
    reasoningTokens,
    modelUsed,
    costUsd,
    logPath,
    reason,
    blockedBy,
    activeSkills,
    completionPacket: completionPacket as Record<string, unknown> | undefined,
    idempotencyKey: ingestKey,
    finishedAt: entry.ts,
    expectedWorkspaceId: workspaceId,
  };
  try {
    const outcome = await persistCanonicalStoryResult(input);
    return outcome.duplicate ? 'duplicate' : 'inserted';
  } catch (error) {
    if (error instanceof AppError) return 'invalid';
    throw error;
  }
}

/**
 * Replay is all-or-retain: the journal is removed only when every valid row was
 * inserted or recognized as a duplicate. A DB failure leaves the complete file
 * for the next worker reconciliation, and ingest keys make reprocessing safe.
 */
export async function replayFallbackResults(cwd: string, workspaceId: string): Promise<FallbackReplayResult> {
  await flushFallbackWrites(cwd);
  const journal = readFallbackJournal(cwd);
  const entries = journal.entries;
  const result: FallbackReplayResult = {
    total: entries.length + journal.malformed,
    inserted: 0,
    duplicates: 0,
    invalid: journal.malformed,
    retained: false,
    incomplete: false,
    criticalTotal: entries.filter(isCriticalEntry).length + journal.malformed,
    criticalCompleted: 0,
    criticalInvalid: journal.malformed,
    criticalIncomplete: false,
    blocksCompletion: false,
  };
  if (result.total === 0) return result;

  try {
    for (const entry of entries) {
      const outcome = entry.type === 'wal'
        ? await replayWal(entry, workspaceId)
        : await replayStoryResult(entry, workspaceId);
      const critical = isCriticalEntry(entry);
      result[outcome === 'inserted' ? 'inserted' : outcome === 'duplicate' ? 'duplicates' : 'invalid']++;
      if (critical && outcome !== 'invalid') result.criticalCompleted++;
      if (critical && outcome === 'invalid') result.criticalInvalid++;
    }
    if (result.invalid === 0) {
      refreshReplayCompleteness(result);
      deleteFallbackFile(cwd);
      logger.info({ cwd, ...result }, '[fallback-replay] Journal replay complete');
    } else {
      result.retained = true;
      refreshReplayCompleteness(result);
      logger.warn({ cwd, ...result }, '[fallback-replay] Invalid entries retained for operator review');
    }
  } catch (err) {
    result.retained = true;
    refreshReplayCompleteness(result);
    logger.warn({ err, cwd, ...result }, '[fallback-replay] Replay interrupted; journal retained');
  }

  refreshReplayCompleteness(result);
  return result;
}
