/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne } from './index';
import type { AuthorityJson, AuthorityGrantRecord, AuthorityRequestRecord, ProviderBindingRecord } from './execution-authority';
import {
  getAuthorityGrantForRequest,
  getAuthorityRequest,
} from './execution-authority';

export const EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION = 'rorca.execution-authority-preflight.v1' as const;

export const AUTHORITY_RUN_WAIT_STATES = [
  'WAITING_FOR_AUTHORIZATION',
  'WAITING_FOR_AUTHENTICATION',
  'WAITING_FOR_CHANGE_WINDOW',
] as const;
export type AuthorityRunWaitState = typeof AUTHORITY_RUN_WAIT_STATES[number];
export type AuthorityRunPreflightStatus = 'AUTHORIZED' | AuthorityRunWaitState | 'INVALIDATED';
export type AuthorityBindingHealth = 'healthy' | 'unhealthy';
export type AuthorityCredentialMintability = 'mintable' | 'authentication_required' | 'unavailable';
export type AuthorityChangeWindow = 'open' | 'closed';
export type AuthorityRequirementOutcome = 'AUTHORIZED' | AuthorityRunWaitState;

export interface AuthorityRunPreflightRecord {
  id: string;
  schemaVersion: typeof EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION;
  workspaceId: string;
  runId: number;
  specRevision: string;
  environment: string;
  policyRevision: string;
  preflightDigest: string;
  status: AuthorityRunPreflightStatus;
  waitExpiresAt: Date | null;
  pendingStoryPosition: number;
  invalidationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  invalidatedAt: Date | null;
}

export interface AuthorityPreflightRequirementRecord {
  id: string;
  schemaVersion: typeof EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION;
  workspaceId: string;
  runId: number;
  preflightId: string;
  ordinal: number;
  storyId: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  environment: string;
  providerResourceId: string;
  requestedMode: string;
  constraints: AuthorityJson;
  evidenceDigest: string;
  requirementDigest: string;
  adapterId: string;
  adapterPolicyRevision: string;
  bindingHealth: AuthorityBindingHealth;
  credentialMintability: AuthorityCredentialMintability;
  changeWindow: AuthorityChangeWindow;
  outcome: AuthorityRequirementOutcome;
  operationIntentId: string | null;
  authorityRequestId: string | null;
  authorityGrantId: string | null;
  waitExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface PreflightRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION;
  workspace_id: string; run_id: number | string; spec_revision: string; environment: string;
  policy_revision: string; preflight_digest: string; status: AuthorityRunPreflightStatus;
  wait_expires_at: Date | null; pending_story_position: number; invalidation_reason: string | null;
  created_at: Date; updated_at: Date; invalidated_at: Date | null;
}

interface RequirementRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_PREFLIGHT_SCHEMA_VERSION;
  workspace_id: string; run_id: number | string; preflight_id: string; ordinal: number; story_id: string;
  capability_id: string; binding_reference: string; binding_generation: number | string; environment: string;
  provider_resource_id: string; requested_mode: string; constraints_json: AuthorityJson; evidence_digest: string;
  requirement_digest: string; adapter_id: string; adapter_policy_revision: string;
  binding_health: AuthorityBindingHealth; credential_mintability: AuthorityCredentialMintability;
  change_window: AuthorityChangeWindow; outcome: AuthorityRequirementOutcome; operation_intent_id: string | null;
  authority_request_id: string | null; authority_grant_id: string | null; wait_expires_at: Date | null;
  created_at: Date; updated_at: Date;
}

interface BindingRow {
  id: string; schema_version: ProviderBindingRecord['schemaVersion']; workspace_id: string;
  binding_reference: string; generation: number | string; capability_id: string; provider: string;
  environment: string; provider_resource_id: string; secret_reference: string; secret_fingerprint: string;
  status: ProviderBindingRecord['status']; configuration_json: AuthorityJson; provenance_json: AuthorityJson;
  created_at: Date; updated_at: Date; revoked_at: Date | null;
}

function mapPreflight(row: PreflightRow): AuthorityRunPreflightRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, runId: Number(row.run_id),
    specRevision: row.spec_revision, environment: row.environment, policyRevision: row.policy_revision,
    preflightDigest: row.preflight_digest, status: row.status, waitExpiresAt: row.wait_expires_at,
    pendingStoryPosition: row.pending_story_position, invalidationReason: row.invalidation_reason,
    createdAt: row.created_at, updatedAt: row.updated_at, invalidatedAt: row.invalidated_at,
  };
}

