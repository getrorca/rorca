/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { runtimeTransaction } from '../db';
import { ConflictError, ForbiddenError, UnprocessableError } from './errors';
import {
  DatabaseResourceIdentitySchema,
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  readSupabaseDatabaseProviderBinding,
  type DatabaseAuthorityCapability,
  type DatabaseAuthoritySecretStore,
  type SupabaseDatabaseProviderBinding,
} from './supabase-database-authority-provider-adapter';

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IdentifierSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const ReferenceSchema = z.string().min(1).max(2048).refine((value) => {
  try {
    const url = new URL(value);
    if (!url.protocol || url.username || url.password) return false;
    for (const key of url.searchParams.keys()) {
      if (/password|secret|token|key|credential/i.test(key)) return false;
    }
    return !/^postgres(?:ql)?:$/i.test(url.protocol);
  } catch {
    return false;
  }
}, { message: 'Expected an opaque credential-free provider or SecretStore reference' });

const BindingScopeSchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(1).max(255),
  environment: z.enum(['staging', 'production']),
  databaseIdentity: DatabaseResourceIdentitySchema,
  bindingGeneration: z.number().int().positive(),
}).strict();
export type DatabaseBindingScope = z.infer<typeof BindingScopeSchema>;

const BackupGrantSchema = z.object({
  grantId: z.string().uuid(),
  capability: z.literal('database.backup.create'),
  riskClass: z.literal('elevated'),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  subjectHash: Sha256Schema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const RestoreGrantSchema = z.object({
  grantId: z.string().uuid(),
  capability: z.literal('database.backup.restore'),
  riskClass: z.literal('high'),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  subjectHash: Sha256Schema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const EncryptionRequestSchema = z.object({
  algorithm: z.string().min(3).max(128),
  keyReferenceId: ReferenceSchema,
  keyFingerprint: Sha256Schema,
}).strict();

const RetentionSchema = z.object({
  policy: IdentifierSchema,
  retainUntil: z.string().datetime({ offset: true }),
}).strict();

export const SupabaseBackupCreateSubjectSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(255),
  source: BindingScopeSchema,
  artifactId: z.string().uuid(),
  storageProviderId: IdentifierSchema,
  storageLocationReference: ReferenceSchema,
  encryption: EncryptionRequestSchema,
  retention: RetentionSchema,
  expectedSchemaHash: Sha256Schema,
}).strict();
export type SupabaseBackupCreateSubject = z.infer<typeof SupabaseBackupCreateSubjectSchema>;

export const SupabaseBackupCreateRequestSchema = SupabaseBackupCreateSubjectSchema.extend({
  authorityGrant: BackupGrantSchema,
}).strict();
export type SupabaseBackupCreateRequest = z.infer<typeof SupabaseBackupCreateRequestSchema>;

const RestoreTargetSchema = z.object({
  projectRef: z.string().min(1).max(255),
  environment: z.enum(['scratch', 'production']).default('scratch'),
  databaseIdentity: DatabaseResourceIdentitySchema,
  targetIdentityHash: Sha256Schema,
  connectionReferenceId: ReferenceSchema,
  connectionFingerprint: Sha256Schema,
  verifiedAt: z.string().datetime({ offset: true }),
  verificationExpiresAt: z.string().datetime({ offset: true }),
}).strict();
export type SupabaseRestoreTarget = z.infer<typeof RestoreTargetSchema>;

const ExpectedDataCheckSchema = z.object({
  checkId: IdentifierSchema,
  expectedHash: Sha256Schema,
}).strict();

export const SupabaseBackupRestoreSubjectSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(255),
  source: BindingScopeSchema,
  artifactId: z.string().uuid(),
  expectedArtifactHash: Sha256Schema,
  target: RestoreTargetSchema,
  expectedDataChecks: z.array(ExpectedDataCheckSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const ids = value.expectedDataChecks.map((check) => check.checkId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: 'custom', path: ['expectedDataChecks'], message: 'Duplicate data check id' });
  }
});
export type SupabaseBackupRestoreSubject = z.infer<typeof SupabaseBackupRestoreSubjectSchema>;

export const SupabaseBackupRestoreRequestSchema = SupabaseBackupRestoreSubjectSchema.safeExtend({
  authorityGrant: RestoreGrantSchema,
}).strict();
export type SupabaseBackupRestoreRequest = z.infer<typeof SupabaseBackupRestoreRequestSchema>;

const SourceIdentitySchema = z.object({
  providerId: z.literal('supabase-database'),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(1).max(255),
  environment: z.enum(['staging', 'production']),
  databaseIdentity: DatabaseResourceIdentitySchema,
  databaseIdentityHash: Sha256Schema,
  sourceIdentityHash: Sha256Schema,
}).strict();

