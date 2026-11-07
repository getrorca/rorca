/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne, transaction } from './index';
import { ConflictError } from '../lib/errors';

export const EXECUTION_AUTHORITY_PROFILE_SCHEMA_VERSION = 'rorca.execution-authority-profile.v1' as const;
export const EXECUTION_AUTHORITY_ROLLOUT_EVIDENCE_SCHEMA_VERSION = 'rorca.execution-authority-rollout-evidence.v1' as const;

export const EXECUTION_AUTHORITY_EVIDENCE_KINDS = [
  'migration',
  'api',
  'ui',
  'crash_recovery',
  'redaction',
  'disposable_fixture_smoke',
] as const;

export type ExecutionAuthorityEvidenceKind = typeof EXECUTION_AUTHORITY_EVIDENCE_KINDS[number];
export type ExecutionAuthorityProfileState = 'disabled' | 'enabled';
export type ExecutionAuthorityEvidenceResult = 'passed' | 'failed';

export interface ExecutionAuthorityProfileRecord {
  schemaVersion: typeof EXECUTION_AUTHORITY_PROFILE_SCHEMA_VERSION;
  workspaceId: string;
  state: ExecutionAuthorityProfileState;
  generation: number;
  transitionPrincipal: string;
  createdAt: Date;
  updatedAt: Date;
  enabledAt: Date | null;
  disabledAt: Date | null;
}

export interface ExecutionAuthorityRolloutEvidenceRecord {
  id: string;
  schemaVersion: typeof EXECUTION_AUTHORITY_ROLLOUT_EVIDENCE_SCHEMA_VERSION;
  workspaceId: string;
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: ExecutionAuthorityEvidenceResult;
  artifactReference: string;
  evidenceDigest: string;
  observedAt: Date;
  operatorPrincipal: string;
  idempotencyKey: string;
  provenance: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export interface ExecutionAuthorityDisableResult {
  profile: ExecutionAuthorityProfileRecord;
  cancelledRequests: number;
  revokedGrants: number;
  revokedLeases: number;
}

interface ProfileRow {
  schema_version: typeof EXECUTION_AUTHORITY_PROFILE_SCHEMA_VERSION;
  workspace_id: string;
  state: ExecutionAuthorityProfileState;
  generation: number | string;
  transition_principal: string;
  created_at: Date;
  updated_at: Date;
  enabled_at: Date | null;
  disabled_at: Date | null;
}

interface EvidenceRow {
  id: string;
  schema_version: typeof EXECUTION_AUTHORITY_ROLLOUT_EVIDENCE_SCHEMA_VERSION;
  workspace_id: string;
  evidence_kind: ExecutionAuthorityEvidenceKind;
  result: ExecutionAuthorityEvidenceResult;
  artifact_reference: string;
  evidence_digest: string;
  observed_at: Date;
  operator_principal: string;
  idempotency_key: string;
  provenance_json: Readonly<Record<string, unknown>>;
  created_at: Date;
}

function mapProfile(row: ProfileRow): ExecutionAuthorityProfileRecord {
  return {
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
    state: row.state,
    generation: Number(row.generation),
    transitionPrincipal: row.transition_principal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enabledAt: row.enabled_at,
    disabledAt: row.disabled_at,
  };
}

function mapEvidence(row: EvidenceRow): ExecutionAuthorityRolloutEvidenceRecord {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    workspaceId: row.workspace_id,
    evidenceKind: row.evidence_kind,
    result: row.result,
    artifactReference: row.artifact_reference,
    evidenceDigest: row.evidence_digest,
    observedAt: row.observed_at,
    operatorPrincipal: row.operator_principal,
    idempotencyKey: row.idempotency_key,
    provenance: row.provenance_json,
    createdAt: row.created_at,
  };
}

const PROFILE_SELECT = `
  SELECT schema_version, workspace_id, state, generation, transition_principal,
         created_at, updated_at, enabled_at, disabled_at
    FROM rorca.execution_authority_profiles`;

const EVIDENCE_SELECT = `
  SELECT id::text, schema_version, workspace_id, evidence_kind, result,
         artifact_reference, evidence_digest, observed_at, operator_principal,
         idempotency_key, provenance_json, created_at
    FROM rorca.execution_authority_rollout_evidence`;

export async function getExecutionAuthorityProfile(
  workspaceId: string,
): Promise<ExecutionAuthorityProfileRecord | null> {
  const row = await queryOne<ProfileRow>(`${PROFILE_SELECT} WHERE workspace_id = $1`, [workspaceId]);
  return row ? mapProfile(row) : null;
}