function mapRequirement(row: RequirementRow): AuthorityPreflightRequirementRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, runId: Number(row.run_id),
    preflightId: row.preflight_id, ordinal: row.ordinal, storyId: row.story_id, capabilityId: row.capability_id,
    bindingReference: row.binding_reference, bindingGeneration: Number(row.binding_generation), environment: row.environment,
    providerResourceId: row.provider_resource_id, requestedMode: row.requested_mode, constraints: row.constraints_json,
    evidenceDigest: row.evidence_digest, requirementDigest: row.requirement_digest, adapterId: row.adapter_id,
    adapterPolicyRevision: row.adapter_policy_revision, bindingHealth: row.binding_health,
    credentialMintability: row.credential_mintability, changeWindow: row.change_window, outcome: row.outcome,
    operationIntentId: row.operation_intent_id, authorityRequestId: row.authority_request_id,
    authorityGrantId: row.authority_grant_id, waitExpiresAt: row.wait_expires_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapBinding(row: BindingRow): ProviderBindingRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id,
    bindingReference: row.binding_reference, generation: Number(row.generation), capabilityId: row.capability_id,
    provider: row.provider, environment: row.environment, providerResourceId: row.provider_resource_id,
    secretReference: row.secret_reference, secretFingerprint: row.secret_fingerprint, status: row.status,
    configuration: row.configuration_json, provenance: row.provenance_json, createdAt: row.created_at,
    updatedAt: row.updated_at, revokedAt: row.revoked_at,
  };
}

/** Latest adapter-owned health assessment for one exact authority request. */
export async function getAuthorityRequestBindingHealth(
  workspaceId: string,
  requestId: string,
): Promise<AuthorityBindingHealth | null> {
  const row = await queryOne<{ binding_health: AuthorityBindingHealth }>(
    `SELECT binding_health
       FROM authority_preflight_requirements
      WHERE workspace_id = $1 AND authority_request_id = $2
      ORDER BY updated_at DESC, id DESC
      LIMIT 1`,
    [workspaceId, requestId],
  );
  return row?.binding_health ?? null;
}

export async function getLatestAuthorityProviderBinding(
  workspaceId: string,
  bindingReference: string,
): Promise<ProviderBindingRecord | null> {
  const row = await queryOne<BindingRow>(
    `SELECT * FROM execution_authority_bindings
      WHERE workspace_id = $1 AND binding_reference = $2
      ORDER BY generation DESC LIMIT 1`,
    [workspaceId, bindingReference],
  );
  return row ? mapBinding(row) : null;
}

export async function getActiveAuthorityRunPreflight(
  workspaceId: string,
  runId: number,
): Promise<AuthorityRunPreflightRecord | null> {
  const row = await queryOne<PreflightRow>(
    `SELECT * FROM authority_run_preflights
      WHERE workspace_id = $1 AND run_id = $2 AND invalidated_at IS NULL`,
    [workspaceId, runId],
  );
  return row ? mapPreflight(row) : null;
}