const BackupProviderEvidenceSchema = z.object({
  artifactId: z.string().uuid(),
  providerArtifactReference: ReferenceSchema,
  storageProviderId: IdentifierSchema,
  storageLocationReference: ReferenceSchema,
  contentHash: Sha256Schema,
  byteLength: z.number().int().positive(),
  schemaHash: Sha256Schema,
  databaseVersion: z.string().min(1).max(255),
  encryption: z.object({
    algorithm: z.string().min(3).max(128),
    keyReferenceId: ReferenceSchema,
    keyFingerprint: Sha256Schema,
    encrypted: z.literal(true),
  }).strict(),
  verification: z.object({
    verified: z.literal(true),
    verifiedContentHash: Sha256Schema,
    verifiedAt: z.string().datetime({ offset: true }),
  }).strict(),
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type BackupProviderEvidence = z.infer<typeof BackupProviderEvidenceSchema>;

export const DatabaseBackupArtifactRecordSchema = z.object({
  version: z.literal('rorca.database-backup-artifact.v1'),
  artifactId: z.string().uuid(),
  source: SourceIdentitySchema,
  providerArtifactReference: ReferenceSchema,
  storageProviderId: IdentifierSchema,
  storageLocationReference: ReferenceSchema,
  contentHash: Sha256Schema,
  byteLength: z.number().int().positive(),
  schemaHash: Sha256Schema,
  databaseVersion: z.string().min(1).max(255),
  encryption: BackupProviderEvidenceSchema.shape.encryption,
  retention: RetentionSchema,
  verification: BackupProviderEvidenceSchema.shape.verification,
  createdAt: z.string().datetime({ offset: true }),
  recordHash: Sha256Schema,
}).strict();
export type DatabaseBackupArtifactRecord = z.infer<typeof DatabaseBackupArtifactRecordSchema>;

const RestoreTargetInspectionSchema = z.object({
  projectRef: z.string().min(1).max(255),
  environment: z.literal('scratch'),
  databaseIdentity: DatabaseResourceIdentitySchema,
  scratchPurposeVerified: z.literal(true),
  empty: z.boolean(),
}).strict();
export type RestoreTargetInspection = z.infer<typeof RestoreTargetInspectionSchema>;

const RestoredDataCheckSchema = z.object({
  checkId: IdentifierSchema,
  actualHash: Sha256Schema,
  passed: z.literal(true),
}).strict();

export const RestoreVerificationEvidenceSchema = z.object({
  schemaHash: Sha256Schema,
  dataChecks: z.array(RestoredDataCheckSchema).min(1).max(100),
  providerVerificationReference: ReferenceSchema,
  verifiedAt: z.string().datetime({ offset: true }),
}).strict();
export type RestoreVerificationEvidence = z.infer<typeof RestoreVerificationEvidenceSchema>;

export const DatabaseBackupCreateReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  capability: z.literal('database.backup.create'),
  operationId: z.string().uuid(),
  requestHash: Sha256Schema,
  resultHash: Sha256Schema,
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  workspaceId: z.string().min(1).max(255),
  authorityGrantId: z.string().uuid(),
  grantRiskClass: z.literal('elevated'),
  sourceIdentityHash: Sha256Schema,
  sourceConnectionReference: z.object({ referenceId: ReferenceSchema, fingerprint: Sha256Schema }).strict(),
  artifact: DatabaseBackupArtifactRecordSchema,
  settledAt: z.string().datetime({ offset: true }),
}).strict();
export type DatabaseBackupCreateReceipt = z.infer<typeof DatabaseBackupCreateReceiptSchema>;

export const DatabaseBackupRestoreReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  capability: z.literal('database.backup.restore'),
  operationId: z.string().uuid(),
  requestHash: Sha256Schema,
  resultHash: Sha256Schema,
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  workspaceId: z.string().min(1).max(255),
  authorityGrantId: z.string().uuid(),
  grantRiskClass: z.literal('high'),
  artifactId: z.string().uuid(),
  artifactContentHash: Sha256Schema,
  targetIdentityHash: Sha256Schema,
  targetConnectionReference: z.object({ referenceId: ReferenceSchema, fingerprint: Sha256Schema }).strict(),
  verification: RestoreVerificationEvidenceSchema,
  settledAt: z.string().datetime({ offset: true }),
}).strict();
export type DatabaseBackupRestoreOperationReceipt = z.infer<typeof DatabaseBackupRestoreReceiptSchema>;

export type DatabaseBackupRestoreReceipt = DatabaseBackupCreateReceipt | DatabaseBackupRestoreOperationReceipt;

export interface DatabaseAuthorityOperationStart {
  operationId: string;
  idempotencyKey: string;
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  capability: 'database.backup.create' | 'database.backup.restore';
  authorityGrantId: string;
  grantRiskClass: 'elevated' | 'high';
  requestHash: `sha256:${string}`;
  artifactId: string;
  targetIdentityHash?: `sha256:${string}`;
}

export interface DatabaseAuthorityOperationSnapshot {
  operationId: string;
  created: boolean;
  state: 'started' | 'succeeded' | 'cleanup-required';
  requestHash: `sha256:${string}`;
  result?: DatabaseBackupRestoreReceipt;
  cleanupReason?: string;
}

export interface CleanupRequiredEvidence {
  operationId: string;
  capability: 'database.backup.create' | 'database.backup.restore';
  reason: string;
  providerStateReference?: string;
  recordedAt: string;
}

export interface DatabaseBackupRestoreOperationStore {
  start(input: DatabaseAuthorityOperationStart): Promise<DatabaseAuthorityOperationSnapshot>;
  resume(input: DatabaseAuthorityOperationStart): Promise<DatabaseAuthorityOperationSnapshot | null>;
  loadBackupArtifact(artifactId: string): Promise<DatabaseBackupArtifactRecord | null>;
  settleBackup(receipt: DatabaseBackupCreateReceipt): Promise<DatabaseBackupCreateReceipt>;
  settleRestore(receipt: DatabaseBackupRestoreOperationReceipt): Promise<DatabaseBackupRestoreOperationReceipt>;
  markCleanupRequired(evidence: CleanupRequiredEvidence): Promise<void>;
}

export type BackupReconciliation =
  | { state: 'absent' }
  | { state: 'complete'; evidence: BackupProviderEvidence }
  | { state: 'cleanup-required'; reason: string; providerStateReference?: string };

export interface SupabaseBackupProvider {
  createEncryptedBackup(input: {
    operationId: string;
    sourceConnectionString: string;
    sourceIdentityHash: string;
    artifactId: string;
    storageProviderId: string;
    storageLocationReference: string;
    encryption: z.infer<typeof EncryptionRequestSchema>;
  }): Promise<BackupProviderEvidence>;
  reconcileBackup(input: {
    operationId: string;
    artifactId: string;
    storageProviderId: string;
    storageLocationReference: string;
  }): Promise<BackupReconciliation>;
}

export type RestoreReconciliation =
  | { state: 'absent' }
  | { state: 'complete'; verification: RestoreVerificationEvidence }
  | { state: 'cleanup-required'; reason: string; providerStateReference?: string };

export interface SupabaseRestoreProvider {
  inspectTarget(connectionString: string): Promise<RestoreTargetInspection>;
  restoreEncryptedBackup(input: {
    operationId: string;
    artifact: DatabaseBackupArtifactRecord;
    targetConnectionString: string;
  }): Promise<void>;
  verifyRestore(input: {
    operationId: string;
    artifact: DatabaseBackupArtifactRecord;
    targetConnectionString: string;
    checkIds: string[];
  }): Promise<RestoreVerificationEvidence>;
  reconcileRestore(input: {
    operationId: string;
    artifact: DatabaseBackupArtifactRecord;
    targetConnectionString: string;
    checkIds: string[];
  }): Promise<RestoreReconciliation>;
}

