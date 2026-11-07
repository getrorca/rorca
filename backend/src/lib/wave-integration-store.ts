/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { queryOne, transaction } from '../db/index';
import { assertWaveConflictEvidence, type WaveConflictEvidence } from './wave-integration-protocol';

export type DurableWaveIntegrationState =
  | 'prepared'
  | 'integrating'
  | 'conflicted'
  | 'resolution_pending'
  | 'aborted'
  | 'integrated'
  | 'integrated_validated'
  | 'finalized'
  | 'failed';

export interface DurableWaveIntegrationIdentity {
  runId: number;
  storyId: string;
  attempt: number;
  waveIndex: number;
  integrationOrder: number;
  sourceCommit: string;
  sourceBaseCommit: string;
  expectedParentHead: string;
  frozenManifestHash: string;
}

export interface DurableWaveIntegrationRecord extends DurableWaveIntegrationIdentity {
  state: DurableWaveIntegrationState;
  resultingHead: string | null;
  validationIdentity: Record<string, unknown> | null;
  finalizationIdentity: Record<string, unknown> | null;
  conflictEvidence: WaveConflictEvidence | null;
  failureReason: string | null;
  stateVersion: number;
}

interface Row {
  run_id: string | number;
  story_id: string;
  attempt: number;
  wave_index: number;
  integration_order: number;
  state: DurableWaveIntegrationState;
  source_commit: string;
  source_base_commit: string;
  expected_parent_head: string;
  resulting_head: string | null;
  frozen_manifest_hash: string;
  validation_identity: Record<string, unknown> | null;
  finalization_identity: Record<string, unknown> | null;
  conflict_evidence: WaveConflictEvidence | null;
  failure_reason: string | null;
  state_version: number | string;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function record(row: Row): DurableWaveIntegrationRecord {
  return {
    runId: Number(row.run_id),
    storyId: row.story_id,
    attempt: row.attempt,
    waveIndex: row.wave_index,
    integrationOrder: row.integration_order,
    state: row.state,
    sourceCommit: row.source_commit.trim(),
    sourceBaseCommit: row.source_base_commit.trim(),
    expectedParentHead: row.expected_parent_head.trim(),
    resultingHead: row.resulting_head?.trim() ?? null,
    frozenManifestHash: row.frozen_manifest_hash.trim(),
    validationIdentity: row.validation_identity,
    finalizationIdentity: row.finalization_identity,
    conflictEvidence: row.conflict_evidence,
    failureReason: row.failure_reason,
    stateVersion: Number(row.state_version),
  };
}

function sameIdentity(left: DurableWaveIntegrationRecord, right: DurableWaveIntegrationIdentity): boolean {
  return left.runId === right.runId
    && left.storyId === right.storyId
    && left.attempt === right.attempt
    && left.waveIndex === right.waveIndex
    && left.integrationOrder === right.integrationOrder
    && left.sourceCommit === right.sourceCommit
    && left.sourceBaseCommit === right.sourceBaseCommit
    && left.expectedParentHead === right.expectedParentHead
    && left.frozenManifestHash === right.frozenManifestHash;
}

export async function readDurableWaveIntegration(input: {
  runId: number;
  storyId: string;
  attempt: number;
}): Promise<DurableWaveIntegrationRecord | undefined> {
  const row = await queryOne<Row>(
    `SELECT * FROM story_integration_ledger
      WHERE run_id = $1 AND story_id = $2 AND attempt = $3`,
    [input.runId, input.storyId, input.attempt],
  );
  return row ? record(row) : undefined;
}

export async function prepareDurableWaveIntegration(
  identity: DurableWaveIntegrationIdentity,
): Promise<DurableWaveIntegrationRecord> {
  return transaction(async client => {
    await client.query(
      `INSERT INTO story_integration_ledger (
         run_id, story_id, attempt, wave_index, integration_order, state,
         source_commit, source_base_commit, expected_parent_head, frozen_manifest_hash
       ) VALUES ($1,$2,$3,$4,$5,'prepared',$6,$7,$8,$9)
       ON CONFLICT (run_id, story_id, attempt) DO NOTHING`,
      [
        identity.runId, identity.storyId, identity.attempt, identity.waveIndex,
        identity.integrationOrder, identity.sourceCommit, identity.sourceBaseCommit,
        identity.expectedParentHead, identity.frozenManifestHash,
      ],
    );
    const result = await client.query<Row>(
      `SELECT * FROM story_integration_ledger
        WHERE run_id = $1 AND story_id = $2 AND attempt = $3 FOR UPDATE`,
      [identity.runId, identity.storyId, identity.attempt],
    );
    const persisted = result.rows[0] ? record(result.rows[0]) : undefined;
    if (!persisted || !sameIdentity(persisted, identity)) {
      throw new Error('[wave-integration-store] durable integration identity conflict');
    }
    return persisted;
  });
}

export async function failDurableWaveIntegration(input: {
  identity: DurableWaveIntegrationIdentity;
  reason: string;
}): Promise<DurableWaveIntegrationRecord> {
  if (!input.reason || input.reason.length > 512) {
    throw new Error('[wave-integration-store] failure reason must be present and bounded');
  }
  return transaction(async client => {
    const locked = await client.query<Row>(
      `SELECT * FROM story_integration_ledger
        WHERE run_id = $1 AND story_id = $2 AND attempt = $3 FOR UPDATE`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt],
    );
    const current = locked.rows[0] ? record(locked.rows[0]) : undefined;
    if (!current || !sameIdentity(current, input.identity)) {
      throw new Error('[wave-integration-store] durable integration identity is missing or stale');
    }
    if (current.state === 'failed' || current.state === 'finalized' || current.state === 'aborted') return current;
    const updated = await client.query<Row>(
      `UPDATE story_integration_ledger
          SET state = 'failed', failure_reason = $4
        WHERE run_id = $1 AND story_id = $2 AND attempt = $3
          AND state IN ('prepared', 'integrating', 'integrated', 'integrated_validated')
        RETURNING *`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt, input.reason],
    );
    if (!updated.rows[0]) throw new Error('[wave-integration-store] failure transition lost its row fence');
    return record(updated.rows[0]);
  });
}

