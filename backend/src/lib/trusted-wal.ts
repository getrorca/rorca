/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Host-owned transactional WAL outbox and exact retryable relay. */

import { createHash } from 'crypto';
import * as path from 'path';
import type { PoolClient } from 'pg';
import { execute, query, queryOne, transaction } from '../db/index';
import { ConflictError, NotFoundError } from './errors';
import type { WalEvent } from './sse-hub';

export const GITHUB_GOVERNING_WAL_EVENTS = new Set([
  'run_started',
  'story_started',
  'story_passed',
  'story_failed',
  'story_skipped',
  'run_finished',
]);

export type TrustedWalSource = 'execution-engine' | 'worker' | 'story-result';

export interface TrustedWalInput {
  eventType: string;
  workspaceId: string;
  runId: number;
  storyId?: string | null;
  specId?: string | null;
  source: TrustedWalSource;
  /** Required only for the canonical story-result pass outbox. */
  storyResultId?: number | null;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export interface TrustedWalRow extends WalEvent {
  ingest_key: string;
  trust_provenance: 'host';
  trusted_source: TrustedWalSource;
  canonical_run_id: number | string;
  story_result_id: number | string | null;
  event_identity_hash: string;
  outbox_ready_at: string | null;
  outbox_relayed_at: string | null;
}

export interface TrustedWalReference {
  id: number;
  ingestKey: string;
  identityHash: string;
  eventType: string;
  workspaceId: string;
  runId: number;
  specId: string;
  storyId: string | null;
  source: TrustedWalSource;
  storyResultId: number | null;
  payload: Record<string, unknown>;
}

interface CanonicalRunBinding {
  id: number | string;
  workspace_id: string;
  spec_path: string;
  expected_story_ids: string[] | null;
}

function rows<T>(result: { rows: T[] }): T[] {
  return result.rows;
}

export function stableWalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableWalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableWalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parsePayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new ConflictError('Trusted WAL payload is not an object');
  }
  return parsed as Record<string, unknown>;
}

function canonicalIdentity(input: {
  eventType: string;
  workspaceId: string;
  runId: number;
  specId: string;
  storyId: string | null;
  source: TrustedWalSource;
  storyResultId: number | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    version: 1,
    eventType: input.eventType,
    workspaceId: input.workspaceId,
    runId: input.runId,
    specId: input.specId,
    storyId: input.storyId,
    source: input.source,
    storyResultId: input.storyResultId,
    payload: input.payload,
  };
}

export function trustedWalIdentityHash(input: Parameters<typeof canonicalIdentity>[0]): string {
  return createHash('sha256').update(stableWalJson(canonicalIdentity(input))).digest('hex');
}

function assertHostProcess(source: TrustedWalSource): void {
  if (process.env.NODE_ENV === 'test') return;
  const expectedRole = source === 'worker' ? 'worker' : 'engine';
  if (process.env.RORCA_PROCESS_ROLE !== expectedRole) {
    throw new Error(`Trusted WAL source ${source} requires host process role ${expectedRole}`);
  }
}

function assertSourceMayWrite(source: TrustedWalSource, eventType: string): void {
  if (source === 'story-result' && eventType !== 'story_passed') {
    throw new Error('The story-result outbox may persist only story_passed');
  }
  if (source === 'execution-engine' && ![
    'story_started', 'story_passed', 'story_failed', 'story_skipped',
  ].includes(eventType)) {
    throw new Error(`Execution engine may not author trusted ${eventType} events`);
  }
  if (source === 'worker' && ![
    'run_started', 'run_finished', 'story_failed', 'story_skipped',
  ].includes(eventType)) {
    throw new Error(`Worker may not author trusted ${eventType} events`);
  }
}

async function loadRunBinding(client: PoolClient, input: TrustedWalInput): Promise<CanonicalRunBinding> {
  const run = rows(await client.query<CanonicalRunBinding>(
    `SELECT id, workspace_id, spec_path, expected_story_ids
       FROM pipeline_runs
      WHERE id = $1
      FOR SHARE`,
    [input.runId],
  ))[0];
  if (!run) throw new NotFoundError('Pipeline run not found');
  if (run.workspace_id !== input.workspaceId) {
    throw new ConflictError('Trusted WAL workspace does not own the canonical run');
  }
  return run;
}

function exactRowIdentity(row: TrustedWalRow): Parameters<typeof canonicalIdentity>[0] {
  return {
    eventType: row.event_type,
    workspaceId: String(row.workspace_id),
    runId: Number(row.canonical_run_id),
    specId: String(row.spec_id),
    storyId: row.story_id,
    source: row.trusted_source,
    storyResultId: row.story_result_id == null ? null : Number(row.story_result_id),
    payload: parsePayload(row.payload),
  };
}