type BindingReader = (bindingId: string) => Promise<SupabaseDatabaseProviderBinding | null>;

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported canonical value');
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function databaseBackupCreateSubjectHash(
  rawSubject: SupabaseBackupCreateSubject | SupabaseBackupCreateRequest,
): `sha256:${string}` {
  const { authorityGrant: _authorityGrant, ...subjectInput } = rawSubject as SupabaseBackupCreateRequest;
  const subject = SupabaseBackupCreateSubjectSchema.parse(subjectInput);
  return digest({ capability: 'database.backup.create', subject });
}

export function databaseBackupRestoreSubjectHash(
  rawSubject: SupabaseBackupRestoreSubject | SupabaseBackupRestoreRequest,
): `sha256:${string}` {
  const { authorityGrant: _authorityGrant, ...subjectInput } = rawSubject as SupabaseBackupRestoreRequest;
  const subject = SupabaseBackupRestoreSubjectSchema.parse(subjectInput);
  return digest({ capability: 'database.backup.restore', subject });
}

export function restoreTargetIdentityHash(target: Pick<SupabaseRestoreTarget, 'projectRef' | 'environment' | 'databaseIdentity'>): `sha256:${string}` {
  return digest({
    providerId: 'supabase-database',
    projectRef: target.projectRef,
    environment: target.environment,
    databaseIdentity: target.databaseIdentity,
  });
}

export function databaseBackupSourceIdentityHash(
  binding: Pick<SupabaseDatabaseProviderBinding,
    'providerId' | 'bindingId' | 'bindingGeneration' | 'workspaceId' | 'projectRef'
    | 'environment' | 'databaseIdentity' | 'databaseIdentityHash'>,
): `sha256:${string}` {
  return digest({
    providerId: binding.providerId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    workspaceId: binding.workspaceId,
    projectRef: binding.projectRef,
    environment: binding.environment,
    databaseIdentity: binding.databaseIdentity,
    databaseIdentityHash: binding.databaseIdentityHash,
  });
}

function sourceIdentity(binding: SupabaseDatabaseProviderBinding): z.infer<typeof SourceIdentitySchema> {
  const identity = {
    providerId: binding.providerId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    workspaceId: binding.workspaceId,
    projectRef: binding.projectRef,
    environment: binding.environment,
    databaseIdentity: binding.databaseIdentity,
    databaseIdentityHash: binding.databaseIdentityHash,
  };
  return SourceIdentitySchema.parse({ ...identity, sourceIdentityHash: databaseBackupSourceIdentityHash(binding) });
}

function authorityFailure(reason: string): UnprocessableError {
  return new UnprocessableError(
    'Supabase database backup authority rejected the request',
    'DATABASE_BACKUP_AUTHORITY_REJECTED',
    { reason },
  );
}

function cleanupFailure(operationId: string, reason: string): UnprocessableError {
  return new UnprocessableError(
    'Database backup operation requires explicit cleanup',
    'DATABASE_BACKUP_CLEANUP_REQUIRED',
    { operationId, reason },
  );
}

function assertBinding(
  binding: SupabaseDatabaseProviderBinding | null,
  scope: DatabaseBindingScope,
  requiredCapability: DatabaseAuthorityCapability,
): asserts binding is SupabaseDatabaseProviderBinding {
  if (!binding) throw authorityFailure('binding_not_found');
  if (binding.providerId !== 'supabase-database') throw authorityFailure('wrong_provider');
  if (binding.bindingId !== scope.bindingId) throw authorityFailure('wrong_binding');
  if (binding.workspaceId !== scope.workspaceId) throw authorityFailure('wrong_workspace');
  if (binding.projectRef !== scope.projectRef) throw authorityFailure('wrong_project');
  if (binding.environment !== scope.environment) throw authorityFailure('wrong_environment');
  if (canonicalJson(binding.databaseIdentity) !== canonicalJson(scope.databaseIdentity)) throw authorityFailure('wrong_database');
  if (binding.databaseIdentityHash !== databaseResourceIdentityHash(binding.databaseIdentity)) throw authorityFailure('database_identity_hash_invalid');
  if (binding.bindingGeneration !== scope.bindingGeneration) throw authorityFailure('stale_generation');
  if (binding.bindingStatus !== 'active') throw authorityFailure('binding_inactive');
  if (!binding.roleProfile.verified) throw authorityFailure('role_unverified');
  if (binding.roleProfile.authenticationClass !== 'database-role') throw authorityFailure('application_credential_forbidden');
  if (!binding.roleProfile.capabilities.includes(requiredCapability)) throw authorityFailure('capability_missing');
  const reference = binding.secretReferences[0];
  if (!reference || reference.purpose !== 'database-connection') throw authorityFailure('reference_missing');
  if (reference.credentialClass !== 'database-role') throw authorityFailure('application_credential_forbidden');
}

function assertGrant(
  grant: z.infer<typeof BackupGrantSchema> | z.infer<typeof RestoreGrantSchema>,
  capability: 'database.backup.create' | 'database.backup.restore',
  riskClass: 'elevated' | 'high',
  scope: DatabaseBindingScope,
  subjectHash: `sha256:${string}`,
): void {
  if (grant.capability !== capability) throw authorityFailure('grant_capability_mismatch');
  if (grant.riskClass !== riskClass) throw authorityFailure('grant_risk_class_mismatch');
  if (grant.workspaceId !== scope.workspaceId || grant.bindingId !== scope.bindingId) throw authorityFailure('grant_scope_mismatch');
  if (grant.bindingGeneration !== scope.bindingGeneration) throw authorityFailure('grant_generation_mismatch');
  if (grant.subjectHash !== subjectHash) throw authorityFailure('grant_subject_mismatch');
}


async function resolveConnection(
  secretStore: DatabaseAuthoritySecretStore,
  referenceId: string,
  expectedFingerprint: string,
  expectedEndpointFingerprint: string,
): Promise<string> {
  let connectionString: string | null;
  try {
    connectionString = await secretStore.resolveDatabaseConnection(referenceId);
  } catch {
    throw authorityFailure('reference_unresolved');
  }
  if (!connectionString) throw authorityFailure('reference_unresolved');
  if (databaseCredentialFingerprint(connectionString) !== expectedFingerprint) throw authorityFailure('reference_fingerprint_mismatch');
  if (databaseEndpointFingerprint(connectionString) !== expectedEndpointFingerprint) throw authorityFailure('wrong_database_endpoint');
  return connectionString;
}

