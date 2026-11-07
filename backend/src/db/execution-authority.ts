/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { execute, query, queryOne } from './index';
import { assertAuthorityRedactedValue } from '../lib/authority-redaction';

export const EXECUTION_AUTHORITY_SCHEMA_VERSION = 'rorca.execution-authority.v1' as const;

export type AuthorityJson = Readonly<Record<string, unknown>>;
export type ProviderBindingStatus = 'active' | 'stale' | 'revoked';
export type OperationIntentStatus = 'proposed' | 'authorized' | 'executing' | 'settled' | 'cancelled';
export type AuthorityRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
export type AuthorityDecisionKind = 'approved' | 'denied';
export type AuthorityGrantStatus = 'active' | 'exhausted' | 'expired' | 'revoked';
export type CredentialLeaseStatus = 'prepared' | 'active' | 'exhausted' | 'revoked' | 'expired' | 'reconciliation_required';
export type ExecutionAttemptStatus = 'reserved' | 'running' | 'uncertain' | 'settled';
export type ExecutionReceiptOutcome = 'succeeded' | 'failed' | 'reconciled_succeeded' | 'reconciled_failed';
export type ExecutionReceiptRetention = 'standard' | 'extended' | 'legal_hold';

export interface AuthorityScope {
  workspaceId: string;
  runId: number;
  storyId: string;
  environment: string;
  providerResourceId: string;
  operation: string;
}

export interface SecretReferenceMetadata {
  secretReference: string;
  secretFingerprint: string;
}

interface AuthorityRecordBase {
  id: string;
  schemaVersion: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION;
  workspaceId: string;
  createdAt: Date;
}

export interface ProviderBindingRecord extends AuthorityRecordBase, SecretReferenceMetadata {
  bindingReference: string;
  generation: number;
  capabilityId: string;
  provider: string;
  environment: string;
  providerResourceId: string;
  status: ProviderBindingStatus;
  configuration: AuthorityJson;
  provenance: AuthorityJson;
  updatedAt: Date;
  revokedAt: Date | null;
}

export interface OperationIntentRecord extends AuthorityRecordBase, AuthorityScope {
  requestingPrincipal: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  constraints: AuthorityJson;
  evidenceDigest: string;
  canonicalDigest: string;
  idempotencyKey: string;
  status: OperationIntentStatus;
  provenance: AuthorityJson;
  updatedAt: Date;
  settledAt: Date | null;
}

export interface AuthorityRequestRecord extends AuthorityRecordBase, AuthorityScope {
  intentId: string;
  requestingPrincipal: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  constraints: AuthorityJson;
  evidenceDigest: string;
  requestDigest: string;
  idempotencyKey: string;
  status: AuthorityRequestStatus;
  maximumUses: number;
  expiresAt: Date;
  provenance: AuthorityJson;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export interface AuthorityDecisionRecord extends AuthorityRecordBase {
  requestId: string;
  requestDigest: string;
  requestingPrincipal: string;
  operatorPrincipal: string;
  decision: AuthorityDecisionKind;
  decisionDigest: string;
  idempotencyKey: string;
  reasonCode: string;
  provenance: AuthorityJson;
}

export interface AuthorityGrantRecord extends AuthorityRecordBase, AuthorityScope, SecretReferenceMetadata {
  requestId: string;
  decisionId: string;
  requestDigest: string;
  capabilityId: string;
  bindingReference: string;
  bindingGeneration: number;
  constraints: AuthorityJson;
  evidenceDigest: string;
  maximumUses: number;
  usesConsumed: number;
  fencingGeneration: number;
  status: AuthorityGrantStatus;
  idempotencyKey: string;
  provenance: AuthorityJson;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface CredentialLeaseRecord extends AuthorityRecordBase, AuthorityScope, SecretReferenceMetadata {
  grantId: string;
  bindingReference: string;
  bindingGeneration: number;
  leasePurpose: string;
  idempotencyKey: string;
  fencingGeneration: number;
  maximumUses: number;
  usesConsumed: number;
  status: CredentialLeaseStatus;
  provenance: AuthorityJson;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ExecutionAttemptRecord extends AuthorityRecordBase, AuthorityScope {
  intentId: string;
  grantId: string;
  leaseId: string;
  requestDigest: string;
  idempotencyKey: string;
  fencingGeneration: number;
  status: ExecutionAttemptStatus;
  providerOperationReference: string | null;
  failureDigest: string | null;
  provenance: AuthorityJson;
  updatedAt: Date;
  startedAt: Date | null;
  uncertainAt: Date | null;
  settledAt: Date | null;
}

export interface ExecutionReceiptRecord extends AuthorityRecordBase, AuthorityScope, SecretReferenceMetadata {
  attemptId: string;
  intentId: string;
  grantId: string;
  requestDigest: string;
  receiptDigest: string;
  idempotencyKey: string;
  fencingGeneration: number;
  outcome: ExecutionReceiptOutcome;
  providerReceiptReference: string;
  redactedPayload: AuthorityJson;
  provenance: AuthorityJson;
  status: 'settled';
  retentionClass: ExecutionReceiptRetention;
  retainedUntil: Date | null;
  settledAt: Date;
}

interface ProviderBindingRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string;
  binding_reference: string; generation: string | number; capability_id: string; provider: string;
  environment: string; provider_resource_id: string; secret_reference: string; secret_fingerprint: string;
  status: ProviderBindingStatus; configuration_json: AuthorityJson; provenance_json: AuthorityJson;
  created_at: Date; updated_at: Date; revoked_at: Date | null;
}

interface OperationIntentRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string;
  run_id: string | number; story_id: string; requesting_principal: string; capability_id: string;
  binding_reference: string; binding_generation: string | number; environment: string;
  provider_resource_id: string; operation: string; constraints_json: AuthorityJson; evidence_digest: string;
  canonical_digest: string; idempotency_key: string; status: OperationIntentStatus; provenance_json: AuthorityJson;
  created_at: Date; updated_at: Date; settled_at: Date | null;
}

interface AuthorityRequestRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string; intent_id: string;
  run_id: string | number; story_id: string; requesting_principal: string; capability_id: string;
  binding_reference: string; binding_generation: string | number; environment: string;
  provider_resource_id: string; operation: string; constraints_json: AuthorityJson; evidence_digest: string;
  request_digest: string; idempotency_key: string; status: AuthorityRequestStatus; maximum_uses: number;
  expires_at: Date; provenance_json: AuthorityJson; created_at: Date; updated_at: Date; resolved_at: Date | null;
}