export function assertExactTrustedWalRow(row: TrustedWalRow, reference?: TrustedWalReference): void {
  const storyResultId = row.story_result_id == null ? null : Number(row.story_result_id);
  if (row.trust_provenance !== 'host'
    || !row.ingest_key
    || !Number.isSafeInteger(Number(row.canonical_run_id))
    || !row.workspace_id
    || !row.spec_id
    || (row.trusted_source === 'story-result'
      ? !Number.isSafeInteger(storyResultId) || storyResultId! <= 0
      : storyResultId !== null)) {
    throw new ConflictError('WAL row is not a complete host-owned event');
  }
  const payload = parsePayload(row.payload);
  if (row.trusted_source === 'story-result' && Number(payload.story_result_id) !== storyResultId) {
    throw new ConflictError('Trusted pass WAL does not match its canonical story result');
  }
  const identityHash = trustedWalIdentityHash(exactRowIdentity(row));
  if (identityHash !== row.event_identity_hash) {
    throw new ConflictError('Trusted WAL durable identity does not match its payload');
  }
  if (reference && (
    row.id !== reference.id
    || row.ingest_key !== reference.ingestKey
    || row.event_identity_hash !== reference.identityHash
    || row.event_type !== reference.eventType
    || row.workspace_id !== reference.workspaceId
    || Number(row.canonical_run_id) !== reference.runId
    || row.spec_id !== reference.specId
    || row.story_id !== reference.storyId
    || row.trusted_source !== reference.source
    || storyResultId !== reference.storyResultId
    || stableWalJson(payload) !== stableWalJson(reference.payload)
  )) {
    throw new ConflictError('Trusted WAL relay reference does not exactly match the durable event');
  }
}

export function trustedWalReference(row: TrustedWalRow): TrustedWalReference {
  assertExactTrustedWalRow(row);
  return {
    id: row.id,
    ingestKey: row.ingest_key,
    identityHash: row.event_identity_hash,
    eventType: row.event_type,
    workspaceId: String(row.workspace_id),
    runId: Number(row.canonical_run_id),
    specId: String(row.spec_id),
    storyId: row.story_id,
    source: row.trusted_source,
    storyResultId: row.story_result_id == null ? null : Number(row.story_result_id),
    payload: parsePayload(row.payload),
  };
}

/**
 * Insert one trusted event through an existing transaction. The event remains
 * unrelayed until the host crosses its local ordering boundary. Relay attempts
 * may repeat; no exactly-once or guaranteed provider side effect is claimed.
 */