function buildArtifact(
  request: SupabaseBackupCreateRequest,
  binding: SupabaseDatabaseProviderBinding,
  rawEvidence: BackupProviderEvidence,
  now: Date,
): DatabaseBackupArtifactRecord {
  const evidence = BackupProviderEvidenceSchema.parse(rawEvidence);
  if (evidence.artifactId !== request.artifactId) throw authorityFailure('provider_artifact_mismatch');
  if (evidence.storageProviderId !== request.storageProviderId
      || evidence.storageLocationReference !== request.storageLocationReference) {
    throw authorityFailure('provider_storage_mismatch');
  }
  if (evidence.encryption.algorithm !== request.encryption.algorithm
      || evidence.encryption.keyReferenceId !== request.encryption.keyReferenceId
      || evidence.encryption.keyFingerprint !== request.encryption.keyFingerprint) {
    throw authorityFailure('encryption_provenance_mismatch');
  }
  if (evidence.verification.verifiedContentHash !== evidence.contentHash) throw authorityFailure('artifact_hash_verification_failed');
  if (evidence.schemaHash !== request.expectedSchemaHash) throw authorityFailure('backup_schema_verification_failed');
  if (new Date(request.retention.retainUntil).getTime() <= now.getTime()) throw authorityFailure('retention_stale');
  const withoutHash = {
    version: 'rorca.database-backup-artifact.v1' as const,
    artifactId: evidence.artifactId,
    source: sourceIdentity(binding),
    providerArtifactReference: evidence.providerArtifactReference,
    storageProviderId: evidence.storageProviderId,
    storageLocationReference: evidence.storageLocationReference,
    contentHash: evidence.contentHash,
    byteLength: evidence.byteLength,
    schemaHash: evidence.schemaHash,
    databaseVersion: evidence.databaseVersion,
    encryption: evidence.encryption,
    retention: request.retention,
    verification: evidence.verification,
    createdAt: evidence.createdAt,
  };
  return DatabaseBackupArtifactRecordSchema.parse({ ...withoutHash, recordHash: digest(withoutHash) });
}

function assertRestoreVerification(
  artifact: DatabaseBackupArtifactRecord,
  expectedChecks: Array<z.infer<typeof ExpectedDataCheckSchema>>,
  rawVerification: RestoreVerificationEvidence,
): RestoreVerificationEvidence {
  const verification = RestoreVerificationEvidenceSchema.parse(rawVerification);
  if (verification.schemaHash !== artifact.schemaHash) throw authorityFailure('restored_schema_hash_mismatch');
  const expected = new Map(expectedChecks.map((check) => [check.checkId, check.expectedHash]));
  if (verification.dataChecks.length !== expected.size) throw authorityFailure('restore_data_checks_incomplete');
  for (const check of verification.dataChecks) {
    if (expected.get(check.checkId) !== check.actualHash) throw authorityFailure('restore_data_check_failed');
    expected.delete(check.checkId);
  }
  if (expected.size > 0) throw authorityFailure('restore_data_checks_incomplete');
  return verification;
}

function receiptFromSnapshot<T extends DatabaseBackupRestoreReceipt>(
  snapshot: DatabaseAuthorityOperationSnapshot,
  schema: z.ZodType<T>,
): T | null {
  if (snapshot.state === 'cleanup-required') throw cleanupFailure(snapshot.operationId, snapshot.cleanupReason ?? 'cleanup_required');
  if (snapshot.state !== 'succeeded') return null;
  if (!snapshot.result) throw new ConflictError('Settled database authority operation is missing its receipt');
  return schema.parse(snapshot.result);
}

async function markCleanup(
  store: DatabaseBackupRestoreOperationStore,
  operationId: string,
  capability: 'database.backup.create' | 'database.backup.restore',
  reason: string,
  now: Date,
  providerStateReference?: string,
): Promise<never> {
  await store.markCleanupRequired({
    operationId,
    capability,
    reason,
    ...(providerStateReference ? { providerStateReference } : {}),
    recordedAt: now.toISOString(),
  });
  throw cleanupFailure(operationId, reason);
}

export interface SupabaseBackupAdapterDependencies {
  secretStore: DatabaseAuthoritySecretStore;
  provider: SupabaseBackupProvider;
  operationStore?: DatabaseBackupRestoreOperationStore;
  readBinding?: BindingReader;
  now?: () => Date;
}

export class SupabaseDatabaseBackupAuthorityProviderAdapter {
  readonly capabilities = Object.freeze(['database.backup.create'] as const satisfies readonly DatabaseAuthorityCapability[]);
  private readonly store: DatabaseBackupRestoreOperationStore;
  private readonly readBinding: BindingReader;
  private readonly now: () => Date;

  constructor(private readonly dependencies: SupabaseBackupAdapterDependencies) {
    this.store = dependencies.operationStore ?? databaseBackupRestoreOperationStore;
    this.readBinding = dependencies.readBinding ?? readSupabaseDatabaseProviderBinding;
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: { operation: string; request: SupabaseBackupCreateRequest }): Promise<DatabaseBackupCreateReceipt> {
    if (input.operation !== 'database.backup.create') {
      throw new ForbiddenError('Supabase backup authority cannot execute restore, migration, or provider operations', {
        requiredCapability: 'database.backup.create',
      });
    }
    return this.createBackup(input.request);
  }