interface AuthorityDecisionRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string; request_id: string;
  request_digest: string; requesting_principal: string; operator_principal: string; decision: AuthorityDecisionKind;
  decision_digest: string; idempotency_key: string; reason_code: string; provenance_json: AuthorityJson; created_at: Date;
}

interface AuthorityGrantRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string; request_id: string;
  decision_id: string; request_digest: string; run_id: string | number; story_id: string; capability_id: string;
  binding_reference: string; binding_generation: string | number; environment: string; provider_resource_id: string;
  operation: string; constraints_json: AuthorityJson; evidence_digest: string; secret_reference: string;
  secret_fingerprint: string; maximum_uses: number; uses_consumed: number; fencing_generation: string | number;
  status: AuthorityGrantStatus; idempotency_key: string; provenance_json: AuthorityJson; created_at: Date;
  updated_at: Date; expires_at: Date; revoked_at: Date | null;
}

interface CredentialLeaseRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string; grant_id: string;
  binding_reference: string; binding_generation: string | number; run_id: string | number; story_id: string;
  environment: string; provider_resource_id: string; operation: string; lease_purpose: string;
  idempotency_key: string; secret_reference: string; secret_fingerprint: string;
  fencing_generation: string | number; maximum_uses: number; uses_consumed: number;
  status: CredentialLeaseStatus; provenance_json: AuthorityJson; created_at: Date; updated_at: Date;
  expires_at: Date; revoked_at: Date | null;
}

interface ExecutionAttemptRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string; intent_id: string;
  grant_id: string; lease_id: string; run_id: string | number; story_id: string; environment: string;
  provider_resource_id: string; operation: string; request_digest: string; idempotency_key: string;
  fencing_generation: string | number; status: ExecutionAttemptStatus; provider_operation_reference: string | null;
  failure_digest: string | null; provenance_json: AuthorityJson; created_at: Date; updated_at: Date;
  started_at: Date | null; uncertain_at: Date | null; settled_at: Date | null;
}

interface ExecutionReceiptRow {
  id: string; schema_version: typeof EXECUTION_AUTHORITY_SCHEMA_VERSION; workspace_id: string; attempt_id: string;
  intent_id: string; grant_id: string; run_id: string | number; story_id: string; environment: string;
  provider_resource_id: string; operation: string; request_digest: string; receipt_digest: string;
  idempotency_key: string; fencing_generation: string | number; outcome: ExecutionReceiptOutcome;
  provider_receipt_reference: string; secret_reference: string; secret_fingerprint: string;
  redacted_payload: AuthorityJson; provenance_json: AuthorityJson; status: 'settled';
  retention_class: ExecutionReceiptRetention; retained_until: Date | null; created_at: Date; settled_at: Date;
}

function required<T>(value: T | undefined, recordName: string): T {
  if (!value) throw new Error(`Failed to persist ${recordName}`);
  return value;
}

function mapProviderBinding(row: ProviderBindingRow): ProviderBindingRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id,
    bindingReference: row.binding_reference, generation: Number(row.generation), capabilityId: row.capability_id,
    provider: row.provider, environment: row.environment, providerResourceId: row.provider_resource_id,
    secretReference: row.secret_reference, secretFingerprint: row.secret_fingerprint, status: row.status,
    configuration: row.configuration_json, provenance: row.provenance_json, createdAt: row.created_at,
    updatedAt: row.updated_at, revokedAt: row.revoked_at,
  };
}

