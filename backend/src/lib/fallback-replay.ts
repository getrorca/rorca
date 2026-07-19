/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Replay execution-engine fallback journals after the child has fully closed. */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { query, queryOne } from '../db/index';
import { broadcastAll, type WalEvent } from './sse-hub';
import {
  deleteFallbackFile,
  flushFallbackWrites,
  getFallbackFilename,
  readFallbackJournal,
  type FallbackResultEntry,
} from './resilient-post';
import { logger } from './logger';
import { AppError } from './errors';
import {
  GITHUB_GOVERNING_WAL_EVENTS,
  relayTrustedWalEvent,
  type TrustedWalReference,
} from './trusted-wal';
import {
  STORY_RESULT_STATUSES,
  verifyReleasedHostResultProposal,
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

interface JournalRunBinding {
  id: number | string;
  workspace_id: string;
  spec_path: string;
}

async function loadJournalRun(entry: FallbackResultEntry, workspaceId: string): Promise<JournalRunBinding | undefined> {
  if (!Number.isSafeInteger(entry.runId) || entry.runId <= 0) return undefined;
  return queryOne<JournalRunBinding>(
    'SELECT id, workspace_id, spec_path FROM pipeline_runs WHERE id = $1 AND workspace_id = $2',
    [entry.runId, workspaceId],
  );
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
      workspaceId,
      payload.story_id ?? entry.storyId,
      JSON.stringify(payload.payload ?? payload),
      entry.ts,
    ],
  );
  return Boolean(existing);
}

function parseTrustedRelay(value: unknown): TrustedWalReference | null {
  if (!value || Array.isArray(value) || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.id) || Number(candidate.id) <= 0
    || typeof candidate.ingestKey !== 'string'
    || !candidate.ingestKey.startsWith('trusted-wal:')
    || typeof candidate.identityHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.identityHash)
    || typeof candidate.eventType !== 'string'
    || typeof candidate.workspaceId !== 'string'
    || !Number.isSafeInteger(candidate.runId) || Number(candidate.runId) <= 0
    || typeof candidate.specId !== 'string'
    || !(candidate.storyId === null || typeof candidate.storyId === 'string')
    || !['execution-engine', 'worker', 'story-result'].includes(String(candidate.source))
    || !(candidate.storyResultId === null
      || (Number.isSafeInteger(candidate.storyResultId) && Number(candidate.storyResultId) > 0))
    || (candidate.source === 'story-result') !== (candidate.storyResultId !== null)
    || !candidate.payload || Array.isArray(candidate.payload) || typeof candidate.payload !== 'object') {
    return null;
  }
  return candidate as unknown as TrustedWalReference;
}