export async function markDurableWaveConflicted(input: {
  identity: DurableWaveIntegrationIdentity;
  evidence: WaveConflictEvidence;
  reason: string;
}): Promise<DurableWaveIntegrationRecord> {
  if (!input.reason || input.reason.length > 512 || input.evidence.postAbortHead !== null) {
    throw new Error('[wave-integration-store] conflicted evidence/reason is invalid');
  }
  assertWaveConflictEvidence({ state: 'conflicted', identity: input.identity, evidence: input.evidence });
  return transaction(async (client) => {
    const locked = await client.query<Row>(
      `SELECT * FROM story_integration_ledger
       WHERE run_id = $1 AND story_id = $2 AND attempt = $3 FOR UPDATE`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt],
    );
    const current = locked.rows[0] ? record(locked.rows[0]) : undefined;
    if (!current || !sameIdentity(current, input.identity)) throw new Error('[wave-integration-store] durable integration identity is missing or stale');
    if (current.state === 'conflicted') {
      if (stableJson(current.conflictEvidence) !== stableJson(input.evidence) || current.failureReason !== input.reason) {
        throw new Error('[wave-integration-store] conflict evidence changed during replay');
      }
      return current;
    }
    if (current.state !== 'integrating') throw new Error(`[wave-integration-store] cannot record conflict from ${current.state}`);
    const updated = await client.query<Row>(
      `UPDATE story_integration_ledger
       SET state = 'conflicted', conflict_evidence = $4::jsonb, failure_reason = $5
       WHERE run_id = $1 AND story_id = $2 AND attempt = $3 AND state = 'integrating'
       RETURNING *`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt,
        JSON.stringify(input.evidence), input.reason],
    );
    if (!updated.rows[0]) throw new Error('[wave-integration-store] conflict transition lost its row fence');
    return record(updated.rows[0]);
  });
}