function mapOperationIntent(row: OperationIntentRow): OperationIntentRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, runId: Number(row.run_id),
    storyId: row.story_id, requestingPrincipal: row.requesting_principal, capabilityId: row.capability_id,
    bindingReference: row.binding_reference, bindingGeneration: Number(row.binding_generation),
    environment: row.environment, providerResourceId: row.provider_resource_id, operation: row.operation,
    constraints: row.constraints_json, evidenceDigest: row.evidence_digest, canonicalDigest: row.canonical_digest,
    idempotencyKey: row.idempotency_key, status: row.status, provenance: row.provenance_json,
    createdAt: row.created_at, updatedAt: row.updated_at, settledAt: row.settled_at,
  };
}

function mapAuthorityRequest(row: AuthorityRequestRow): AuthorityRequestRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, intentId: row.intent_id,
    runId: Number(row.run_id), storyId: row.story_id, requestingPrincipal: row.requesting_principal,
    capabilityId: row.capability_id, bindingReference: row.binding_reference,
    bindingGeneration: Number(row.binding_generation), environment: row.environment,
    providerResourceId: row.provider_resource_id, operation: row.operation, constraints: row.constraints_json,
    evidenceDigest: row.evidence_digest, requestDigest: row.request_digest, idempotencyKey: row.idempotency_key,
    status: row.status, maximumUses: row.maximum_uses, expiresAt: row.expires_at,
    provenance: row.provenance_json, createdAt: row.created_at, updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

function mapAuthorityDecision(row: AuthorityDecisionRow): AuthorityDecisionRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, requestId: row.request_id,
    requestDigest: row.request_digest, requestingPrincipal: row.requesting_principal,
    operatorPrincipal: row.operator_principal, decision: row.decision, decisionDigest: row.decision_digest,
    idempotencyKey: row.idempotency_key, reasonCode: row.reason_code, provenance: row.provenance_json,
    createdAt: row.created_at,
  };
}

function mapAuthorityGrant(row: AuthorityGrantRow): AuthorityGrantRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, requestId: row.request_id,
    decisionId: row.decision_id, requestDigest: row.request_digest, runId: Number(row.run_id), storyId: row.story_id,
    capabilityId: row.capability_id, bindingReference: row.binding_reference,
    bindingGeneration: Number(row.binding_generation), environment: row.environment,
    providerResourceId: row.provider_resource_id, operation: row.operation, constraints: row.constraints_json,
    evidenceDigest: row.evidence_digest, secretReference: row.secret_reference,
    secretFingerprint: row.secret_fingerprint, maximumUses: row.maximum_uses, usesConsumed: row.uses_consumed,
    fencingGeneration: Number(row.fencing_generation), status: row.status, idempotencyKey: row.idempotency_key,
    provenance: row.provenance_json, createdAt: row.created_at, updatedAt: row.updated_at,
    expiresAt: row.expires_at, revokedAt: row.revoked_at,
  };
}

function mapCredentialLease(row: CredentialLeaseRow): CredentialLeaseRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, grantId: row.grant_id,
    bindingReference: row.binding_reference, bindingGeneration: Number(row.binding_generation),
    runId: Number(row.run_id), storyId: row.story_id, environment: row.environment,
    providerResourceId: row.provider_resource_id, operation: row.operation, leasePurpose: row.lease_purpose,
    idempotencyKey: row.idempotency_key, secretReference: row.secret_reference,
    secretFingerprint: row.secret_fingerprint,
    fencingGeneration: Number(row.fencing_generation), maximumUses: row.maximum_uses,
    usesConsumed: row.uses_consumed, status: row.status, provenance: row.provenance_json,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
  };
}

function mapExecutionAttempt(row: ExecutionAttemptRow): ExecutionAttemptRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, intentId: row.intent_id,
    grantId: row.grant_id, leaseId: row.lease_id, runId: Number(row.run_id), storyId: row.story_id,
    environment: row.environment, providerResourceId: row.provider_resource_id, operation: row.operation,
    requestDigest: row.request_digest, idempotencyKey: row.idempotency_key,
    fencingGeneration: Number(row.fencing_generation), status: row.status,
    providerOperationReference: row.provider_operation_reference, failureDigest: row.failure_digest,
    provenance: row.provenance_json, createdAt: row.created_at, updatedAt: row.updated_at,
    startedAt: row.started_at, uncertainAt: row.uncertain_at, settledAt: row.settled_at,
  };
}

