/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { queryOne, transaction } from '../db/index';

export type DurableWaveIntegrationState =
  | 'prepared'
  | 'integrating'
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
    if (current.state === 'failed' || current.state === 'finalized') return current;
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