export async function markDurableWaveConflictAborted(input: {
  identity: DurableWaveIntegrationIdentity;
  priorEvidence: WaveConflictEvidence;
  evidence: WaveConflictEvidence;
  reason: string;
}): Promise<DurableWaveIntegrationRecord> {
  assertWaveConflictEvidence({ state: 'aborted', identity: input.identity, evidence: input.evidence });
  if (input.priorEvidence.postAbortHead !== null
    || stableJson({ ...input.evidence, postAbortHead: null }) !== stableJson(input.priorEvidence)) {
    throw new Error('[wave-integration-store] aborted evidence does not extend exact conflicted evidence');
  }
  return transaction(async (client) => {
    const locked = await client.query<Row>(
      `SELECT * FROM story_integration_ledger
       WHERE run_id = $1 AND story_id = $2 AND attempt = $3 FOR UPDATE`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt],
    );
    const current = locked.rows[0] ? record(locked.rows[0]) : undefined;
    if (!current || !sameIdentity(current, input.identity)) throw new Error('[wave-integration-store] durable integration identity is missing or stale');
    if (current.state === 'aborted') {
      if (stableJson(current.conflictEvidence) !== stableJson(input.evidence)) {
        throw new Error('[wave-integration-store] aborted conflict evidence changed during replay');
      }
      return current;
    }
    if (!['conflicted', 'resolution_pending'].includes(current.state)
      || stableJson(current.conflictEvidence) !== stableJson(input.priorEvidence)) {
      throw new Error('[wave-integration-store] conflict abort lacks exact prior evidence');
    }
    const updated = await client.query<Row>(
      `UPDATE story_integration_ledger
       SET state = 'aborted', conflict_evidence = $4::jsonb, failure_reason = $5
       WHERE run_id = $1 AND story_id = $2 AND attempt = $3
         AND state IN ('conflicted', 'resolution_pending')
       RETURNING *`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt,
        JSON.stringify(input.evidence), input.reason.slice(0, 512)],
    );
    if (!updated.rows[0]) throw new Error('[wave-integration-store] conflict abort transition lost its row fence');
    return record(updated.rows[0]);
  });
}

const STATE_ORDER: DurableWaveIntegrationState[] = [
  'prepared', 'integrating', 'integrated', 'integrated_validated', 'finalized',
];

export async function advanceDurableWaveIntegration(input: {
  identity: DurableWaveIntegrationIdentity;
  from: Exclude<DurableWaveIntegrationState, 'finalized' | 'failed'>;
  to: Exclude<DurableWaveIntegrationState, 'prepared' | 'failed'>;
  resultingHead?: string;
  validationIdentity?: Record<string, unknown>;
}): Promise<DurableWaveIntegrationRecord> {
  return transaction(async client => {
    const locked = await client.query<Row>(
      `SELECT * FROM story_integration_ledger
        WHERE run_id = $1 AND story_id = $2 AND attempt = $3 FOR UPDATE`,
      [input.identity.runId, input.identity.storyId, input.identity.attempt],
    );
    const current = locked.rows[0] ? record(locked.rows[0]) : undefined;
    if (!current || !sameIdentity(current, input.identity)) {
      throw new Error('[wave-integration-store] durable integration identity is missing or stale');
    }
    if (current.state === 'failed') throw new Error('[wave-integration-store] integration is already failed');
    const currentIndex = STATE_ORDER.indexOf(current.state);
    const targetIndex = STATE_ORDER.indexOf(input.to);
    if (currentIndex >= targetIndex) {
      if (input.resultingHead && current.resultingHead !== input.resultingHead) {
        throw new Error('[wave-integration-store] resulting revision changed during replay');
      }
      return current;
    }
    if (current.state !== input.from || targetIndex !== currentIndex + 1) {
      throw new Error(`[wave-integration-store] cannot advance ${current.state} through ${input.from} -> ${input.to}`);
    }
    const updated = await client.query<Row>(
      `UPDATE story_integration_ledger
          SET state = $4,
              resulting_head = COALESCE($5, resulting_head),
              validation_identity = COALESCE($6::jsonb, validation_identity)
        WHERE run_id = $1 AND story_id = $2 AND attempt = $3 AND state = $7
        RETURNING *`,
      [
        input.identity.runId, input.identity.storyId, input.identity.attempt, input.to,
        input.resultingHead ?? null,
        input.validationIdentity ? JSON.stringify(input.validationIdentity) : null,
        input.from,
      ],
    );
    if (!updated.rows[0]) throw new Error('[wave-integration-store] transition lost its row fence');
    return record(updated.rows[0]);
  });
}


export const SEQUENTIAL_INTEGRATION_RECONCILIATION_VERSION =
  'rorca.sequential-integration-reconciliation.v1' as const;