function mapExecutionReceipt(row: ExecutionReceiptRow): ExecutionReceiptRecord {
  return {
    id: row.id, schemaVersion: row.schema_version, workspaceId: row.workspace_id, attemptId: row.attempt_id,
    intentId: row.intent_id, grantId: row.grant_id, runId: Number(row.run_id), storyId: row.story_id,
    environment: row.environment, providerResourceId: row.provider_resource_id, operation: row.operation,
    requestDigest: row.request_digest, receiptDigest: row.receipt_digest, idempotencyKey: row.idempotency_key,
    fencingGeneration: Number(row.fencing_generation), outcome: row.outcome,
    providerReceiptReference: row.provider_receipt_reference, secretReference: row.secret_reference,
    secretFingerprint: row.secret_fingerprint, redactedPayload: row.redacted_payload,
    provenance: row.provenance_json, status: row.status, retentionClass: row.retention_class,
    retainedUntil: row.retained_until, createdAt: row.created_at, settledAt: row.settled_at,
  };
}

export interface CreateProviderBindingInput extends SecretReferenceMetadata {
  workspaceId: string; bindingReference: string; generation: number; capabilityId: string; provider: string;
  environment: string; providerResourceId: string; configuration: AuthorityJson; provenance: AuthorityJson;
}

export async function createProviderBinding(input: CreateProviderBindingInput): Promise<ProviderBindingRecord> {
  const row = await queryOne<ProviderBindingRow>(
    `INSERT INTO execution_authority_bindings
      (workspace_id, binding_reference, generation, capability_id, provider, environment,
       provider_resource_id, secret_reference, secret_fingerprint, configuration_json, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [input.workspaceId, input.bindingReference, input.generation, input.capabilityId, input.provider,
      input.environment, input.providerResourceId, input.secretReference, input.secretFingerprint,
      input.configuration, input.provenance],
  );
  return mapProviderBinding(required(row, 'provider binding'));
}

export interface CreateOperationIntentInput extends AuthorityScope {
  requestingPrincipal: string; capabilityId: string; bindingReference: string; bindingGeneration: number;
  constraints: AuthorityJson; evidenceDigest: string; canonicalDigest: string; idempotencyKey: string;
  provenance: AuthorityJson;
}

export async function createOperationIntent(input: CreateOperationIntentInput): Promise<OperationIntentRecord> {
  const row = await queryOne<OperationIntentRow>(
    `INSERT INTO operation_intents
      (workspace_id, run_id, story_id, requesting_principal, capability_id, binding_reference,
       binding_generation, environment, provider_resource_id, operation, constraints_json,
       evidence_digest, canonical_digest, idempotency_key, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING *`,
    [input.workspaceId, input.runId, input.storyId, input.requestingPrincipal, input.capabilityId,
      input.bindingReference, input.bindingGeneration, input.environment, input.providerResourceId,
      input.operation, input.constraints, input.evidenceDigest, input.canonicalDigest,
      input.idempotencyKey, input.provenance],
  );
  return mapOperationIntent(required(row, 'operation intent'));
}

export interface CreateAuthorityRequestInput extends AuthorityScope {
  intentId: string; requestingPrincipal: string; capabilityId: string; bindingReference: string;
  bindingGeneration: number; constraints: AuthorityJson; evidenceDigest: string; requestDigest: string;
  idempotencyKey: string; maximumUses: number; expiresAt: Date; provenance: AuthorityJson;
}

export async function createAuthorityRequest(input: CreateAuthorityRequestInput): Promise<AuthorityRequestRecord> {
  const row = await queryOne<AuthorityRequestRow>(
    `INSERT INTO authority_requests
      (workspace_id, intent_id, run_id, story_id, requesting_principal, capability_id,
       binding_reference, binding_generation, environment, provider_resource_id, operation,
       constraints_json, evidence_digest, request_digest, idempotency_key, maximum_uses,
       expires_at, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *`,
    [input.workspaceId, input.intentId, input.runId, input.storyId, input.requestingPrincipal,
      input.capabilityId, input.bindingReference, input.bindingGeneration, input.environment,
      input.providerResourceId, input.operation, input.constraints, input.evidenceDigest,
      input.requestDigest, input.idempotencyKey, input.maximumUses, input.expiresAt, input.provenance],
  );
  return mapAuthorityRequest(required(row, 'authority request'));
}

export interface RecordAuthorityDecisionInput {
  workspaceId: string; requestId: string; requestDigest: string; requestingPrincipal: string;
  operatorPrincipal: string; decision: AuthorityDecisionKind; decisionDigest: string;
  idempotencyKey: string; reasonCode: string; provenance: AuthorityJson;
}

export async function recordAuthorityDecision(input: RecordAuthorityDecisionInput): Promise<AuthorityDecisionRecord> {
  const row = await queryOne<AuthorityDecisionRow>(
    `INSERT INTO authority_decisions
      (workspace_id, request_id, request_digest, requesting_principal, operator_principal,
       decision, decision_digest, idempotency_key, reason_code, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [input.workspaceId, input.requestId, input.requestDigest, input.requestingPrincipal,
      input.operatorPrincipal, input.decision, input.decisionDigest, input.idempotencyKey,
      input.reasonCode, input.provenance],
  );
  return mapAuthorityDecision(required(row, 'authority decision'));
}

export interface CreateAuthorityGrantInput extends AuthorityScope, SecretReferenceMetadata {
  requestId: string; decisionId: string; requestDigest: string; capabilityId: string;
  bindingReference: string; bindingGeneration: number; constraints: AuthorityJson; evidenceDigest: string;
  maximumUses: number; fencingGeneration: number; idempotencyKey: string; provenance: AuthorityJson;
  expiresAt: Date;
}

export async function createAuthorityGrant(input: CreateAuthorityGrantInput): Promise<AuthorityGrantRecord> {
  const row = await queryOne<AuthorityGrantRow>(
    `INSERT INTO authority_grants
      (workspace_id, request_id, decision_id, request_digest, run_id, story_id, capability_id,
       binding_reference, binding_generation, environment, provider_resource_id, operation,
       constraints_json, evidence_digest, secret_reference, secret_fingerprint, maximum_uses,
       fencing_generation, idempotency_key, provenance_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [input.workspaceId, input.requestId, input.decisionId, input.requestDigest, input.runId,
      input.storyId, input.capabilityId, input.bindingReference, input.bindingGeneration,
      input.environment, input.providerResourceId, input.operation, input.constraints,
      input.evidenceDigest, input.secretReference, input.secretFingerprint, input.maximumUses,
      input.fencingGeneration, input.idempotencyKey, input.provenance, input.expiresAt],
  );
  return mapAuthorityGrant(required(row, 'authority grant'));
}

export async function consumeAuthorityGrant(input: {
  grantId: string; requestDigest: string; scope: AuthorityScope; fencingGeneration: number;
}): Promise<AuthorityGrantRecord> {
  const row = await queryOne<AuthorityGrantRow>(
    `SELECT * FROM consume_authority_grant_v1($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [input.grantId, input.requestDigest, input.scope.workspaceId, input.scope.runId,
      input.scope.storyId, input.scope.environment, input.scope.providerResourceId,
      input.scope.operation, input.fencingGeneration],
  );
  return mapAuthorityGrant(required(row, 'authority grant use'));
}

export interface CreateCredentialLeaseInput extends AuthorityScope, SecretReferenceMetadata {
  grantId: string; bindingReference: string; bindingGeneration: number; leasePurpose: string;
  idempotencyKey: string; fencingGeneration: number; maximumUses: number; provenance: AuthorityJson;
  expiresAt: Date;
}

export async function createCredentialLease(input: CreateCredentialLeaseInput): Promise<CredentialLeaseRecord> {
  const row = await queryOne<CredentialLeaseRow>(
    `INSERT INTO credential_leases
      (workspace_id, grant_id, binding_reference, binding_generation, run_id, story_id,
       environment, provider_resource_id, operation, lease_purpose, idempotency_key,
       secret_reference, secret_fingerprint, fencing_generation, maximum_uses,
       provenance_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [input.workspaceId, input.grantId, input.bindingReference, input.bindingGeneration,
      input.runId, input.storyId, input.environment, input.providerResourceId, input.operation,
      input.leasePurpose, input.idempotencyKey, input.secretReference, input.secretFingerprint,
      input.fencingGeneration, input.maximumUses, input.provenance, input.expiresAt],
  );
  return mapCredentialLease(required(row, 'credential lease'));
}

export async function transitionCredentialLease(input: {
  workspaceId: string;
  leaseId: string;
  fencingGeneration: number;
  from: CredentialLeaseStatus;
  to: CredentialLeaseStatus;
  usesConsumed: number;
}): Promise<boolean> {
  const result = await execute(
    `UPDATE credential_leases
        SET status = $1, uses_consumed = $2
      WHERE workspace_id = $3 AND id = $4 AND fencing_generation = $5 AND status = $6`,
    [input.to, input.usesConsumed, input.workspaceId, input.leaseId, input.fencingGeneration, input.from],
  );
  return result.rowCount === 1;
}

export interface ReserveExecutionAttemptInput extends AuthorityScope {
  intentId: string; grantId: string; leaseId: string; requestDigest: string;
  idempotencyKey: string; fencingGeneration: number; provenance: AuthorityJson;
}

export async function reserveExecutionAttempt(input: ReserveExecutionAttemptInput): Promise<ExecutionAttemptRecord> {
  const row = await queryOne<ExecutionAttemptRow>(
    `INSERT INTO execution_attempts
      (workspace_id, intent_id, grant_id, lease_id, run_id, story_id, environment,
       provider_resource_id, operation, request_digest, idempotency_key, fencing_generation, provenance_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [input.workspaceId, input.intentId, input.grantId, input.leaseId, input.runId,
      input.storyId, input.environment, input.providerResourceId, input.operation,
      input.requestDigest, input.idempotencyKey, input.fencingGeneration, input.provenance],
  );
  return mapExecutionAttempt(required(row, 'execution attempt'));
}

export async function transitionExecutionAttempt(input: {
  workspaceId: string;
  attemptId: string;
  idempotencyKey: string;
  fencingGeneration: number;
  from: Exclude<ExecutionAttemptStatus, 'settled'>;
  to: Exclude<ExecutionAttemptStatus, 'settled'>;
  providerOperationReference?: string; failureDigest?: string;
}): Promise<boolean> {
  const result = await execute(
    `UPDATE execution_attempts AS attempt
        SET status = $1,
            provider_operation_reference = COALESCE($2, provider_operation_reference),
            failure_digest = COALESCE($3, failure_digest)
      WHERE id = $4
        AND workspace_id = $5
        AND idempotency_key = $6
        AND fencing_generation = $7
        AND status = $8
        AND NOT EXISTS (
          SELECT 1 FROM execution_attempts AS newer
           WHERE newer.workspace_id = attempt.workspace_id
             AND newer.idempotency_key = attempt.idempotency_key
             AND newer.fencing_generation > attempt.fencing_generation
        )`,
    [input.to, input.providerOperationReference ?? null, input.failureDigest ?? null,
      input.attemptId, input.workspaceId, input.idempotencyKey, input.fencingGeneration, input.from],
  );
  return result.rowCount === 1;
}

export interface SettleExecutionReceiptInput extends AuthorityScope, SecretReferenceMetadata {
  attemptId: string; intentId: string; grantId: string; requestDigest: string; receiptDigest: string;
  idempotencyKey: string; fencingGeneration: number; outcome: ExecutionReceiptOutcome;
  providerReceiptReference: string; redactedPayload: AuthorityJson; provenance: AuthorityJson;
  retentionClass: ExecutionReceiptRetention; retainedUntil: Date | null;
}

export async function settleExecutionReceipt(input: SettleExecutionReceiptInput): Promise<ExecutionReceiptRecord> {
  const row = await queryOne<ExecutionReceiptRow>(
    `INSERT INTO execution_receipts
      (workspace_id, attempt_id, intent_id, grant_id, run_id, story_id, environment,
       provider_resource_id, operation, request_digest, receipt_digest, idempotency_key,
       fencing_generation, outcome, provider_receipt_reference, secret_reference,
       secret_fingerprint, redacted_payload, provenance_json, retention_class, retained_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [input.workspaceId, input.attemptId, input.intentId, input.grantId, input.runId,
      input.storyId, input.environment, input.providerResourceId, input.operation,
      input.requestDigest, input.receiptDigest, input.idempotencyKey, input.fencingGeneration,
      input.outcome, input.providerReceiptReference, input.secretReference, input.secretFingerprint,
      input.redactedPayload, input.provenance, input.retentionClass, input.retainedUntil],
  );
  return mapExecutionReceipt(required(row, 'execution receipt'));
}

export async function getAuthorityRequest(workspaceId: string, requestId: string): Promise<AuthorityRequestRecord | null> {
  const row = await queryOne<AuthorityRequestRow>(
    `SELECT * FROM authority_requests WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, requestId],
  );
  return row ? mapAuthorityRequest(row) : null;
}

export async function getAuthorityRequestByIdempotencyKey(
  workspaceId: string,
  idempotencyKey: string,
): Promise<AuthorityRequestRecord | null> {
  const row = await queryOne<AuthorityRequestRow>(
    `SELECT * FROM authority_requests WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  return row ? mapAuthorityRequest(row) : null;
}

export async function getExecutionReceipt(workspaceId: string, receiptId: string): Promise<ExecutionReceiptRecord | null> {
  const row = await queryOne<ExecutionReceiptRow>(
    `SELECT * FROM execution_receipts WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, receiptId],
  );
  return row ? mapExecutionReceipt(row) : null;
}

export async function getExecutionReceiptByIdempotencyKey(
  workspaceId: string,
  idempotencyKey: string,
): Promise<ExecutionReceiptRecord | null> {
  const row = await queryOne<ExecutionReceiptRow>(
    `SELECT * FROM execution_receipts WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, idempotencyKey],
  );
  return row ? mapExecutionReceipt(row) : null;
}

export interface AuthorityRecordPage<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  cursorId: string | null;
}

export interface AuthorityPageInput {
  workspaceId: string;
  limit: number;
  offset: number;
  cursorId?: string | null;
}

export async function listAuthorityRequestsPage(
  input: AuthorityPageInput & { status?: AuthorityRequestStatus },
): Promise<AuthorityRecordPage<AuthorityRequestRecord>> {
  const filterParams: unknown[] = [input.workspaceId];
  let filter = 'workspace_id = $1';
  if (input.status) {
    filterParams.push(input.status);
    filter += ` AND status = $${filterParams.length}`;
  }
  const count = await queryOne<{ total: string | number }>(
    `SELECT COUNT(*) AS total FROM authority_requests WHERE ${filter}`,
    filterParams,
  );
  const pageParams = [...filterParams];
  let cursorFilter = '';
  if (input.cursorId) {
    pageParams.push(input.cursorId);
    cursorFilter = ` AND id::text < $${pageParams.length}`;
  }
  pageParams.push(input.limit + 1);
  let pagination = `LIMIT $${pageParams.length}`;
  if (!input.cursorId) {
    pageParams.push(input.offset);
    pagination += ` OFFSET $${pageParams.length}`;
  }
  const rows = await query<AuthorityRequestRow>(
    `SELECT * FROM authority_requests
      WHERE ${filter}${cursorFilter}
      ORDER BY id::text DESC
      ${pagination}`,
    pageParams,
  );
  const hasMore = input.cursorId
    ? rows.length > input.limit
    : input.offset + Math.min(rows.length, input.limit) < Number(count?.total ?? 0);
  const pageRows = rows.slice(0, input.limit);
  return {
    items: pageRows.map(mapAuthorityRequest),
    total: Number(count?.total ?? 0),
    hasMore,
    cursorId: pageRows.at(-1)?.id ?? null,
  };
}

export async function listExecutionReceiptsPage(
  input: AuthorityPageInput,
): Promise<AuthorityRecordPage<ExecutionReceiptRecord>> {
  const count = await queryOne<{ total: string | number }>(
    `SELECT COUNT(*) AS total FROM execution_receipts WHERE workspace_id = $1`,
    [input.workspaceId],
  );
  const params: unknown[] = [input.workspaceId];
  let cursorFilter = '';
  if (input.cursorId) {
    params.push(input.cursorId);
    cursorFilter = ` AND id::text < $${params.length}`;
  }
  params.push(input.limit + 1);
  let pagination = `LIMIT $${params.length}`;
  if (!input.cursorId) {
    params.push(input.offset);
    pagination += ` OFFSET $${params.length}`;
  }
  const rows = await query<ExecutionReceiptRow>(
    `SELECT * FROM execution_receipts
      WHERE workspace_id = $1${cursorFilter}
      ORDER BY id::text DESC
      ${pagination}`,
    params,
  );
  const hasMore = input.cursorId
    ? rows.length > input.limit
    : input.offset + Math.min(rows.length, input.limit) < Number(count?.total ?? 0);
  const pageRows = rows.slice(0, input.limit);
  return {
    items: pageRows.map(mapExecutionReceipt),
    total: Number(count?.total ?? 0),
    hasMore,
    cursorId: pageRows.at(-1)?.id ?? null,
  };
}

export async function getOperationIntent(workspaceId: string, intentId: string): Promise<OperationIntentRecord | null> {
  const row = await queryOne<OperationIntentRow>(
    `SELECT * FROM operation_intents WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, intentId],
  );
  return row ? mapOperationIntent(row) : null;
}

export async function getAuthorityGrant(workspaceId: string, grantId: string): Promise<AuthorityGrantRecord | null> {
  const row = await queryOne<AuthorityGrantRow>(
    `SELECT * FROM authority_grants WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, grantId],
  );
  return row ? mapAuthorityGrant(row) : null;
}

export async function getCredentialLease(workspaceId: string, leaseId: string): Promise<CredentialLeaseRecord | null> {
  const row = await queryOne<CredentialLeaseRow>(
    `SELECT * FROM credential_leases WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, leaseId],
  );
  return row ? mapCredentialLease(row) : null;
}

export async function getExecutionAttempt(workspaceId: string, attemptId: string): Promise<ExecutionAttemptRecord | null> {
  const row = await queryOne<ExecutionAttemptRow>(
    `SELECT * FROM execution_attempts WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, attemptId],
  );
  return row ? mapExecutionAttempt(row) : null;
}

export async function getLatestExecutionAttempt(
  workspaceId: string,
  idempotencyKey: string,
): Promise<ExecutionAttemptRecord | null> {
  const row = await queryOne<ExecutionAttemptRow>(
    `SELECT * FROM execution_attempts
      WHERE workspace_id = $1 AND idempotency_key = $2
      ORDER BY fencing_generation DESC
      LIMIT 1`,
    [workspaceId, idempotencyKey],
  );
  return row ? mapExecutionAttempt(row) : null;
}

export async function isCurrentExecutionAttempt(input: {
  workspaceId: string;
  attemptId: string;
  idempotencyKey: string;
  fencingGeneration: number;
}): Promise<boolean> {
  const row = await queryOne<{ current: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM execution_attempts AS attempt
        WHERE attempt.workspace_id = $1
          AND attempt.id = $2
          AND attempt.idempotency_key = $3
          AND attempt.fencing_generation = $4
          AND NOT EXISTS (
            SELECT 1 FROM execution_attempts AS newer
             WHERE newer.workspace_id = attempt.workspace_id
               AND newer.idempotency_key = attempt.idempotency_key
               AND newer.fencing_generation > attempt.fencing_generation
          )
     ) AS current`,
    [input.workspaceId, input.attemptId, input.idempotencyKey, input.fencingGeneration],
  );
  return row?.current === true;
}

export async function listRecoverableExecutionAttempts(input: {
  workspaceId: string;
  runId: number;
  storyId?: string;
}): Promise<ExecutionAttemptRecord[]> {
  const rows = await query<ExecutionAttemptRow>(
    `SELECT latest.*
       FROM (
         SELECT DISTINCT ON (idempotency_key)
                attempt.*,
                MIN(created_at) OVER (PARTITION BY idempotency_key) AS operation_created_at
           FROM execution_attempts AS attempt
          WHERE workspace_id = $1
            AND run_id = $2
            AND ($3::text IS NULL OR story_id = $3)
          ORDER BY idempotency_key, fencing_generation DESC
       ) AS latest
      WHERE latest.status <> 'settled'
      ORDER BY latest.operation_created_at, latest.idempotency_key`,
    [input.workspaceId, input.runId, input.storyId ?? null],
  );
  return rows.map(mapExecutionAttempt);
}

export async function getProviderBinding(workspaceId: string, bindingId: string): Promise<ProviderBindingRecord | null> {
  const row = await queryOne<ProviderBindingRow>(
    `SELECT * FROM execution_authority_bindings WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, bindingId],
  );
  return row ? mapProviderBinding(row) : null;
}

export async function getProviderBindingByReference(
  workspaceId: string,
  bindingReference: string,
  generation: number,
): Promise<ProviderBindingRecord | null> {
  const row = await queryOne<ProviderBindingRow>(
    `SELECT * FROM execution_authority_bindings
      WHERE workspace_id = $1 AND binding_reference = $2 AND generation = $3`,
    [workspaceId, bindingReference, generation],
  );
  return row ? mapProviderBinding(row) : null;
}

export async function getAuthorityDecision(workspaceId: string, decisionId: string): Promise<AuthorityDecisionRecord | null> {
  const row = await queryOne<AuthorityDecisionRow>(
    `SELECT * FROM authority_decisions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, decisionId],
  );
  return row ? mapAuthorityDecision(row) : null;
}