  async createBackup(rawRequest: SupabaseBackupCreateRequest): Promise<DatabaseBackupCreateReceipt> {
    const request = SupabaseBackupCreateRequestSchema.parse(rawRequest);
    const now = this.now();
    const subjectHash = databaseBackupCreateSubjectHash(request);
    assertGrant(request.authorityGrant, 'database.backup.create', 'elevated', request.source, subjectHash);
    const binding = await this.readBinding(request.source.bindingId);
    assertBinding(binding, request.source, 'database.backup.create');
    const reference = binding.secretReferences[0];
    const source = sourceIdentity(binding);
    const operationInput: DatabaseAuthorityOperationStart = {
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      workspaceId: binding.workspaceId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      capability: 'database.backup.create',
      authorityGrantId: request.authorityGrant.grantId,
      grantRiskClass: request.authorityGrant.riskClass,
      requestHash: subjectHash,
      artifactId: request.artifactId,
    };
    let operation = await this.store.resume(operationInput);
    const resumedReceipt = operation
      ? receiptFromSnapshot(operation, DatabaseBackupCreateReceiptSchema)
      : null;
    if (resumedReceipt) return resumedReceipt;

    let connectionString: string | null = null;
    if (!operation) {
      if (new Date(request.authorityGrant.expiresAt).getTime() <= now.getTime()) {
        throw authorityFailure('grant_expired');
      }
      connectionString = await resolveConnection(
        this.dependencies.secretStore,
        reference.referenceId,
        reference.fingerprint,
        binding.databaseIdentity.endpointFingerprint,
      );
      operation = await this.store.start(operationInput);
      const settledReceipt = receiptFromSnapshot(operation, DatabaseBackupCreateReceiptSchema);
      if (settledReceipt) return settledReceipt;
    }

    const reconciliationInput = {
      operationId: request.operationId,
      artifactId: request.artifactId,
      storageProviderId: request.storageProviderId,
      storageLocationReference: request.storageLocationReference,
    };
    if (!operation.created) {
      let recovered: BackupReconciliation;
      try {
        recovered = await this.dependencies.provider.reconcileBackup(reconciliationInput);
      } catch {
        return markCleanup(this.store, request.operationId, 'database.backup.create', 'provider_reconciliation_failed', now);
      }
      if (recovered.state === 'complete') {
        try {
          return await this.settle(request, binding, buildArtifact(request, binding, recovered.evidence, now), now);
        } catch {
          return markCleanup(this.store, request.operationId, 'database.backup.create', 'reconciled_artifact_or_settlement_failed', now);
        }
      }
      if (recovered.state === 'cleanup-required') {
        return markCleanup(this.store, request.operationId, 'database.backup.create', recovered.reason, now, recovered.providerStateReference);
      }
    }

    connectionString ??= await resolveConnection(
      this.dependencies.secretStore,
      reference.referenceId,
      reference.fingerprint,
      binding.databaseIdentity.endpointFingerprint,
    );
    try {
      const evidence = await this.dependencies.provider.createEncryptedBackup({
        operationId: request.operationId,
        sourceConnectionString: connectionString,
        sourceIdentityHash: source.sourceIdentityHash,
        artifactId: request.artifactId,
        storageProviderId: request.storageProviderId,
        storageLocationReference: request.storageLocationReference,
        encryption: request.encryption,
      });
      return await this.settle(request, binding, buildArtifact(request, binding, evidence, now), now);
    } catch {
      let recovered: BackupReconciliation;
      try {
        recovered = await this.dependencies.provider.reconcileBackup(reconciliationInput);
      } catch {
        return markCleanup(this.store, request.operationId, 'database.backup.create', 'provider_reconciliation_failed', now);
      }
      if (recovered.state === 'complete') {
        try {
          return await this.settle(request, binding, buildArtifact(request, binding, recovered.evidence, now), now);
        } catch {
          return markCleanup(this.store, request.operationId, 'database.backup.create', 'receipt_settlement_failed', now);
        }
      }
      const reason = recovered.state === 'cleanup-required' ? recovered.reason : 'provider_outcome_unconfirmed';
      const providerStateReference = recovered.state === 'cleanup-required' ? recovered.providerStateReference : undefined;
      return markCleanup(this.store, request.operationId, 'database.backup.create', reason, now, providerStateReference);
    }
  }

  private settle(
    request: SupabaseBackupCreateRequest,
    binding: SupabaseDatabaseProviderBinding,
    artifact: DatabaseBackupArtifactRecord,
    now: Date,
  ): Promise<DatabaseBackupCreateReceipt> {
    const receipt = DatabaseBackupCreateReceiptSchema.parse({
      receiptId: request.operationId,
      capability: 'database.backup.create',
      operationId: request.operationId,
      requestHash: databaseBackupCreateSubjectHash(request),
      resultHash: digest(artifact),
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workspaceId: binding.workspaceId,
      authorityGrantId: request.authorityGrant.grantId,
      grantRiskClass: request.authorityGrant.riskClass,
      sourceIdentityHash: artifact.source.sourceIdentityHash,
      sourceConnectionReference: {
        referenceId: binding.secretReferences[0].referenceId,
        fingerprint: binding.secretReferences[0].fingerprint,
      },
      artifact,
      settledAt: now.toISOString(),
    });
    return this.store.settleBackup(receipt);
  }
}

export interface SupabaseRestoreAdapterDependencies {
  secretStore: DatabaseAuthoritySecretStore;
  provider: SupabaseRestoreProvider;
  operationStore?: DatabaseBackupRestoreOperationStore;
  readBinding?: BindingReader;
  now?: () => Date;
}

export class SupabaseDatabaseRestoreAuthorityProviderAdapter {
  readonly capabilities = Object.freeze(['database.backup.restore'] as const satisfies readonly DatabaseAuthorityCapability[]);
  private readonly store: DatabaseBackupRestoreOperationStore;
  private readonly readBinding: BindingReader;
  private readonly now: () => Date;

  constructor(private readonly dependencies: SupabaseRestoreAdapterDependencies) {
    this.store = dependencies.operationStore ?? databaseBackupRestoreOperationStore;
    this.readBinding = dependencies.readBinding ?? readSupabaseDatabaseProviderBinding;
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: { operation: string; request: SupabaseBackupRestoreRequest }): Promise<DatabaseBackupRestoreOperationReceipt> {
    if (input.operation !== 'database.backup.restore') {
      throw new ForbiddenError('Supabase restore authority cannot execute inspection, backup, migration, or provider operations', {
        requiredCapability: 'database.backup.restore',
      });
    }
    return this.restoreBackup(input.request);
  }