export async function createAuthorityRunPreflight(input: {
  workspaceId: string; runId: number; specRevision: string; environment: string; policyRevision: string;
  preflightDigest: string; status: Exclude<AuthorityRunPreflightStatus, 'INVALIDATED'>;
  waitExpiresAt: Date | null; pendingStoryPosition: number;
}): Promise<AuthorityRunPreflightRecord> {
  const row = await queryOne<PreflightRow>(
    `INSERT INTO authority_run_preflights
      (workspace_id, run_id, spec_revision, environment, policy_revision, preflight_digest,
       status, wait_expires_at, pending_story_position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [input.workspaceId, input.runId, input.specRevision, input.environment, input.policyRevision,
      input.preflightDigest, input.status, input.waitExpiresAt, input.pendingStoryPosition],
  );
  if (!row) throw new Error('Authority run preflight insert returned no row');
  return mapPreflight(row);
}

export async function listAuthorityPreflightRequirements(
  workspaceId: string,
  preflightId: string,
): Promise<AuthorityPreflightRequirementRecord[]> {
  return (await query<RequirementRow>(
    `SELECT * FROM authority_preflight_requirements
      WHERE workspace_id = $1 AND preflight_id = $2 ORDER BY ordinal`,
    [workspaceId, preflightId],
  )).map(mapRequirement);
}

export async function createAuthorityPreflightRequirement(input: {
  workspaceId: string; runId: number; preflightId: string; ordinal: number; storyId: string;
  capabilityId: string; bindingReference: string; bindingGeneration: number; environment: string;
  providerResourceId: string; requestedMode: string; constraints: AuthorityJson; evidenceDigest: string;
  requirementDigest: string; adapterId: string; adapterPolicyRevision: string;
  bindingHealth: AuthorityBindingHealth; credentialMintability: AuthorityCredentialMintability;
  changeWindow: AuthorityChangeWindow; outcome: AuthorityRequirementOutcome;
  operationIntentId: string | null; authorityRequestId: string | null; authorityGrantId: string | null;
  waitExpiresAt: Date | null;
}): Promise<AuthorityPreflightRequirementRecord> {
  const row = await queryOne<RequirementRow>(
    `INSERT INTO authority_preflight_requirements
      (workspace_id, run_id, preflight_id, ordinal, story_id, capability_id, binding_reference,
       binding_generation, environment, provider_resource_id, requested_mode, constraints_json,
       evidence_digest, requirement_digest, adapter_id, adapter_policy_revision, binding_health,
       credential_mintability, change_window, outcome, operation_intent_id, authority_request_id,
       authority_grant_id, wait_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14,
             $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     RETURNING *`,
    [input.workspaceId, input.runId, input.preflightId, input.ordinal, input.storyId, input.capabilityId,
      input.bindingReference, input.bindingGeneration, input.environment, input.providerResourceId,
      input.requestedMode, input.constraints, input.evidenceDigest, input.requirementDigest, input.adapterId,
      input.adapterPolicyRevision, input.bindingHealth, input.credentialMintability, input.changeWindow,
      input.outcome, input.operationIntentId, input.authorityRequestId, input.authorityGrantId,
      input.waitExpiresAt],
  );
  if (!row) throw new Error('Authority preflight requirement insert returned no row');
  return mapRequirement(row);
}

export async function updateAuthorityPreflightRequirement(input: {
  workspaceId: string; requirementId: string; bindingHealth: AuthorityBindingHealth;
  credentialMintability: AuthorityCredentialMintability; changeWindow: AuthorityChangeWindow;
  outcome: AuthorityRequirementOutcome; operationIntentId?: string | null; authorityRequestId?: string | null;
  authorityGrantId?: string | null; waitExpiresAt: Date | null;
}): Promise<AuthorityPreflightRequirementRecord | null> {
  const row = await queryOne<RequirementRow>(
    `UPDATE authority_preflight_requirements
        SET binding_health = $3, credential_mintability = $4, change_window = $5, outcome = $6,
            operation_intent_id = COALESCE(operation_intent_id, $7),
            authority_request_id = COALESCE(authority_request_id, $8),
            authority_grant_id = COALESCE(authority_grant_id, $9), wait_expires_at = $10
      WHERE workspace_id = $1 AND id = $2
      RETURNING *`,
    [input.workspaceId, input.requirementId, input.bindingHealth, input.credentialMintability,
      input.changeWindow, input.outcome, input.operationIntentId ?? null, input.authorityRequestId ?? null,
      input.authorityGrantId ?? null, input.waitExpiresAt],
  );
  return row ? mapRequirement(row) : null;
}

export async function updateAuthorityRunPreflight(input: {
  workspaceId: string; preflightId: string; status: Exclude<AuthorityRunPreflightStatus, 'INVALIDATED'>;
  waitExpiresAt: Date | null; pendingStoryPosition: number;
}): Promise<AuthorityRunPreflightRecord | null> {
  const row = await queryOne<PreflightRow>(
    `UPDATE authority_run_preflights
        SET status = $3, wait_expires_at = $4,
            pending_story_position = GREATEST(pending_story_position, $5)
      WHERE workspace_id = $1 AND id = $2 AND invalidated_at IS NULL
      RETURNING *`,
    [input.workspaceId, input.preflightId, input.status, input.waitExpiresAt, input.pendingStoryPosition],
  );
  return row ? mapPreflight(row) : null;
}

export async function invalidateAuthorityRunPreflight(preflightId: string, reason: string): Promise<boolean> {
  const row = await queryOne<{ invalidated: boolean }>(
    'SELECT invalidate_authority_run_preflight_v1($1, $2) AS invalidated',
    [preflightId, reason],
  );
  return row?.invalidated === true;
}

export async function getPreflightAuthorityRequest(
  workspaceId: string,
  requestId: string,
): Promise<AuthorityRequestRecord | null> {
  return getAuthorityRequest(workspaceId, requestId);
}

export async function getPreflightAuthorityGrant(
  workspaceId: string,
  requestId: string,
): Promise<AuthorityGrantRecord | null> {
  return getAuthorityGrantForRequest(workspaceId, requestId);
}

export async function getCompletedRunStoryIds(runId: number): Promise<Set<string>> {
  const rows = await query<{ story_id: string; status: string }>(
    `SELECT DISTINCT ON (story_id) story_id, status
       FROM story_results
      WHERE run_id = $1
      ORDER BY story_id, created_at DESC`,
    [runId],
  );
  return new Set(rows.filter((row) => row.status === 'pass').map((row) => row.story_id));
}

export async function setRunAuthorityPreflightState(
  runId: number,
  status: 'AUTHORIZED' | AuthorityRunWaitState,
  diagnostics: Record<string, unknown>,
): Promise<boolean> {
  const compatibilityStatus = status === 'AUTHORIZED' ? 'queued' : status;
  const lifecycleStatus = status === 'AUTHORIZED'
    ? 'queued'
    : status.toLowerCase();
  const result = await execute(
    `UPDATE pipeline_runs
        SET status = $2, lifecycle_status = $3,
            lifecycle_diagnostics = COALESCE(lifecycle_diagnostics, '{}'::jsonb) || $4::jsonb,
            lifecycle_updated_at = NOW()
      WHERE id = $1
        AND status IN ('queued', 'WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_AUTHENTICATION', 'WAITING_FOR_CHANGE_WINDOW')`,
    [runId, compatibilityStatus, lifecycleStatus, JSON.stringify(diagnostics)],
  );
  return result.rowCount === 1;
}