export async function listExecutionAuthorityRolloutEvidence(
  workspaceId: string,
): Promise<ExecutionAuthorityRolloutEvidenceRecord[]> {
  const rows = await query<EvidenceRow>(
    `${EVIDENCE_SELECT}
      WHERE workspace_id = $1
      ORDER BY evidence_kind, observed_at DESC, created_at DESC, id DESC`,
    [workspaceId],
  );
  return rows.map(mapEvidence);
}

export async function getExecutionAuthorityEvidenceByIdempotencyKey(
  workspaceId: string,
  idempotencyKey: string,
): Promise<ExecutionAuthorityRolloutEvidenceRecord | null> {
  const row = await queryOne<EvidenceRow>(
    `${EVIDENCE_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  return row ? mapEvidence(row) : null;
}

export async function appendExecutionAuthorityRolloutEvidence(input: {
  workspaceId: string;
  evidenceKind: ExecutionAuthorityEvidenceKind;
  result: ExecutionAuthorityEvidenceResult;
  artifactReference: string;
  evidenceDigest: string;
  observedAt: Date;
  operatorPrincipal: string;
  idempotencyKey: string;
  provenance: Readonly<Record<string, unknown>>;
}): Promise<ExecutionAuthorityRolloutEvidenceRecord | null> {
  const row = await queryOne<EvidenceRow>(
    `INSERT INTO rorca.execution_authority_rollout_evidence
       (workspace_id, evidence_kind, result, artifact_reference, evidence_digest,
        observed_at, operator_principal, idempotency_key, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
     RETURNING id::text, schema_version, workspace_id, evidence_kind, result,
       artifact_reference, evidence_digest, observed_at, operator_principal,
       idempotency_key, provenance_json, created_at`,
    [
      input.workspaceId,
      input.evidenceKind,
      input.result,
      input.artifactReference,
      input.evidenceDigest,
      input.observedAt,
      input.operatorPrincipal,
      input.idempotencyKey,
      JSON.stringify(input.provenance),
    ],
  );
  return row ? mapEvidence(row) : null;
}

export async function enableExecutionAuthorityProfile(input: {
  workspaceId: string;
  expectedGeneration: number;
  operatorPrincipal: string;
}): Promise<ExecutionAuthorityProfileRecord | null> {
  const row = await queryOne<ProfileRow>(
    `UPDATE rorca.execution_authority_profiles
        SET state = 'enabled', generation = generation + 1, transition_principal = $1
      WHERE workspace_id = $2 AND generation = $3 AND state = 'disabled'
      RETURNING schema_version, workspace_id, state, generation, transition_principal,
        created_at, updated_at, enabled_at, disabled_at`,
    [input.operatorPrincipal, input.workspaceId, input.expectedGeneration],
  );
  return row ? mapProfile(row) : null;
}

export async function disableExecutionAuthorityProfile(input: {
  workspaceId: string;
  expectedGeneration: number;
  operatorPrincipal: string;
}): Promise<ExecutionAuthorityDisableResult | null> {
  return transaction(async () => {
    const locked = await queryOne<ProfileRow>(
      `${PROFILE_SELECT} WHERE workspace_id = $1 FOR UPDATE`,
      [input.workspaceId],
    );
    if (!locked || locked.state !== 'enabled' || Number(locked.generation) !== input.expectedGeneration) return null;

    const cancelledRequests = await execute(
      `UPDATE rorca.authority_requests
          SET status = 'cancelled', resolved_at = clock_timestamp()
        WHERE workspace_id = $1 AND status = 'pending'`,
      [input.workspaceId],
    );
    const revokedGrants = await execute(
      `UPDATE rorca.authority_grants
          SET status = 'revoked', revoked_at = clock_timestamp()
        WHERE workspace_id = $1 AND status = 'active'`,
      [input.workspaceId],
    );
    const revokedLeases = await execute(
      `UPDATE rorca.credential_leases
          SET status = 'revoked', revoked_at = clock_timestamp()
        WHERE workspace_id = $1
          AND status IN ('prepared', 'active', 'exhausted', 'expired', 'reconciliation_required')`,
      [input.workspaceId],
    );
    const row = await queryOne<ProfileRow>(
      `UPDATE rorca.execution_authority_profiles
          SET state = 'disabled', generation = generation + 1, transition_principal = $1
        WHERE workspace_id = $2 AND generation = $3 AND state = 'enabled'
        RETURNING schema_version, workspace_id, state, generation, transition_principal,
          created_at, updated_at, enabled_at, disabled_at`,
      [input.operatorPrincipal, input.workspaceId, input.expectedGeneration],
    );
    if (!row) throw new ConflictError('Execution Authority profile changed while disabling under lock');
    return {
      profile: mapProfile(row),
      cancelledRequests: cancelledRequests.rowCount,
      revokedGrants: revokedGrants.rowCount,
      revokedLeases: revokedLeases.rowCount,
    };
  });
}