  async restoreBackup(rawRequest: SupabaseBackupRestoreRequest): Promise<DatabaseBackupRestoreOperationReceipt> {
    const request = SupabaseBackupRestoreRequestSchema.parse(rawRequest);
    const now = this.now();
    const subjectHash = databaseBackupRestoreSubjectHash(request);
    assertGrant(request.authorityGrant, 'database.backup.restore', 'high', request.source, subjectHash);
    if (request.target.environment !== 'scratch') throw authorityFailure('production_restore_policy_unavailable');
    if (request.target.targetIdentityHash !== restoreTargetIdentityHash(request.target)) throw authorityFailure('target_identity_hash_invalid');

    const binding = await this.readBinding(request.source.bindingId);
    assertBinding(binding, request.source, 'database.backup.restore');
    const artifact = await this.store.loadBackupArtifact(request.artifactId);
    if (!artifact) throw authorityFailure('backup_artifact_not_found');
    if (artifact.recordHash !== request.expectedArtifactHash) throw authorityFailure('backup_artifact_hash_mismatch');
    if (artifact.source.bindingId !== binding.bindingId
        || artifact.source.bindingGeneration !== binding.bindingGeneration
        || artifact.source.workspaceId !== binding.workspaceId) {
      throw authorityFailure('backup_artifact_scope_mismatch');
    }
    if (!artifact.verification.verified || !artifact.encryption.encrypted) throw authorityFailure('backup_artifact_unverified');
    if (new Date(artifact.retention.retainUntil).getTime() <= now.getTime()) throw authorityFailure('backup_artifact_stale');
    if (artifact.source.databaseIdentityHash === databaseResourceIdentityHash(request.target.databaseIdentity)) {
      throw authorityFailure('source_equal_target');
    }

    const operationInput: DatabaseAuthorityOperationStart = {
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      workspaceId: binding.workspaceId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      capability: 'database.backup.restore',
      authorityGrantId: request.authorityGrant.grantId,
      grantRiskClass: request.authorityGrant.riskClass,
      requestHash: subjectHash,
      artifactId: artifact.artifactId,
      targetIdentityHash: request.target.targetIdentityHash,
    };
    let operation = await this.store.resume(operationInput);
    const resumedReceipt = operation
      ? receiptFromSnapshot(operation, DatabaseBackupRestoreReceiptSchema)
      : null;
    if (resumedReceipt) return resumedReceipt;

    if (!operation) {
      if (new Date(request.authorityGrant.expiresAt).getTime() <= now.getTime()) {
        throw authorityFailure('grant_expired');
      }
      if (new Date(request.target.verifiedAt).getTime() > now.getTime()
          || new Date(request.target.verificationExpiresAt).getTime() <= now.getTime()) {
        throw authorityFailure('target_verification_stale');
      }
    }

    const targetConnection = await resolveConnection(
      this.dependencies.secretStore,
      request.target.connectionReferenceId,
      request.target.connectionFingerprint,
      request.target.databaseIdentity.endpointFingerprint,
    );
    const inspectedTarget = RestoreTargetInspectionSchema.parse(await this.dependencies.provider.inspectTarget(targetConnection));
    if (inspectedTarget.projectRef !== request.target.projectRef
        || inspectedTarget.environment !== request.target.environment
        || canonicalJson(inspectedTarget.databaseIdentity) !== canonicalJson(request.target.databaseIdentity)) {
      throw authorityFailure('connected_target_mismatch');
    }
    if (!operation) {
      if (!inspectedTarget.empty) throw authorityFailure('target_not_empty');
      operation = await this.store.start(operationInput);
      const settledReceipt = receiptFromSnapshot(operation, DatabaseBackupRestoreReceiptSchema);
      if (settledReceipt) return settledReceipt;
    }

    const checkIds = request.expectedDataChecks.map((check) => check.checkId);
    if (!operation.created) {
      let recovered: RestoreReconciliation;
      try {
        recovered = await this.dependencies.provider.reconcileRestore({
          operationId: request.operationId,
          artifact,
          targetConnectionString: targetConnection,
          checkIds,
        });
      } catch {
        return markCleanup(this.store, request.operationId, 'database.backup.restore', 'provider_reconciliation_failed', now);
      }
      if (recovered.state === 'complete') {
        try {
          const verification = assertRestoreVerification(artifact, request.expectedDataChecks, recovered.verification);
          return await this.settle(request, binding, artifact, verification, now);
        } catch {
          return markCleanup(this.store, request.operationId, 'database.backup.restore', 'restore_verification_or_settlement_failed', now);
        }
      }
      if (recovered.state === 'cleanup-required') {
        return markCleanup(this.store, request.operationId, 'database.backup.restore', recovered.reason, now, recovered.providerStateReference);
      }
      if (!inspectedTarget.empty) {
        return markCleanup(this.store, request.operationId, 'database.backup.restore', 'provider_outcome_unconfirmed', now);
      }
    }

    try {
      await this.dependencies.provider.restoreEncryptedBackup({
        operationId: request.operationId,
        artifact,
        targetConnectionString: targetConnection,
      });
      const verification = assertRestoreVerification(
        artifact,
        request.expectedDataChecks,
        await this.dependencies.provider.verifyRestore({
          operationId: request.operationId,
          artifact,
          targetConnectionString: targetConnection,
          checkIds,
        }),
      );
      return await this.settle(request, binding, artifact, verification, now);
    } catch {
      let recovered: RestoreReconciliation;
      try {
        recovered = await this.dependencies.provider.reconcileRestore({
          operationId: request.operationId,
          artifact,
          targetConnectionString: targetConnection,
          checkIds,
        });
      } catch {
        return markCleanup(this.store, request.operationId, 'database.backup.restore', 'provider_reconciliation_failed', now);
      }
      if (recovered.state === 'complete') {
        try {
          const verification = assertRestoreVerification(artifact, request.expectedDataChecks, recovered.verification);
          return await this.settle(request, binding, artifact, verification, now);
        } catch {
          return markCleanup(this.store, request.operationId, 'database.backup.restore', 'restore_verification_or_settlement_failed', now);
        }
      }
      const reason = recovered.state === 'cleanup-required' ? recovered.reason : 'provider_outcome_unconfirmed';
      const providerStateReference = recovered.state === 'cleanup-required' ? recovered.providerStateReference : undefined;
      return markCleanup(this.store, request.operationId, 'database.backup.restore', reason, now, providerStateReference);
    }
  }