export async function insertTrustedWalEvent(
  client: PoolClient,
  input: TrustedWalInput,
): Promise<{ row: TrustedWalRow; duplicate: boolean }> {
  assertHostProcess(input.source);
  assertSourceMayWrite(input.source, input.eventType);
  if (!GITHUB_GOVERNING_WAL_EVENTS.has(input.eventType)) {
    throw new Error(`Trusted WAL is not available for non-governing event ${input.eventType}`);
  }
  if (!Number.isSafeInteger(input.runId) || input.runId <= 0) {
    throw new TypeError('Trusted WAL runId must be a positive safe integer');
  }

  const run = await loadRunBinding(client, input);
  const specId = path.basename(run.spec_path, '.json');
  if (input.specId != null && input.specId !== specId) {
    throw new ConflictError('Trusted WAL spec does not match the canonical run');
  }
  const storyId = input.storyId ?? null;
  const storyResultId = input.storyResultId ?? null;
  if (input.source === 'story-result') {
    if (!Number.isSafeInteger(storyResultId) || storyResultId! <= 0 || !storyId) {
      throw new ConflictError('Trusted pass WAL requires one canonical story result');
    }
  } else if (storyResultId !== null) {
    throw new ConflictError('Only the story-result outbox may bind a story result');
  }
  if (input.payload.run_id !== undefined && Number(input.payload.run_id) !== input.runId) {
    throw new ConflictError('Trusted WAL payload run does not match the canonical run');
  }
  if (input.payload.story_id !== undefined && input.payload.story_id !== storyId) {
    throw new ConflictError('Trusted WAL payload story does not match the event story');
  }
  if (input.payload.story_result_id !== undefined
    && Number(input.payload.story_result_id) !== storyResultId) {
    throw new ConflictError('Trusted WAL payload result does not match the canonical result');
  }
  if (storyId && run.expected_story_ids && !run.expected_story_ids.includes(storyId)) {
    throw new ConflictError('Trusted WAL story is outside the frozen run scope');
  }

  if (input.eventType === 'story_failed') {
    const failure = rows(await client.query<{ id: number }>(`
      SELECT id FROM story_results
       WHERE run_id = $1 AND story_id = $2
         AND status IN ('fail', 'timeout')
         AND result_provenance = 'host' AND result_source = $3
       ORDER BY id DESC LIMIT 1
       FOR SHARE
    `, [input.runId, storyId, input.source]))[0];
    if (!failure) {
      throw new ConflictError('Trusted story failure requires a durable host result before event release');
    }
  }

  if (storyResultId !== null) {
    const commitSha = typeof input.payload.commit_sha === 'string'
      ? input.payload.commit_sha.toLowerCase()
      : '';
    const closeoutDecisionId = typeof input.payload.closeout_decision_id === 'string'
      ? input.payload.closeout_decision_id
      : '';
    const canonicalResult = rows(await client.query<{ id: number }>(`
      SELECT id FROM story_results
       WHERE id = $1 AND run_id = $2 AND story_id = $3 AND spec_id = $4
         AND status = 'pass' AND integrated = TRUE
         AND commit_sha = $5 AND closeout_decision_id = $6
       FOR SHARE
    `, [storyResultId, input.runId, storyId, specId, commitSha, closeoutDecisionId]))[0];
    if (!canonicalResult) {
      throw new ConflictError('Trusted pass WAL does not match the canonical integrated result');
    }
  }

  const payload = parsePayload(JSON.stringify({
    ...input.payload,
    run_id: input.runId,
    ...(storyId ? { story_id: storyId } : {}),
    ...(storyResultId !== null ? { story_result_id: storyResultId } : {}),
  }));
  const identityHash = trustedWalIdentityHash({
    eventType: input.eventType,
    workspaceId: input.workspaceId,
    runId: input.runId,
    specId,
    storyId,
    source: input.source,
    storyResultId,
    payload,
  });
  const ingestKey = `trusted-wal:v1:${identityHash}`;

  if (storyResultId !== null) {
    const existingForResult = rows(await client.query<TrustedWalRow>(`
      SELECT * FROM wal_events
       WHERE trust_provenance = 'host' AND trusted_source = 'story-result'
         AND story_result_id = $1
       FOR UPDATE
    `, [storyResultId]))[0];
    if (existingForResult) {
      assertExactTrustedWalRow(existingForResult, {
        id: existingForResult.id,
        ingestKey,
        identityHash,
        eventType: input.eventType,
        workspaceId: input.workspaceId,
        runId: input.runId,
        specId,
        storyId,
        source: input.source,
        storyResultId,
        payload,
      });
      return { row: existingForResult, duplicate: true };
    }
  }

  const inserted = rows(await client.query<TrustedWalRow>(`
    INSERT INTO wal_events (
      event_type, workspace_id, spec_id, story_id, actor, payload, ingest_key, ts,
      trust_provenance, trusted_source, canonical_run_id, story_result_id,
      event_identity_hash
    ) VALUES (
      $1,$2,$3,$4,'rorca-host',$5::jsonb,$6,COALESCE($7::timestamptz,NOW()),
      'host',$8,$9,$10,$11
    )
    ON CONFLICT (ingest_key) WHERE ingest_key IS NOT NULL DO NOTHING
    RETURNING *
  `, [
    input.eventType,
    input.workspaceId,
    specId,
    storyId,
    JSON.stringify(payload),
    ingestKey,
    input.occurredAt ?? null,
    input.source,
    input.runId,
    storyResultId,
    identityHash,
  ]))[0];

  if (inserted) {
    assertExactTrustedWalRow(inserted);
    return { row: inserted, duplicate: false };
  }
  const existing = rows(await client.query<TrustedWalRow>(
    'SELECT * FROM wal_events WHERE ingest_key = $1 FOR UPDATE',
    [ingestKey],
  ))[0];
  if (!existing) throw new ConflictError('Trusted WAL duplicate is not durably readable');
  const expected = {
    id: existing.id,
    ingestKey,
    identityHash,
    eventType: input.eventType,
    workspaceId: input.workspaceId,
    runId: input.runId,
    specId,
    storyId,
    source: input.source,
    storyResultId,
    payload,
  } satisfies TrustedWalReference;
  assertExactTrustedWalRow(existing, expected);
  return { row: existing, duplicate: true };
}

export async function persistTrustedWalEvent(
  input: TrustedWalInput,
): Promise<{ reference: TrustedWalReference; duplicate: boolean }> {
  return transaction(async (client) => {
    const outcome = await insertTrustedWalEvent(client, input);
    return { reference: trustedWalReference(outcome.row), duplicate: outcome.duplicate };
  });
}