async function replayWal(
  entry: FallbackResultEntry,
  workspaceId: string,
  canonicalSpecId: string,
): Promise<'inserted' | 'duplicate' | 'invalid'> {
  const payload = entry.payload;
  const eventType = payload.event_type ?? entry.status;
  if (typeof eventType !== 'string' || eventType.length === 0) return 'invalid';

  if (GITHUB_GOVERNING_WAL_EVENTS.has(eventType)) {
    const reference = parseTrustedRelay(payload.trusted_relay);
    if (!reference
      || reference.eventType !== eventType
      || reference.workspaceId !== workspaceId
      || reference.runId !== entry.runId
      || reference.specId !== canonicalSpecId
      || reference.storyId !== entry.storyId
      || entry.idempotencyKey !== reference.ingestKey) {
      return 'invalid';
    }
    try {
      if (reference.source === 'story-result') {
        // A retained agent-writable pointer cannot release an inert pass outbox.
        // Host recovery first proves the file/branch/ordered-successor state and
        // marks the exact row ready; journal replay can then only re-notify it.
        const released = await queryOne<{ id: number }>(`
          SELECT id FROM wal_events
           WHERE id = $1 AND ingest_key = $2 AND event_identity_hash = $3
             AND workspace_id = $4 AND canonical_run_id = $5
             AND story_result_id = $6 AND trust_provenance = 'host'
             AND trusted_source = 'story-result' AND outbox_ready_at IS NOT NULL
        `, [reference.id, reference.ingestKey, reference.identityHash,
          reference.workspaceId, reference.runId, reference.storyResultId]);
        if (!released) return 'invalid';
      }
      await relayTrustedWalEvent(reference);
      return 'duplicate';
    } catch (error) {
      if (error instanceof AppError) return 'invalid';
      throw error;
    }
  }

  const nestedPayload = payload.payload ?? payload;
  if (!nestedPayload || Array.isArray(nestedPayload) || typeof nestedPayload !== 'object') return 'invalid';
  const nestedRecord = nestedPayload as Record<string, unknown>;
  const nestedRunId = Number(nestedRecord.run_id ?? entry.runId);
  const payloadStoryId = payload.story_id ?? nestedRecord.story_id ?? entry.storyId;
  if (nestedRunId !== entry.runId || payloadStoryId !== entry.storyId) return 'invalid';
  if (await isLegacyWalDuplicate(entry, workspaceId)) return 'duplicate';

  const ingestKey = derivedIngestKey(entry);
  if (ingestKey.startsWith('trusted-wal:')) return 'invalid';
  const walEvent = await queryOne<WalEvent>(
    `INSERT INTO wal_events (
       event_type, workspace_id, spec_id, story_id, payload, ingest_key, ts,
       trust_provenance, trusted_source, canonical_run_id, event_identity_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, 'untrusted', NULL, NULL, NULL)
     ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      eventType,
      workspaceId,
      canonicalSpecId,
      entry.storyId,
      JSON.stringify(nestedPayload),
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
  const trustedPassOutbox = payload.trustedPassOutbox;
  const validTrustedPassOutbox = trustedPassOutbox === undefined
    || (trustedPassOutbox !== null
      && !Array.isArray(trustedPassOutbox)
      && typeof trustedPassOutbox === 'object'
      && (trustedPassOutbox as Record<string, unknown>).payload !== null
      && !Array.isArray((trustedPassOutbox as Record<string, unknown>).payload)
      && typeof (trustedPassOutbox as Record<string, unknown>).payload === 'object');

  if (!Number.isSafeInteger(runId) || runId <= 0 || runId !== entry.runId
    || typeof storyId !== 'string' || storyId.length === 0 || storyId !== entry.storyId
    || typeof status !== 'string' || status !== entry.status
    || !STORY_RESULT_STATUSES.includes(status as CanonicalStoryResultStatus)
    || payloadIngestKey === null || (payloadIngestKey !== undefined && payloadIngestKey !== ingestKey)
    || integrated === null || (integrated === false && commitSha !== undefined)
    || worktreePath === null || worktreeBranch === null || commitSha === null || commitMessage === null
    || inputTokens === null || outputTokens === null || reasoningTokens === null
    || modelUsed === null || costUsd === null || logPath === null || reason === null
    || blockedBy === null || activeSkills === null || !validTrustedPassOutbox
    || (commitSha !== undefined && !/^[0-9a-f]{40}$/i.test(commitSha))
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
    // Untrusted evidence is forwarded only to the read-only immutable duplicate
    // comparator below. This function never calls the canonical writer.
    trustedPassOutbox: trustedPassOutbox as CanonicalStoryResultInput['trustedPassOutbox'],
    idempotencyKey: ingestKey,
    finishedAt: entry.ts,
    expectedWorkspaceId: workspaceId,
  };
  try {
    // Every agent-writable result status is proposal-only. It is accepted only
    // as an exact reference to an independently immutable host result; replay
    // never inserts terminal story authority.
    return await verifyReleasedHostResultProposal(input) ? 'duplicate' : 'invalid';
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
      const run = await loadJournalRun(entry, workspaceId);
      if (!run) {
        result.invalid++;
        if (isCriticalEntry(entry)) result.criticalInvalid++;
        continue;
      }
      const canonicalSpecId = path.basename(run.spec_path, '.json');
      const outcome = entry.type === 'wal'
        ? await replayWal(entry, workspaceId, canonicalSpecId)
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

/** Startup scan of deterministic run roots; no recursive repository crawl. */
export async function replayRetainedRunJournals(limit = 2_000): Promise<{
  scannedRoots: number;
  blockedRoots: Array<{ workspaceId: string; cwd: string }>;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError('Retained journal startup scan limit must be between 1 and 10000');
  }
  const runs = await query<{ workspace_id: string; worktree_path: string | null; workspace_path: string }>(`
    SELECT DISTINCT pr.workspace_id, pr.worktree_path, ws.path AS workspace_path
      FROM pipeline_runs pr
      JOIN workspaces ws ON ws.id = pr.workspace_id
     WHERE pr.expected_story_ids IS NOT NULL
     ORDER BY pr.workspace_id, pr.worktree_path NULLS FIRST
     LIMIT $1
  `, [limit]);
  const roots = new Map<string, string>();
  for (const run of runs) {
    const cwd = path.resolve(run.worktree_path ?? run.workspace_path);
    roots.set(`${run.workspace_id}\u0000${cwd}`, run.workspace_id);
  }
  const blockedRoots: Array<{ workspaceId: string; cwd: string }> = [];
  let scannedRoots = 0;
  for (const [key, workspaceId] of roots) {
    const cwd = key.slice(key.indexOf('\u0000') + 1);
    if (!fs.existsSync(path.join(cwd, getFallbackFilename()))) continue;
    scannedRoots++;
    const replay = await replayFallbackResults(cwd, workspaceId);
    if (fallbackReplayBlocksCompletion(replay)) blockedRoots.push({ workspaceId, cwd });
  }
  return { scannedRoots, blockedRoots };
}