  private settle(
    request: SupabaseBackupRestoreRequest,
    binding: SupabaseDatabaseProviderBinding,
    artifact: DatabaseBackupArtifactRecord,
    verification: RestoreVerificationEvidence,
    now: Date,
  ): Promise<DatabaseBackupRestoreOperationReceipt> {
    const resultHash = digest({ artifactId: artifact.artifactId, targetIdentityHash: request.target.targetIdentityHash, verification });
    const receipt = DatabaseBackupRestoreReceiptSchema.parse({
      receiptId: request.operationId,
      capability: 'database.backup.restore',
      operationId: request.operationId,
      requestHash: databaseBackupRestoreSubjectHash(request),
      resultHash,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      workspaceId: binding.workspaceId,
      authorityGrantId: request.authorityGrant.grantId,
      grantRiskClass: request.authorityGrant.riskClass,
      artifactId: artifact.artifactId,
      artifactContentHash: artifact.contentHash,
      targetIdentityHash: request.target.targetIdentityHash,
      targetConnectionReference: {
        referenceId: request.target.connectionReferenceId,
        fingerprint: request.target.connectionFingerprint,
      },
      verification,
      settledAt: now.toISOString(),
    });
    return this.store.settleRestore(receipt);
  }
}

interface OperationRow {
  id: string;
  workspace_id: string;
  binding_id: string;
  binding_generation: string | number;
  capability: string;
  authority_grant_id: string;
  idempotency_key: string;
  request_hash: string;
  artifact_id: string;
  target_identity_hash: string | null;
  state: string;
  result_record: unknown;
  cleanup_evidence: unknown;
}
interface GrantRow {
  id: string;
  workspace_id: string;
  binding_id: string;
  binding_generation: string | number;
  capability: string;
  risk_class: string;
  subject_hash: string;
  unexpired: boolean;
  consumed_by_operation_id: string | null;
  revoked_at: Date | null;
}

interface ArtifactRow { artifact_record: unknown }

function operationSnapshot(
  row: OperationRow,
  created: boolean,
): DatabaseAuthorityOperationSnapshot {
  const cleanup = row.cleanup_evidence && typeof row.cleanup_evidence === 'object'
    ? row.cleanup_evidence as Record<string, unknown>
    : undefined;
  return {
    operationId: row.id,
    created,
    state: row.state === 'cleanup_required' ? 'cleanup-required' : row.state as 'started' | 'succeeded',
    requestHash: row.request_hash as `sha256:${string}`,
    ...(row.result_record ? { result: row.result_record as DatabaseBackupRestoreReceipt } : {}),
    ...(typeof cleanup?.reason === 'string' ? { cleanupReason: cleanup.reason } : {}),
  };
}

function assertOperationMatches(row: OperationRow, input: DatabaseAuthorityOperationStart): void {
  if (row.id !== input.operationId
      || row.workspace_id !== input.workspaceId
      || row.binding_id !== input.bindingId
      || Number(row.binding_generation) !== input.bindingGeneration
      || row.capability !== input.capability
      || row.authority_grant_id !== input.authorityGrantId
      || row.idempotency_key !== input.idempotencyKey
      || row.request_hash !== input.requestHash
      || row.artifact_id !== input.artifactId
      || row.target_identity_hash !== (input.targetIdentityHash ?? null)) {
    throw new ConflictError('Database backup operation identity is already bound to another authority request');
  }
}

async function resumeDatabaseOperation(
  input: DatabaseAuthorityOperationStart,
): Promise<DatabaseAuthorityOperationSnapshot | null> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<OperationRow>(
      `SELECT id, workspace_id, binding_id, binding_generation, capability, authority_grant_id,
              idempotency_key, request_hash, artifact_id, target_identity_hash, state,
              result_record, cleanup_evidence
         FROM rorca.database_backup_restore_operations
        WHERE id=$1 OR (workspace_id=$2 AND capability=$3 AND idempotency_key=$4)
        ORDER BY (id=$1) DESC
        LIMIT 1`,
      [input.operationId, input.workspaceId, input.capability, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) return null;
    assertOperationMatches(row, input);
    return operationSnapshot(row, false);
  });
}
async function startDatabaseOperation(input: DatabaseAuthorityOperationStart): Promise<DatabaseAuthorityOperationSnapshot> {
  return runtimeTransaction(async (client) => {
    const grantResult = await client.query<GrantRow>(
      `SELECT id, workspace_id, binding_id, binding_generation, capability, risk_class,
              subject_hash, expires_at > clock_timestamp() AS unexpired,
              consumed_by_operation_id, revoked_at
         FROM rorca.database_authority_operation_grants
        WHERE id=$1
        FOR UPDATE`,
      [input.authorityGrantId],
    );
    const grant = grantResult.rows[0];
    if (!grant
        || grant.workspace_id !== input.workspaceId
        || grant.binding_id !== input.bindingId
        || Number(grant.binding_generation) !== input.bindingGeneration
        || grant.capability !== input.capability
        || grant.risk_class !== input.grantRiskClass
        || grant.subject_hash !== input.requestHash
        || !grant.unexpired
        || grant.revoked_at
        || (grant.consumed_by_operation_id !== null && grant.consumed_by_operation_id !== input.operationId)) {
      throw new ForbiddenError('Exact unexpired database authority grant is required', {
        reason: 'authority_grant_unauthorized',
      });
    }

    const inserted = await client.query(
      `INSERT INTO rorca.database_backup_restore_operations (
         id, workspace_id, binding_id, binding_generation, capability, authority_grant_id,
         idempotency_key, request_hash, artifact_id, target_identity_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [input.operationId, input.workspaceId, input.bindingId, input.bindingGeneration, input.capability,
        input.authorityGrantId, input.idempotencyKey, input.requestHash, input.artifactId,
        input.targetIdentityHash ?? null],
    );
    const result = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, cleanup_evidence
         FROM rorca.database_backup_restore_operations
        WHERE id=$1 OR (workspace_id=$2 AND capability=$3 AND idempotency_key=$4)
        ORDER BY (id=$1) DESC
        LIMIT 1
        FOR UPDATE`,
      [input.operationId, input.workspaceId, input.capability, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row || row.id !== input.operationId || row.request_hash !== input.requestHash) {
      throw new ConflictError('Database backup idempotency key is already bound to another request');
    }
    if (inserted.rowCount === 1) {
      const consumed = await client.query(
        `UPDATE rorca.database_authority_operation_grants
            SET consumed_by_operation_id=$2, consumed_at=clock_timestamp()
          WHERE id=$1 AND consumed_by_operation_id IS NULL AND revoked_at IS NULL
            AND expires_at > clock_timestamp()`,
        [input.authorityGrantId, input.operationId],
      );
      if (consumed.rowCount !== 1) {
        throw new ForbiddenError('Database authority grant could not be consumed exactly once', {
          reason: 'authority_grant_consumption_failed',
        });
      }
    }
    const cleanup = row.cleanup_evidence && typeof row.cleanup_evidence === 'object'
      ? row.cleanup_evidence as Record<string, unknown>
      : undefined;
    return {
      operationId: row.id,
      created: inserted.rowCount === 1,
      state: row.state === 'cleanup_required' ? 'cleanup-required' : row.state as 'started' | 'succeeded',
      requestHash: row.request_hash as `sha256:${string}`,
      ...(row.result_record ? { result: row.result_record as DatabaseBackupRestoreReceipt } : {}),
      ...(typeof cleanup?.reason === 'string' ? { cleanupReason: cleanup.reason } : {}),
    };
  });
}

async function loadDatabaseBackupArtifact(artifactId: string): Promise<DatabaseBackupArtifactRecord | null> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<ArtifactRow>(
      'SELECT artifact_record FROM rorca.database_backup_artifacts WHERE id=$1',
      [artifactId],
    );
    return result.rows[0] ? DatabaseBackupArtifactRecordSchema.parse(result.rows[0].artifact_record) : null;
  });
}