interface SequentialIntegrationAuthorityRow {
  result_id: number | string;
  story_id: string;
  commit_sha: string;
  manifest_hash: string;
  attempt: number;
  decision_id: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

export interface FinalizedStoryIntegrationAuthority {
  attempt: number;
  sourceCommit: string;
  resultingHead: string;
  finalizationIdentity: Record<string, unknown>;
}

/**
 * Resolve the exact finalized integration for an authoritative passing result.
 *
 * A governed retry attempt is a lineage-level attempt. The execution engine may
 * consume additional story-local attempts before it passes, so the durable
 * integration attempt is not required to equal the governed attempt. Reconciled
 * sequential integrations bind the exact result through validation_identity;
 * older integrations fall back to the governed attempt only when that binding
 * is absent.
 */
export async function readExactFinalizedStoryIntegration(
  client: Pick<PoolClient, 'query'>,
  input: {
    runId: number;
    storyId: string;
    governedAttempt: number;
    storyResultId: number;
    resultingHead: string;
  },
): Promise<FinalizedStoryIntegrationAuthority | undefined> {
  const matched = await client.query<{
    attempt: number;
    source_commit: string;
    resulting_head: string;
    finalization_identity: Record<string, unknown>;
  }>(
    `SELECT attempt, source_commit, resulting_head, finalization_identity
       FROM story_integration_ledger
      WHERE run_id = $1 AND story_id = $2 AND state = 'finalized'
        AND resulting_head = $3
        AND (
          validation_identity->>'storyResultId' = $4
          OR (NOT (validation_identity ? 'storyResultId') AND attempt = $5)
        )
      ORDER BY attempt
      LIMIT 2
      FOR SHARE`,
    [
      input.runId,
      input.storyId,
      input.resultingHead,
      String(input.storyResultId),
      input.governedAttempt,
    ],
  );
  if (matched.rows.length > 1) {
    throw new Error('[wave-integration-store] finalized story integration authority is ambiguous');
  }
  const row = matched.rows[0];
  if (!row) return undefined;
  return {
    attempt: row.attempt,
    sourceCommit: row.source_commit,
    resultingHead: row.resulting_head,
    finalizationIdentity: row.finalization_identity,
  };
}

/**
 * Materialize the integration ledger omitted by the sequential executor.
 *
 * This is not a compatibility guess: the caller supplies already-validated
 * host result authority, and this transaction rebinds every pass to its exact
 * result, accepted closeout decision, manifest, commit, and linear run head.
 */
export async function reconcileFinalizedSequentialIntegrations(input: {
  runId: number;
  baseRevision: string;
  terminalRevision: string;
  integrationAncestry: string[];
  stories: Array<{ storyId: string; resultId: number; commitSha: string }>;
}): Promise<{ inserted: number; finalized: number }> {
  if (!Number.isSafeInteger(input.runId) || input.runId < 1
    || !/^[0-9a-f]{40}$/.test(input.baseRevision)
    || !/^[0-9a-f]{40}$/.test(input.terminalRevision)
    || input.stories.length === 0) {
    throw new Error('[wave-integration-store] sequential reconciliation authority is incomplete');
  }
  const stories = [...input.stories].sort((left, right) => left.resultId - right.resultId);
  const storyIds = new Set(stories.map((story) => story.storyId));
  const resultIds = new Set(stories.map((story) => story.resultId));
  if (storyIds.size !== stories.length || resultIds.size !== stories.length
    || stories.some((story) => !story.storyId || !Number.isSafeInteger(story.resultId)
      || story.resultId < 1 || !/^[0-9a-f]{40}$/.test(story.commitSha))) {
    throw new Error('[wave-integration-store] sequential reconciliation story identity is invalid');
  }
  let ancestryOffset = -1;
  for (const story of stories) {
    ancestryOffset = input.integrationAncestry.indexOf(story.commitSha, ancestryOffset + 1);
    if (ancestryOffset < 0) {
      throw new Error('[wave-integration-store] sequential pass is outside ordered host ancestry');
    }
  }
  if (stories.at(-1)?.commitSha !== input.terminalRevision) {
    throw new Error('[wave-integration-store] sequential terminal revision is not the final pass commit');
  }

  return transaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`sequential-integration-reconciliation:${input.runId}`],
    );
    const authority = await client.query<SequentialIntegrationAuthorityRow>(`
      SELECT result.id AS result_id, result.story_id, lower(result.commit_sha) AS commit_sha,
             result.manifest_hash, decision.attempt, decision.decision_id
        FROM story_results result
        JOIN story_closeout_decisions decision
          ON decision.decision_id = result.closeout_decision_id
         AND decision.run_id = result.run_id
         AND decision.story_id = result.story_id
         AND decision.manifest_hash = result.manifest_hash
       WHERE result.run_id = $1
         AND result.id = ANY($2::bigint[])
         AND result.status = 'pass'
         AND result.result_provenance = 'host'
         AND result.result_source = 'execution-engine'
         AND result.integrated = TRUE
         AND decision.status = 'accepted'
       ORDER BY result.id
       FOR SHARE OF result, decision
    `, [input.runId, stories.map((story) => story.resultId)]);
    if (authority.rows.length !== stories.length) {
      throw new Error('[wave-integration-store] exact sequential pass authority is unavailable');
    }

    let inserted = 0;
    for (let index = 0; index < stories.length; index += 1) {
      const story = stories[index];
      const row = authority.rows[index];
      const manifestHash = row.manifest_hash.replace(/^sha256:/, '');
      if (row.story_id !== story.storyId || Number(row.result_id) !== story.resultId
        || row.commit_sha !== story.commitSha || !Number.isSafeInteger(row.attempt)
        || row.attempt < 1 || !/^[0-9a-f]{64}$/.test(manifestHash)) {
        throw new Error('[wave-integration-store] sequential pass authority changed during reconciliation');
      }
      const parentHead = index === 0 ? input.baseRevision : stories[index - 1].commitSha;
      const validationIdentity = {
        schemaVersion: SEQUENTIAL_INTEGRATION_RECONCILIATION_VERSION,
        runId: input.runId,
        storyId: story.storyId,
        storyResultId: story.resultId,
        closeoutDecisionId: row.decision_id,
        terminalRevision: input.terminalRevision,
      };
      const finalizationIdentity = {
        schemaVersion: SEQUENTIAL_INTEGRATION_RECONCILIATION_VERSION,
        idempotencyKey: `sequential-integration:${input.runId}:${story.storyId}:${row.attempt}`,
        runId: input.runId,
        storyId: story.storyId,
        attempt: row.attempt,
        revision: story.commitSha,
        receiptHash: sha256(validationIdentity),
      };
      const created = await client.query(`
        INSERT INTO story_integration_ledger (
          run_id, story_id, attempt, wave_index, integration_order, state,
          source_commit, source_base_commit, expected_parent_head, resulting_head,
          frozen_manifest_hash, validation_identity, finalization_identity, finalized_at
        ) VALUES ($1,$2,$3,0,$4,'finalized',$5,$6,$6,$5,$7,$8::jsonb,$9::jsonb,NOW())
        ON CONFLICT (run_id, story_id, attempt) DO NOTHING
      `, [
        input.runId,
        story.storyId,
        row.attempt,
        index,
        story.commitSha,
        parentHead,
        manifestHash,
        JSON.stringify(validationIdentity),
        JSON.stringify(finalizationIdentity),
      ]);
      inserted += created.rowCount ?? 0;
    }

    const persisted = await client.query<Row>(`
      SELECT * FROM story_integration_ledger
       WHERE run_id = $1 AND story_id = ANY($2::text[])
       ORDER BY integration_order
       FOR SHARE
    `, [input.runId, stories.map((story) => story.storyId)]);
    if (persisted.rows.length !== stories.length) {
      throw new Error('[wave-integration-store] sequential integration ledger reconciliation is incomplete');
    }
    for (let index = 0; index < stories.length; index += 1) {
      const row = record(persisted.rows[index]);
      const story = stories[index];
      const parentHead = index === 0 ? input.baseRevision : stories[index - 1].commitSha;
      if (row.storyId !== story.storyId || row.state !== 'finalized'
        || row.integrationOrder !== index || row.sourceCommit !== story.commitSha
        || row.sourceBaseCommit !== parentHead || row.expectedParentHead !== parentHead
        || row.resultingHead !== story.commitSha) {
        throw new Error('[wave-integration-store] sequential integration ledger identity conflict');
      }
    }
    return { inserted, finalized: persisted.rows.length };
  });
}