export async function getAuthorityDecisionForRequest(
  workspaceId: string,
  requestId: string,
): Promise<AuthorityDecisionRecord | null> {
  const row = await queryOne<AuthorityDecisionRow>(
    `SELECT * FROM authority_decisions WHERE workspace_id = $1 AND request_id = $2`,
    [workspaceId, requestId],
  );
  return row ? mapAuthorityDecision(row) : null;
}

export async function getAuthorityGrantForRequest(
  workspaceId: string,
  requestId: string,
): Promise<AuthorityGrantRecord | null> {
  const row = await queryOne<AuthorityGrantRow>(
    `SELECT * FROM authority_grants WHERE workspace_id = $1 AND request_id = $2`,
    [workspaceId, requestId],
  );
  return row ? mapAuthorityGrant(row) : null;
}

export async function updateAuthorityRequestStatus(
  workspaceId: string,
  requestId: string,
  status: 'cancelled' | 'expired',
): Promise<boolean> {
  const result = await execute(
    `UPDATE authority_requests SET status = $1 WHERE workspace_id = $2 AND id = $3 AND status = 'pending'`,
    [status, workspaceId, requestId],
  );
  return result.rowCount === 1;
}

export async function transitionOperationIntent(
  workspaceId: string,
  intentId: string,
  from: Exclude<OperationIntentStatus, 'settled' | 'cancelled'>,
  to: Exclude<OperationIntentStatus, 'proposed'>,
): Promise<boolean> {
  const result = await execute(
    `UPDATE operation_intents
        SET status = $1
      WHERE workspace_id = $2 AND id = $3 AND status = $4`,
    [to, workspaceId, intentId, from],
  );
  return result.rowCount === 1;
}

export async function expireAuthorityGrant(workspaceId: string, grantId: string): Promise<boolean> {
  const result = await execute(
    `UPDATE authority_grants SET status = 'expired'
      WHERE workspace_id = $1 AND id = $2 AND status = 'active' AND expires_at <= clock_timestamp()`,
    [workspaceId, grantId],
  );
  return result.rowCount === 1;
}

export type AuthorityWalEventType =
  | 'authority_request_created'
  | 'authority_request_cancelled'
  | 'authority_request_expired'
  | 'authority_request_approved'
  | 'authority_request_denied'
  | 'authority_grant_consumed'
  | 'authority_security_violation';

export async function appendAuthorityWalEvent(input: {
  eventType: AuthorityWalEventType;
  workspaceId: string;
  storyId: string;
  payload: AuthorityJson;
}): Promise<void> {
  assertAuthorityRedactedValue(input.payload, { maximumBytes: 32_768 });
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, story_id, actor, payload)
      VALUES ($1, $2, $3, 'execution-authority-policy', $4)`,
    [input.eventType, input.workspaceId, input.storyId, input.payload],
  );
}