async function loadRelayRow(reference: TrustedWalReference): Promise<TrustedWalRow> {
  const row = await queryOne<TrustedWalRow>(`
    SELECT w.*
      FROM wal_events w
      JOIN pipeline_runs pr
        ON pr.id = w.canonical_run_id AND pr.workspace_id = w.workspace_id
     WHERE w.id = $1 AND w.ingest_key = $2 AND w.event_identity_hash = $3
       AND w.workspace_id = $4 AND w.canonical_run_id = $5
       AND w.trust_provenance = 'host'
  `, [
    reference.id,
    reference.ingestKey,
    reference.identityHash,
    reference.workspaceId,
    reference.runId,
  ]);
  if (!row) throw new ConflictError('Trusted WAL relay event is missing or no longer owns its run');
  assertExactTrustedWalRow(row, reference);
  return row;
}

/**
 * Release and relay an exact pre-existing trusted row. Marking the row ready is
 * the host ordering boundary: integrated pass callers invoke this only after
 * the local spec projection is durable. A crash after readiness is recovered by
 * the startup scan; rows committed before local pass remain deliberately inert.
 */
export async function relayTrustedWalEvent(reference: TrustedWalReference): Promise<void> {
  await loadRelayRow(reference);
  const row = await queryOne<TrustedWalRow>(`
    UPDATE wal_events w
       SET outbox_ready_at = COALESCE(w.outbox_ready_at, NOW())
     WHERE w.id = $1 AND w.ingest_key = $2 AND w.event_identity_hash = $3
       AND w.workspace_id = $4 AND w.canonical_run_id = $5
       AND w.trust_provenance = 'host'
     RETURNING w.*
  `, [
    reference.id,
    reference.ingestKey,
    reference.identityHash,
    reference.workspaceId,
    reference.runId,
  ]);
  if (!row) throw new ConflictError('Trusted WAL row disappeared before relay readiness');
  assertExactTrustedWalRow(row, reference);

  // Relay only a durable row pointer. PostgreSQL NOTIFY payloads are bounded;
  // the server listener re-reads the exact row before SSE dispatch.
  const notified = await queryOne<{ notified: string }>(
    `SELECT pg_notify(
              'wal_events',
              json_build_object('trusted_wal_id', w.id)::text
            ) AS notified
       FROM wal_events w
      WHERE w.id = $1 AND w.ingest_key = $2 AND w.event_identity_hash = $3
        AND w.trust_provenance = 'host' AND w.outbox_ready_at IS NOT NULL`,
    [row.id, row.ingest_key, row.event_identity_hash],
  );
  if (!notified) throw new ConflictError('Trusted WAL row disappeared before relay');
}

/** Retry every released, unacknowledged trusted event for one worker-owned run. */
export async function relayUnacknowledgedTrustedRunEvents(
  workspaceId: string,
  runId: number,
): Promise<number> {
  const pending = await query<TrustedWalRow>(`
    SELECT w.*
      FROM wal_events w
      JOIN pipeline_runs pr
        ON pr.id = w.canonical_run_id AND pr.workspace_id = w.workspace_id
     WHERE w.workspace_id = $1 AND w.canonical_run_id = $2
       AND w.trust_provenance = 'host'
       AND w.outbox_ready_at IS NOT NULL
       AND w.outbox_relayed_at IS NULL
     ORDER BY w.id ASC
  `, [workspaceId, runId]);
  for (const row of pending) await relayTrustedWalEvent(trustedWalReference(row));
  return pending.length;
}

/** Startup recovery for released rows committed while LISTEN was unavailable. */
export async function relayReadyTrustedWalEvents(limit = 2_000): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new RangeError('Trusted WAL recovery limit must be between 1 and 10000');
  }
  const pending = await query<TrustedWalRow>(`
    SELECT * FROM wal_events
     WHERE trust_provenance = 'host'
       AND outbox_ready_at IS NOT NULL
       AND outbox_relayed_at IS NULL
     ORDER BY id ASC
     LIMIT $1
  `, [limit]);
  for (const row of pending) await relayTrustedWalEvent(trustedWalReference(row));
  return pending.length;
}

/** Called only by the server LISTEN consumer after dispatch into the SSE hub. */
export async function acknowledgeTrustedWalRelay(eventId: number): Promise<void> {
  await execute(
    `UPDATE wal_events
        SET outbox_relayed_at = COALESCE(outbox_relayed_at, NOW())
      WHERE id = $1 AND trust_provenance = 'host'
        AND outbox_ready_at IS NOT NULL`,
    [eventId],
  );
}

export function isTrustedGoverningWalEvent(event: WalEvent): event is TrustedWalRow {
  try {
    if (!GITHUB_GOVERNING_WAL_EVENTS.has(event.event_type)
      || !(event as TrustedWalRow).outbox_ready_at) return false;
    assertExactTrustedWalRow(event as TrustedWalRow);
    return true;
  } catch {
    return false;
  }
}