async function settleDatabaseReceipt<T extends DatabaseBackupRestoreReceipt>(
  receipt: T,
  schema: z.ZodType<T>,
): Promise<T> {
  return runtimeTransaction(async (client) => {
    const operationResult = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, cleanup_evidence
         FROM rorca.database_backup_restore_operations WHERE id=$1 FOR UPDATE`,
      [receipt.operationId],
    );
    const operation = operationResult.rows[0];
    if (!operation || operation.request_hash !== receipt.requestHash) throw new ConflictError('Database backup operation subject changed');
    if (operation.state === 'cleanup_required') throw new ConflictError('Cleanup-required database backup operation cannot be settled');
    if (operation.state === 'succeeded') return schema.parse(operation.result_record);

    if (receipt.capability === 'database.backup.create') {
      const artifact = receipt.artifact;
      await client.query(
        `INSERT INTO rorca.database_backup_artifacts (
           id, workspace_id, source_binding_id, source_binding_generation, source_identity,
           source_identity_hash, source_database_identity_hash, provider_artifact_reference,
           storage_provider_id, storage_location_reference, content_hash, byte_length,
           schema_hash, database_version, encryption_provenance, retention, verification,
           artifact_record, record_hash, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [artifact.artifactId, artifact.source.workspaceId, artifact.source.bindingId,
          artifact.source.bindingGeneration, artifact.source, artifact.source.sourceIdentityHash,
          artifact.source.databaseIdentityHash, artifact.providerArtifactReference,
          artifact.storageProviderId, artifact.storageLocationReference, artifact.contentHash,
          artifact.byteLength, artifact.schemaHash, artifact.databaseVersion, artifact.encryption,
          artifact.retention, artifact.verification, artifact, artifact.recordHash, artifact.createdAt],
      );
    }

    const reference = receipt.capability === 'database.backup.create'
      ? receipt.sourceConnectionReference
      : receipt.targetConnectionReference;
    await client.query(
      `INSERT INTO rorca.authority_operation_receipts (
         id, workspace_id, binding_id, provider_id, capability, binding_generation,
         request_hash, target_identity_hash, result_hash, secret_reference_id,
         secret_reference_fingerprint, redacted_evidence
       ) VALUES ($1,$2,$3,'supabase-database',$4,$5,$6,$7,$8,$9,$10,$11)`,
      [receipt.receiptId, receipt.workspaceId, receipt.bindingId, receipt.capability,
        receipt.bindingGeneration, receipt.requestHash,
        receipt.capability === 'database.backup.create' ? receipt.sourceIdentityHash : receipt.targetIdentityHash,
        receipt.resultHash, reference.referenceId, reference.fingerprint, receipt],
    );
    await client.query(
      `UPDATE rorca.database_backup_restore_operations
          SET state='succeeded', receipt_id=$2, result_record=$3, settled_at=$4
        WHERE id=$1 AND state='started'`,
      [receipt.operationId, receipt.receiptId, receipt, receipt.settledAt],
    );
    return receipt;
  });
}

async function markDatabaseOperationCleanupRequired(evidence: CleanupRequiredEvidence): Promise<void> {
  await runtimeTransaction(async (client) => {
    const result = await client.query(
      `UPDATE rorca.database_backup_restore_operations
          SET state='cleanup_required', cleanup_evidence=$2, settled_at=$3
        WHERE id=$1 AND state='started'`,
      [evidence.operationId, evidence, evidence.recordedAt],
    );
    if (result.rowCount !== 1) {
      const existing = await client.query<OperationRow>(
        'SELECT id, state, request_hash, result_record, cleanup_evidence FROM rorca.database_backup_restore_operations WHERE id=$1',
        [evidence.operationId],
      );
      if (existing.rows[0]?.state !== 'cleanup_required') {
        throw new ConflictError('Database backup operation cannot transition to cleanup-required');
      }
    }
  });
}

export const databaseBackupRestoreOperationStore: DatabaseBackupRestoreOperationStore = {
  start: startDatabaseOperation,
  resume: resumeDatabaseOperation,
  loadBackupArtifact: loadDatabaseBackupArtifact,
  settleBackup: (receipt) => settleDatabaseReceipt(receipt, DatabaseBackupCreateReceiptSchema),
  settleRestore: (receipt) => settleDatabaseReceipt(receipt, DatabaseBackupRestoreReceiptSchema),
  markCleanupRequired: markDatabaseOperationCleanupRequired,
};
