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
  DatabaseBackupArtifactRecordSchema,
  databaseBackupSourceIdentityHash,
  databaseBackupRestoreOperationStore,
  type DatabaseBackupArtifactRecord,
  type DatabaseBackupRestoreOperationStore,
} from './supabase-database-backup-authority-provider-adapter';
import {
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  readSupabaseDatabaseProviderBinding,
  supabaseDatabaseTargetIdentityHash,
  type DatabaseAuthorityCapability,
  type DatabaseAuthoritySecretStore,
  type SupabaseDatabaseProviderBinding,
} from './supabase-database-authority-provider-adapter';
import {
  MigrationVerificationEvidenceSchema,
  PostgresSupabaseStagingMigrationProvider,
  StagingMigrationManifestSchema,
  StagingMigrationStatementError,
  assertStagingMigrationManifest,
  type MigrationStatement,
  type MigrationStatementOutcome,
  type MigrationVerificationEvidence,
  type MigrationVerificationQuery,
  type StagingMigrationManifestEntry,
  type SupabaseStagingMigrationProvider,
} from './supabase-database-migration-authority-provider-adapter';

const Sha256Schema = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
);
const IdentifierSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const ReferenceSchema = z.string().min(1).max(2048).refine((value) => {
  if (!/^[a-z][a-z0-9+.-]{1,31}:\/\/\S+$/i.test(value)) return false;
  if (/^postgres(?:ql)?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, { message: 'Expected an opaque credential-free reference' });

function normalizeCanonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCanonicalValue(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

const ProductionTargetCoreSchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(1).max(255),
  environment: z.literal('production'),
  databaseIdentity: z.object({
    databaseName: z.string().min(1).max(63),
    endpointFingerprint: Sha256Schema,
  }).strict(),
  bindingGeneration: z.number().int().positive(),
}).strict();

export const ProductionMigrationTargetSchema = ProductionTargetCoreSchema.extend({
  targetDigest: Sha256Schema,
}).strict();
export type ProductionMigrationTarget = z.infer<typeof ProductionMigrationTargetSchema>;

const ChangeWindowCoreSchema = z.object({
  windowId: z.string().uuid(),
  opensAt: z.string().datetime({ offset: true }),
  closesAt: z.string().datetime({ offset: true }),
}).strict();

export const ProductionMigrationChangeWindowSchema = ChangeWindowCoreSchema.extend({
  windowDigest: Sha256Schema,
}).strict();
export type ProductionMigrationChangeWindow = z.infer<typeof ProductionMigrationChangeWindowSchema>;

const EvidenceItemSchema = z.object({
  evidenceDigest: Sha256Schema,
  evidenceReference: ReferenceSchema,
  verified: z.literal(true),
  verifiedAt: z.string().datetime({ offset: true }),
}).strict();

const HealthAbortEvidenceSchema = z.object({
  manifestDigest: Sha256Schema,
  targetDigest: Sha256Schema,
  health: EvidenceItemSchema,
  abort: EvidenceItemSchema,
}).strict();
export type ProductionHealthAbortEvidence = z.infer<typeof HealthAbortEvidenceSchema>;

const RecoveryOwnerSchema = z.object({
  ownerId: IdentifierSchema,
  authorityHash: Sha256Schema,
  acknowledgementDigest: Sha256Schema,
  acknowledgedAt: z.string().datetime({ offset: true }),
}).strict();
export type ProductionRecoveryOwner = z.infer<typeof RecoveryOwnerSchema>;

const ProductionRecoveryProcedureSchema = z.object({
  migrationId: IdentifierSchema,
  classification: z.enum(['reversible', 'forward-only']),
  strategy: z.enum(['rollback', 'forward-fix', 'restore']),
  evidenceReference: ReferenceSchema,
}).strict();

const RecoveryPlanCoreSchema = z.object({
  planId: z.string().uuid(),
  manifestDigest: Sha256Schema,
  backupRecordHash: Sha256Schema,
  verified: z.literal(true),
  verifiedAt: z.string().datetime({ offset: true }),
  verificationReference: ReferenceSchema,
  restorePolicyReference: ReferenceSchema,
  procedures: z.array(ProductionRecoveryProcedureSchema).min(1).max(10_000),
}).strict();

export const ProductionMigrationRecoveryPlanSchema = RecoveryPlanCoreSchema.extend({
  planDigest: Sha256Schema,
}).strict();
export type ProductionMigrationRecoveryPlan = z.infer<typeof ProductionMigrationRecoveryPlanSchema>;

const NoExternalGateSchema = z.object({
  required: z.literal(false),
  policyDigest: Sha256Schema,
}).strict();

const IndependentExternalGateSchema = z.object({
  required: z.literal(true),
  gateId: z.string().uuid(),
  policyDigest: Sha256Schema,
  approvalDigest: Sha256Schema,
  approverAuthorityHash: Sha256Schema,
  evidenceReference: ReferenceSchema,
  approvedAt: z.string().datetime({ offset: true }),
  approvalExpiresAt: z.string().datetime({ offset: true }),
}).strict();

export const ProductionMigrationExternalGateSchema = z.discriminatedUnion('required', [
  NoExternalGateSchema,
  IndependentExternalGateSchema,
]);
export type ProductionMigrationExternalGate = z.infer<typeof ProductionMigrationExternalGateSchema>;

const ProductionMigrationGrantSchema = z.object({
  grantId: z.string().uuid(),
  capability: z.literal('database.migration.apply.production'),
  riskClass: z.literal('critical'),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  subjectHash: Sha256Schema,
  issuerAuthorityHash: Sha256Schema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const SupabaseProductionMigrationSubjectSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(255),
  target: ProductionMigrationTargetSchema,
  manifest: StagingMigrationManifestSchema,
  manifestDigest: Sha256Schema,
  backup: DatabaseBackupArtifactRecordSchema,
  changeWindow: ProductionMigrationChangeWindowSchema,
  healthAbortEvidence: HealthAbortEvidenceSchema,
  recoveryOwner: RecoveryOwnerSchema,
  recoveryPlan: ProductionMigrationRecoveryPlanSchema,
  externalGate: ProductionMigrationExternalGateSchema,
}).strict();
export type SupabaseProductionMigrationSubject = z.infer<typeof SupabaseProductionMigrationSubjectSchema>;

export const SupabaseProductionMigrationRequestSchema = SupabaseProductionMigrationSubjectSchema.extend({
  authorityGrant: ProductionMigrationGrantSchema,
}).strict();
export type SupabaseProductionMigrationRequest = z.infer<typeof SupabaseProductionMigrationRequestSchema>;

const StatementOutcomeSchema = z.object({
  migrationId: IdentifierSchema,
  statementId: IdentifierSchema,
  contentHash: Sha256Schema,
  phase: z.enum(['apply', 'rollback', 'forward-fix']),
  outcome: z.enum(['applied', 'failed', 'rolled-back', 'reconciled-applied']),
  errorCode: IdentifierSchema.optional(),
}).strict();

const MigrationReceiptEntrySchema = z.object({
  migrationId: IdentifierSchema,
  contentHash: Sha256Schema,
  ordinal: z.number().int().nonnegative(),
  transactionMode: z.enum(['transactional', 'non-transactional']),
  statementOutcomes: z.array(StatementOutcomeSchema),
  verification: MigrationVerificationEvidenceSchema.nullable(),
}).strict();
export type ProductionMigrationReceiptEntry = z.infer<typeof MigrationReceiptEntrySchema>;

const ProductionRestoreOutcomeSchema = z.object({
  backupArtifactId: z.string().uuid(),
  backupRecordHash: Sha256Schema,
  procedureReference: ReferenceSchema,
  restorePolicyReference: ReferenceSchema,
  outcome: z.literal('restored'),
  providerEvidenceReference: ReferenceSchema,
}).strict();
export type ProductionRestoreOutcome = z.infer<typeof ProductionRestoreOutcomeSchema>;

const ProductionAbortProofSchema = z.object({
  trigger: z.enum(['apply-failure', 'uncertain-outcome', 'health-abort', 'window-closed']),
  classification: z.enum(['reversible', 'forward-only']),
  strategy: z.enum(['rollback', 'forward-fix', 'restore']),
  failedMigrationId: IdentifierSchema,
  priorSchemaHash: Sha256Schema,
  resultingSchemaHash: Sha256Schema,
  statementOutcomes: z.array(StatementOutcomeSchema),
  restoreOutcome: ProductionRestoreOutcomeSchema.optional(),
  verification: MigrationVerificationEvidenceSchema,
  procedureEvidenceReference: ReferenceSchema,
}).strict();
export type ProductionMigrationAbortProof = z.infer<typeof ProductionAbortProofSchema>;

const ExternalGateSettlementSchema = ProductionMigrationExternalGateSchema;

const ProductionConsistencySchema = z.object({
  verified: z.literal(true),
  schemaHash: Sha256Schema,
  migrationHistoryDigest: Sha256Schema,
  historyLength: z.number().int().nonnegative(),
  verifiedAt: z.string().datetime({ offset: true }),
}).strict();

export const SupabaseProductionMigrationReceiptSchema = z.object({
  version: z.literal('rorca.production-migration-receipt.v1'),
  receiptId: z.string().uuid(),
  capability: z.literal('database.migration.apply.production'),
  operationId: z.string().uuid(),
  requestHash: Sha256Schema,
  resultHash: Sha256Schema,
  authorityGrantId: z.string().uuid(),
  manifestId: z.string().uuid(),
  manifestDigest: Sha256Schema,
  target: ProductionMigrationTargetSchema.extend({
    targetIdentityHash: Sha256Schema,
    databaseIdentityHash: Sha256Schema,
    connectionReference: z.object({ referenceId: ReferenceSchema, fingerprint: Sha256Schema }).strict(),
  }).strict(),
  backup: z.object({
    artifactId: z.string().uuid(),
    recordHash: Sha256Schema,
    contentHash: Sha256Schema,
    schemaHash: Sha256Schema,
  }).strict(),
  changeWindow: ProductionMigrationChangeWindowSchema,
  healthAbortEvidence: HealthAbortEvidenceSchema,
  recoveryOwner: RecoveryOwnerSchema,
  recoveryPlanDigest: Sha256Schema,
  evidenceDigest: Sha256Schema,
  recoveryOwnerDigest: Sha256Schema,
  externalGateDigest: Sha256Schema,
  externalGate: ExternalGateSettlementSchema,
  beforeSchemaHash: Sha256Schema,
  afterSchemaHash: Sha256Schema,
  status: z.enum(['succeeded', 'aborted']),
  migrations: z.array(MigrationReceiptEntrySchema),
  abortProof: ProductionAbortProofSchema.nullable(),
  finalConsistency: ProductionConsistencySchema,
  settledAt: z.string().datetime({ offset: true }),
}).strict();
export type SupabaseProductionMigrationReceipt = z.infer<typeof SupabaseProductionMigrationReceiptSchema>;

export const SupabaseProductionMigrationWaitingSchema = z.object({
  version: z.literal('rorca.production-migration-waiting.v1'),
  capability: z.literal('database.migration.apply.production'),
  operationId: z.string().uuid(),
  authorityGrantId: z.string().uuid(),
  requestHash: Sha256Schema,
  status: z.literal('waiting'),
  reason: z.literal('external_gate_pending'),
  gateId: z.string().uuid(),
  approvalDigest: Sha256Schema,
  waitingSince: z.string().datetime({ offset: true }),
}).strict();
export type SupabaseProductionMigrationWaiting = z.infer<typeof SupabaseProductionMigrationWaitingSchema>;
export type SupabaseProductionMigrationResult = SupabaseProductionMigrationReceipt | SupabaseProductionMigrationWaiting;

export function productionMigrationTargetDigest(
  target: Omit<ProductionMigrationTarget, 'targetDigest'> | ProductionMigrationTarget,
): `sha256:${string}` {
  const { targetDigest: _targetDigest, ...core } = target as ProductionMigrationTarget;
  return digest(core);
}

export function productionMigrationWindowDigest(
  window: Omit<ProductionMigrationChangeWindow, 'windowDigest'> | ProductionMigrationChangeWindow,
): `sha256:${string}` {
  const { windowDigest: _windowDigest, ...core } = window as ProductionMigrationChangeWindow;
  return digest(core);
}

export function productionMigrationRecoveryPlanDigest(
  plan: Omit<ProductionMigrationRecoveryPlan, 'planDigest'> | ProductionMigrationRecoveryPlan,
): `sha256:${string}` {
  const { planDigest: _planDigest, ...core } = plan as ProductionMigrationRecoveryPlan;
  return digest(core);
}

export function productionMigrationSubjectHash(
  rawSubject: SupabaseProductionMigrationSubject | SupabaseProductionMigrationRequest,
): `sha256:${string}` {
  if ('authorityGrant' in rawSubject) {
    const { authorityGrant: _authorityGrant, ...subject } = rawSubject;
    return digest(subject);
  }
  return digest(rawSubject);
}

function preflightFailure(reason: string): UnprocessableError {
  return new UnprocessableError(
    'Supabase production migration preflight rejected the request',
    'DATABASE_PRODUCTION_MIGRATION_PREFLIGHT_REJECTED',
    { reason },
  );
}

function recoveryFailure(reason: string, migrationId: string): UnprocessableError {
  return new UnprocessableError(
    'Supabase production migration abort could not prove a consistent database state',
    'DATABASE_PRODUCTION_MIGRATION_ABORT_FAILED',
    { reason, migrationId },
  );
}

function parseRequest(rawRequest: SupabaseProductionMigrationRequest): SupabaseProductionMigrationRequest {
  const parsed = SupabaseProductionMigrationRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    const recoveryIssue = parsed.error.issues.some((issue) => issue.path.includes('recoveryPlan'));
    throw preflightFailure(recoveryIssue ? 'recovery_plan_unverified' : 'request_invalid');
  }
  return parsed.data;
}

function expectedProductionRecoveryStrategy(migration: StagingMigrationManifestEntry): 'rollback' | 'forward-fix' | 'restore' {
  if (migration.recovery.classification === 'reversible') return 'rollback';
  return migration.recovery.procedure.strategy === 'forward-fix' ? 'forward-fix' : 'restore';
}

function assertStaticPreflight(
  request: SupabaseProductionMigrationRequest,
  now: Date,
  allowClosedWindow = false,
): void {
  try {
    assertStagingMigrationManifest(request.manifest, request.manifestDigest);
  } catch (error) {
    const reason = error instanceof UnprocessableError && typeof error.details?.reason === 'string'
      ? error.details.reason
      : 'manifest_invalid';
    throw preflightFailure(reason);
  }
  if (request.target.targetDigest !== productionMigrationTargetDigest(request.target)) {
    throw preflightFailure('target_digest_mismatch');
  }
  if (request.changeWindow.windowDigest !== productionMigrationWindowDigest(request.changeWindow)) {
    throw preflightFailure('change_window_digest_mismatch');
  }
  const opensAt = new Date(request.changeWindow.opensAt).getTime();
  const closesAt = new Date(request.changeWindow.closesAt).getTime();
  if (opensAt >= closesAt
      || (!allowClosedWindow && (now.getTime() < opensAt || now.getTime() >= closesAt))) {
    throw preflightFailure('change_window_closed');
  }
  if (request.backup.source.environment !== 'production'
      || request.backup.source.workspaceId !== request.target.workspaceId
      || request.backup.source.bindingId !== request.target.bindingId
      || request.backup.source.bindingGeneration !== request.target.bindingGeneration
      || request.backup.source.projectRef !== request.target.projectRef
      || !sameCanonicalValue(request.backup.source.databaseIdentity, request.target.databaseIdentity)) {
    throw preflightFailure('backup_target_mismatch');
  }
  if (request.backup.schemaHash !== request.manifest.currentSchemaHash
      || request.backup.verification.verifiedContentHash !== request.backup.contentHash
      || new Date(request.backup.retention.retainUntil).getTime() <= now.getTime()) {
    throw preflightFailure('backup_verification_failed');
  }
  if (request.healthAbortEvidence.manifestDigest !== request.manifestDigest
      || request.healthAbortEvidence.targetDigest !== request.target.targetDigest) {
    throw preflightFailure('health_abort_evidence_mismatch');
  }
  if (new Date(request.healthAbortEvidence.health.verifiedAt).getTime() > now.getTime()
      || new Date(request.healthAbortEvidence.abort.verifiedAt).getTime() > now.getTime()) {
    throw preflightFailure('health_abort_evidence_unverified');
  }
  if (request.recoveryPlan.planDigest !== productionMigrationRecoveryPlanDigest(request.recoveryPlan)
      || request.recoveryPlan.manifestDigest !== request.manifestDigest
      || request.recoveryPlan.backupRecordHash !== request.backup.recordHash
      || new Date(request.recoveryPlan.verifiedAt).getTime() > now.getTime()) {
    throw preflightFailure('recovery_plan_unverified');
  }
  if (request.recoveryPlan.procedures.length !== request.manifest.migrations.length) {
    throw preflightFailure('recovery_plan_unverified');
  }
  for (let index = 0; index < request.manifest.migrations.length; index += 1) {
    const migration = request.manifest.migrations[index];
    const procedure = request.recoveryPlan.procedures[index];
    if (!procedure || procedure.migrationId !== migration.id
        || procedure.classification !== migration.recovery.classification
        || procedure.strategy !== expectedProductionRecoveryStrategy(migration)) {
      throw preflightFailure('recovery_plan_unverified');
    }
    if (migration.recovery.classification === 'forward-only') {
      const backupEvidence = migration.recovery.backupEvidence;
      if (backupEvidence.artifactId !== request.backup.artifactId
          || backupEvidence.contentHash !== request.backup.contentHash
          || backupEvidence.schemaHash !== request.backup.schemaHash) {
        throw preflightFailure('recovery_backup_mismatch');
      }
    }
  }
}

function assertGrant(
  request: SupabaseProductionMigrationRequest,
  now: Date,
  allowExpiredConsumedGrant = false,
): void {
  const grant = request.authorityGrant;
  if (grant.capability !== 'database.migration.apply.production') throw preflightFailure('grant_capability_mismatch');
  if (grant.riskClass !== 'critical') throw preflightFailure('grant_risk_class_mismatch');
  if (grant.workspaceId !== request.target.workspaceId || grant.bindingId !== request.target.bindingId) {
    throw preflightFailure('grant_scope_mismatch');
  }
  if (grant.bindingGeneration !== request.target.bindingGeneration) throw preflightFailure('grant_generation_mismatch');
  if (grant.subjectHash !== productionMigrationSubjectHash(request)) throw preflightFailure('grant_subject_mismatch');
  if (!allowExpiredConsumedGrant && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    throw preflightFailure('grant_expired');
  }
  if (request.externalGate.required
      && request.externalGate.approverAuthorityHash === grant.issuerAuthorityHash) {
    throw preflightFailure('external_gate_not_independent');
  }
}

function assertBinding(
  binding: SupabaseDatabaseProviderBinding | null,
  target: ProductionMigrationTarget,
): asserts binding is SupabaseDatabaseProviderBinding {
  if (!binding) throw preflightFailure('binding_not_found');
  if (binding.providerId !== 'supabase-database') throw preflightFailure('wrong_provider');
  if (binding.bindingId !== target.bindingId) throw preflightFailure('wrong_binding');
  if (binding.workspaceId !== target.workspaceId) throw preflightFailure('wrong_workspace');
  if (binding.projectRef !== target.projectRef) throw preflightFailure('wrong_project');
  if (binding.environment !== 'production' || binding.environment !== target.environment) {
    throw preflightFailure('wrong_environment');
  }
  if (!sameCanonicalValue(binding.databaseIdentity, target.databaseIdentity)) throw preflightFailure('wrong_database');
  if (binding.databaseIdentityHash !== databaseResourceIdentityHash(binding.databaseIdentity)) {
    throw preflightFailure('database_identity_hash_invalid');
  }
  if (binding.bindingGeneration !== target.bindingGeneration) throw preflightFailure('stale_generation');
  if (binding.bindingStatus !== 'active') throw preflightFailure('binding_inactive');
  if (!binding.roleProfile.verified) throw preflightFailure('role_unverified');
  if (binding.roleProfile.authenticationClass !== 'database-role') throw preflightFailure('application_credential_forbidden');
  if (!binding.roleProfile.capabilities.includes('database.migration.apply.production')) {
    throw preflightFailure('capability_missing');
  }
  const reference = binding.secretReferences[0];
  if (!reference || reference.purpose !== 'database-connection') throw preflightFailure('reference_missing');
  if (reference.credentialClass !== 'database-role') throw preflightFailure('application_credential_forbidden');
}

async function resolveConnection(
  secretStore: DatabaseAuthoritySecretStore,
  binding: SupabaseDatabaseProviderBinding,
): Promise<string> {
  const reference = binding.secretReferences[0];
  let connectionString: string | null;
  try {
    connectionString = await secretStore.resolveDatabaseConnection(reference.referenceId);
  } catch {
    throw preflightFailure('reference_unresolved');
  }
  if (!connectionString) throw preflightFailure('reference_unresolved');
  if (databaseCredentialFingerprint(connectionString) !== reference.fingerprint) {
    throw preflightFailure('reference_fingerprint_mismatch');
  }
  if (databaseEndpointFingerprint(connectionString) !== binding.databaseIdentity.endpointFingerprint) {
    throw preflightFailure('wrong_database_endpoint');
  }
  return connectionString;
}

export type ProductionExternalGateDecision =
  | { status: 'waiting' }
  | { status: 'rejected' | 'invalid'; reason: string }
  | {
      status: 'approved';
      gateId: string;
      approvalDigest: `sha256:${string}`;
      approverAuthorityHash: `sha256:${string}`;
      evidenceReference: string;
      approvedAt: string;
    };

export interface ProductionExternalGateVerifier {
  verify(gate: Extract<ProductionMigrationExternalGate, { required: true }>): Promise<ProductionExternalGateDecision>;
}

export interface ProductionMigrationHealthMonitor {
  check(input: {
    operationId: string;
    migrationId: string;
    expectedHealthEvidenceDigest: `sha256:${string}`;
    expectedAbortEvidenceDigest: `sha256:${string}`;
  }): Promise<{ status: 'healthy' } | { status: 'abort'; reasonCode: string }>;
}

export interface ProductionRestoreExecutor {
  restore(input: {
    targetConnectionString: string;
    artifact: DatabaseBackupArtifactRecord;
    procedureReference: string;
    restorePolicyReference: string;
  }): Promise<{ providerEvidenceReference: string }>;
}

export interface SupabaseProductionMigrationSession {
  inspectSchemaHash(): Promise<`sha256:${string}`>;
  executeStatements(input: {
    migrationId: string;
    phase: 'apply' | 'rollback' | 'forward-fix';
    transactionMode: 'transactional' | 'non-transactional';
    statements: MigrationStatement[];
  }): Promise<MigrationStatementOutcome[]>;
  verify(input: {
    queries: MigrationVerificationQuery[];
    expectedSchemaHash: `sha256:${string}`;
  }): Promise<MigrationVerificationEvidence>;
  restoreProduction(input: {
    artifact: DatabaseBackupArtifactRecord;
    procedureReference: string;
    restorePolicyReference: string;
  }): Promise<ProductionRestoreOutcome>;
}

export interface SupabaseProductionMigrationProvider {
  withFencedTarget<T>(input: {
    connectionString: string;
    fenceKey: string;
    binding: SupabaseDatabaseProviderBinding;
    targetIdentityHash: `sha256:${string}`;
  }, operation: (session: SupabaseProductionMigrationSession) => Promise<T>): Promise<T>;
}

export class PostgresSupabaseProductionMigrationProvider implements SupabaseProductionMigrationProvider {
  constructor(
    private readonly restoreExecutor?: ProductionRestoreExecutor,
    private readonly stagingProvider: SupabaseStagingMigrationProvider = new PostgresSupabaseStagingMigrationProvider(),
  ) {}

  async withFencedTarget<T>(input: {
    connectionString: string;
    fenceKey: string;
    binding: SupabaseDatabaseProviderBinding;
    targetIdentityHash: `sha256:${string}`;
  }, operation: (session: SupabaseProductionMigrationSession) => Promise<T>): Promise<T> {
    return this.stagingProvider.withFencedTarget(input, async (session) => operation({
      inspectSchemaHash: () => session.inspectSchemaHash(),
      executeStatements: (statementInput) => session.executeStatements(statementInput),
      verify: (verificationInput) => session.verify(verificationInput),
      restoreProduction: async (restoreInput) => {
        if (!this.restoreExecutor) {
          throw new UnprocessableError(
            'Production restore executor is not configured',
            'DATABASE_PRODUCTION_RESTORE_UNAVAILABLE',
          );
        }
        const evidence = await this.restoreExecutor.restore({
          targetConnectionString: input.connectionString,
          artifact: restoreInput.artifact,
          procedureReference: restoreInput.procedureReference,
          restorePolicyReference: restoreInput.restorePolicyReference,
        });
        return ProductionRestoreOutcomeSchema.parse({
          backupArtifactId: restoreInput.artifact.artifactId,
          backupRecordHash: restoreInput.artifact.recordHash,
          procedureReference: restoreInput.procedureReference,
          restorePolicyReference: restoreInput.restorePolicyReference,
          outcome: 'restored',
          providerEvidenceReference: evidence.providerEvidenceReference,
        });
      },
    }));
  }
}

export interface ProductionMigrationOperationStart {
  operationId: string;
  idempotencyKey: string;
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  authorityGrantId: string;
  issuerAuthorityHash: `sha256:${string}`;
  requestHash: `sha256:${string}`;
  manifestId: string;
  manifestDigest: `sha256:${string}`;
  targetIdentityHash: `sha256:${string}`;
  targetDigest: `sha256:${string}`;
  backupArtifactId: string;
  backupRecordHash: `sha256:${string}`;
  windowDigest: `sha256:${string}`;
  evidenceDigest: `sha256:${string}`;
  recoveryPlanDigest: `sha256:${string}`;
  recoveryOwnerDigest: `sha256:${string}`;
  externalGateDigest: `sha256:${string}`;
}

export interface ProductionMigrationOperationSnapshot {
  operationId: string;
  created: boolean;
  state: 'waiting' | 'started' | 'succeeded' | 'aborted';
  requestHash: `sha256:${string}`;
  createdAt: string;
  result?: SupabaseProductionMigrationReceipt;
  abortProof?: ProductionMigrationAbortProof;
}

export interface ProductionMigrationHistoryEntry {
  operationId: string;
  manifestDigest: `sha256:${string}`;
  id: string;
  contentHash: `sha256:${string}`;
  targetOrdinal: number;
  schemaHashAfter: `sha256:${string}`;
  statementOutcomes: MigrationStatementOutcome[];
  verification: MigrationVerificationEvidence;
  appliedAt: string;
}

export interface ProductionMigrationAttemptEntry {
  operationId: string;
  manifestDigest: `sha256:${string}`;
  id: string;
  contentHash: `sha256:${string}`;
  targetOrdinal: number;
  beforeSchemaHash: `sha256:${string}`;
  expectedSchemaHash: `sha256:${string}`;
  attemptedAt: string;
}

export interface ProductionMigrationOperationStore {
  wait(input: ProductionMigrationOperationStart): Promise<ProductionMigrationOperationSnapshot>;
  start(input: ProductionMigrationOperationStart): Promise<ProductionMigrationOperationSnapshot>;
  load(operationId: string): Promise<ProductionMigrationOperationSnapshot | null>;
  loadTargetHistory(workspaceId: string, targetIdentityHash: `sha256:${string}`): Promise<ProductionMigrationHistoryEntry[]>;
  loadMigrationAttempt(operationId: string, migrationId: string): Promise<ProductionMigrationAttemptEntry | null>;
  recordMigrationAttempt(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    targetIdentityHash: `sha256:${string}`;
    entry: ProductionMigrationAttemptEntry;
  }): Promise<void>;
  recordMigration(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    targetIdentityHash: `sha256:${string}`;
    entry: ProductionMigrationHistoryEntry;
  }): Promise<void>;
  recordAbortProof(operationId: string, proof: ProductionMigrationAbortProof): Promise<void>;
  settle(receipt: SupabaseProductionMigrationReceipt): Promise<SupabaseProductionMigrationReceipt>;
}

interface OperationRow {
  id: string;
  state: string;
  request_hash: string;
  result_record: unknown;
  abort_proof: unknown;
  created_at: Date | string;
}

interface GrantRow {
  id: string;
  workspace_id: string;
  binding_id: string;
  binding_generation: string | number;
  capability: string;
  risk_class: string;
  subject_hash: string;
  issued_by_authority_hash: string;
  unexpired: boolean;
  consumed_by_operation_id: string | null;
  revoked_at: Date | null;
}

interface HistoryRow {
  operation_id: string;
  manifest_digest: string;
  migration_id: string;
  migration_content_hash: string;
  target_ordinal: string | number;
  schema_hash_after: string;
  statement_outcomes: unknown;
  verification: unknown;
  applied_at: Date | string;
}

interface AttemptRow {
  operation_id: string;
  manifest_digest: string;
  migration_id: string;
  migration_content_hash: string;
  target_ordinal: string | number;
  before_schema_hash: string;
  expected_schema_hash: string;
  attempted_at: Date | string;
}

function operationSnapshot(row: OperationRow, created: boolean): ProductionMigrationOperationSnapshot {
  return {
    operationId: row.id,
    created,
    state: row.state as ProductionMigrationOperationSnapshot['state'],
    requestHash: row.request_hash as `sha256:${string}`,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.abort_proof ? { abortProof: ProductionAbortProofSchema.parse(row.abort_proof) } : {}),
    ...(row.result_record ? { result: SupabaseProductionMigrationReceiptSchema.parse(row.result_record) } : {}),
  };
}

async function selectExactOperation(
  client: { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> },
  input: ProductionMigrationOperationStart,
): Promise<OperationRow> {
  const result = await client.query<OperationRow>(
    `SELECT id, state, request_hash, result_record, abort_proof, created_at
       FROM rorca.database_production_migration_operations
      WHERE id=$1
         OR (workspace_id=$2 AND idempotency_key=$3)
         OR (workspace_id=$2 AND target_identity_hash=$4 AND manifest_digest=$5)
      ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE`,
    [input.operationId, input.workspaceId, input.idempotencyKey, input.targetIdentityHash, input.manifestDigest],
  );
  const row = result.rows[0];
  if (!row || row.id !== input.operationId || row.request_hash !== input.requestHash) {
    throw new ConflictError('Production migration manifest or idempotency key is already bound to another operation');
  }
  return row;
}

async function lockExactGrant(
  client: { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> },
  input: ProductionMigrationOperationStart,
): Promise<GrantRow> {
  const result = await client.query<GrantRow>(
    `SELECT id, workspace_id, binding_id, binding_generation, capability, risk_class,
            subject_hash, issued_by_authority_hash, expires_at > clock_timestamp() AS unexpired,
            consumed_by_operation_id, revoked_at
       FROM rorca.database_authority_operation_grants
      WHERE id=$1 FOR UPDATE`,
    [input.authorityGrantId],
  );
  const grant = result.rows[0];
  if (!grant
      || grant.workspace_id !== input.workspaceId
      || grant.binding_id !== input.bindingId
      || Number(grant.binding_generation) !== input.bindingGeneration
      || grant.capability !== 'database.migration.apply.production'
      || grant.risk_class !== 'critical'
      || grant.subject_hash !== input.requestHash
      || grant.issued_by_authority_hash !== input.issuerAuthorityHash
      || !grant.unexpired
      || grant.revoked_at
      || (grant.consumed_by_operation_id !== null && grant.consumed_by_operation_id !== input.operationId)) {
    throw new ForbiddenError('Exact unexpired production migration authority grant is required', {
      reason: 'authority_grant_unauthorized',
    });
  }
  return grant;
}

const INSERT_OPERATION_SQL = `
  INSERT INTO rorca.database_production_migration_operations (
    id, workspace_id, binding_id, binding_generation, authority_grant_id,
    idempotency_key, request_hash, manifest_id, manifest_digest, target_identity_hash,
    target_digest, backup_artifact_id, backup_record_hash, window_digest, evidence_digest,
    recovery_plan_digest, recovery_owner_digest, external_gate_digest, state
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
  ON CONFLICT DO NOTHING`;

function operationValues(input: ProductionMigrationOperationStart, state: 'waiting' | 'started'): unknown[] {
  return [
    input.operationId, input.workspaceId, input.bindingId, input.bindingGeneration,
    input.authorityGrantId, input.idempotencyKey, input.requestHash, input.manifestId,
    input.manifestDigest, input.targetIdentityHash, input.targetDigest, input.backupArtifactId,
    input.backupRecordHash, input.windowDigest, input.evidenceDigest, input.recoveryPlanDigest,
    input.recoveryOwnerDigest, input.externalGateDigest, state,
  ];
}

async function waitForProductionMigration(
  input: ProductionMigrationOperationStart,
): Promise<ProductionMigrationOperationSnapshot> {
  return runtimeTransaction(async (client) => {
    await lockExactGrant(client, input);
    const inserted = await client.query(INSERT_OPERATION_SQL, operationValues(input, 'waiting'));
    const row = await selectExactOperation(client, input);
    if (row.state !== 'waiting' || row.result_record) {
      throw new ConflictError('Production migration cannot return to external-gate waiting');
    }
    return operationSnapshot(row, inserted.rowCount === 1);
  });
}

async function startProductionMigration(
  input: ProductionMigrationOperationStart,
): Promise<ProductionMigrationOperationSnapshot> {
  return runtimeTransaction(async (client) => {
    const grant = await lockExactGrant(client, input);
    const inserted = await client.query(INSERT_OPERATION_SQL, operationValues(input, 'started'));
    let row = await selectExactOperation(client, input);
    if (row.state === 'succeeded' || row.state === 'aborted') return operationSnapshot(row, false);

    if (grant.consumed_by_operation_id === null) {
      const consumed = await client.query(
        `UPDATE rorca.database_authority_operation_grants
            SET consumed_by_operation_id=$2, consumed_at=clock_timestamp()
          WHERE id=$1 AND consumed_by_operation_id IS NULL AND revoked_at IS NULL
            AND expires_at > clock_timestamp()`,
        [input.authorityGrantId, input.operationId],
      );
      if (consumed.rowCount !== 1) {
        throw new ForbiddenError('Production migration authority grant could not be consumed exactly once', {
          reason: 'authority_grant_consumption_failed',
        });
      }
    }
    if (row.state === 'waiting') {
      const promoted = await client.query(
        `UPDATE rorca.database_production_migration_operations
            SET state='started', started_at=clock_timestamp()
          WHERE id=$1 AND state='waiting'`,
        [input.operationId],
      );
      if (promoted.rowCount !== 1) throw new ConflictError('Production migration waiting state changed');
      row = { ...row, state: 'started' };
    }
    if (row.state !== 'started') throw new ConflictError('Production migration operation is not resumable');
    return operationSnapshot(row, inserted.rowCount === 1);
  });
}

async function loadProductionMigrationOperation(
  operationId: string,
): Promise<ProductionMigrationOperationSnapshot | null> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, abort_proof, created_at
         FROM rorca.database_production_migration_operations WHERE id=$1`,
      [operationId],
    );
    return result.rows[0] ? operationSnapshot(result.rows[0], false) : null;
  });
}

async function loadProductionTargetHistory(
  workspaceId: string,
  targetIdentityHash: `sha256:${string}`,
): Promise<ProductionMigrationHistoryEntry[]> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<HistoryRow>(
      `SELECT operation_id, manifest_digest, migration_id, migration_content_hash,
              target_ordinal, schema_hash_after, statement_outcomes, verification, applied_at
         FROM rorca.database_production_migration_history
        WHERE workspace_id=$1 AND target_identity_hash=$2
        ORDER BY target_ordinal`,
      [workspaceId, targetIdentityHash],
    );
    return result.rows.map((row) => ({
      operationId: row.operation_id,
      manifestDigest: row.manifest_digest as `sha256:${string}`,
      id: row.migration_id,
      contentHash: row.migration_content_hash as `sha256:${string}`,
      targetOrdinal: Number(row.target_ordinal),
      schemaHashAfter: row.schema_hash_after as `sha256:${string}`,
      statementOutcomes: z.array(StatementOutcomeSchema).parse(row.statement_outcomes),
      verification: MigrationVerificationEvidenceSchema.parse(row.verification),
      appliedAt: new Date(row.applied_at).toISOString(),
    }));
  });
}

function migrationAttemptFromRow(row: AttemptRow): ProductionMigrationAttemptEntry {
  return {
    operationId: row.operation_id,
    manifestDigest: row.manifest_digest as `sha256:${string}`,
    id: row.migration_id,
    contentHash: row.migration_content_hash as `sha256:${string}`,
    targetOrdinal: Number(row.target_ordinal),
    beforeSchemaHash: row.before_schema_hash as `sha256:${string}`,
    expectedSchemaHash: row.expected_schema_hash as `sha256:${string}`,
    attemptedAt: new Date(row.attempted_at).toISOString(),
  };
}

async function loadProductionMigrationAttempt(
  operationId: string,
  migrationId: string,
): Promise<ProductionMigrationAttemptEntry | null> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<AttemptRow>(
      `SELECT operation_id, manifest_digest, migration_id, migration_content_hash,
              target_ordinal, before_schema_hash, expected_schema_hash, attempted_at
         FROM rorca.database_production_migration_attempts
        WHERE operation_id=$1 AND migration_id=$2`,
      [operationId, migrationId],
    );
    return result.rows[0] ? migrationAttemptFromRow(result.rows[0]) : null;
  });
}

async function recordProductionMigrationAttempt(input: {
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  targetIdentityHash: `sha256:${string}`;
  entry: ProductionMigrationAttemptEntry;
}): Promise<void> {
  await runtimeTransaction(async (client) => {
    const operation = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, abort_proof, created_at
         FROM rorca.database_production_migration_operations WHERE id=$1 FOR UPDATE`,
      [input.entry.operationId],
    );
    if (operation.rows[0]?.state !== 'started') {
      throw new ConflictError('Production migration operation cannot cross a new apply boundary');
    }
    await client.query(
      `INSERT INTO rorca.database_production_migration_attempts (
         workspace_id, binding_id, binding_generation, target_identity_hash, operation_id,
         manifest_digest, migration_id, migration_content_hash, target_ordinal,
         before_schema_hash, expected_schema_hash, attempted_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT DO NOTHING`,
      [input.workspaceId, input.bindingId, input.bindingGeneration, input.targetIdentityHash,
        input.entry.operationId, input.entry.manifestDigest, input.entry.id, input.entry.contentHash,
        input.entry.targetOrdinal, input.entry.beforeSchemaHash, input.entry.expectedSchemaHash,
        input.entry.attemptedAt],
    );
    const existing = await client.query<AttemptRow>(
      `SELECT operation_id, manifest_digest, migration_id, migration_content_hash,
              target_ordinal, before_schema_hash, expected_schema_hash, attempted_at
         FROM rorca.database_production_migration_attempts
        WHERE operation_id=$1 AND migration_id=$2`,
      [input.entry.operationId, input.entry.id],
    );
    if (!existing.rows[0] || !sameCanonicalValue(migrationAttemptFromRow(existing.rows[0]), input.entry)) {
      throw new ConflictError('Production migration apply boundary conflicts with immutable manifest progress');
    }
  });
}

async function recordProductionMigration(input: {
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  targetIdentityHash: `sha256:${string}`;
  entry: ProductionMigrationHistoryEntry;
}): Promise<void> {
  await runtimeTransaction(async (client) => {
    const operation = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, abort_proof, created_at
         FROM rorca.database_production_migration_operations WHERE id=$1 FOR UPDATE`,
      [input.entry.operationId],
    );
    if (operation.rows[0]?.state !== 'started') {
      throw new ConflictError('Production migration operation cannot accept progress');
    }
    await client.query(
      `INSERT INTO rorca.database_production_migration_history (
         workspace_id, binding_id, binding_generation, target_identity_hash, operation_id,
         manifest_digest, migration_id, migration_content_hash, target_ordinal,
         schema_hash_after, statement_outcomes, verification, applied_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT DO NOTHING`,
      [input.workspaceId, input.bindingId, input.bindingGeneration, input.targetIdentityHash,
        input.entry.operationId, input.entry.manifestDigest, input.entry.id, input.entry.contentHash,
        input.entry.targetOrdinal, input.entry.schemaHashAfter, input.entry.statementOutcomes,
        input.entry.verification, input.entry.appliedAt],
    );
    const existing = await client.query<HistoryRow>(
      `SELECT operation_id, manifest_digest, migration_id, migration_content_hash,
              target_ordinal, schema_hash_after, statement_outcomes, verification, applied_at
         FROM rorca.database_production_migration_history
        WHERE workspace_id=$1 AND target_identity_hash=$2 AND migration_id=$3`,
      [input.workspaceId, input.targetIdentityHash, input.entry.id],
    );
    const row = existing.rows[0];
    if (!row || row.operation_id !== input.entry.operationId
        || row.manifest_digest !== input.entry.manifestDigest
        || row.migration_content_hash !== input.entry.contentHash
        || Number(row.target_ordinal) !== input.entry.targetOrdinal
        || row.schema_hash_after !== input.entry.schemaHashAfter
        || !sameCanonicalValue(row.statement_outcomes, input.entry.statementOutcomes)
        || !sameCanonicalValue(row.verification, input.entry.verification)) {
      throw new ConflictError('Production migration history conflicts with immutable manifest progress');
    }
  });
}

async function recordProductionAbortProof(
  operationId: string,
  proof: ProductionMigrationAbortProof,
): Promise<void> {
  await runtimeTransaction(async (client) => {
    const result = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, abort_proof, created_at
         FROM rorca.database_production_migration_operations WHERE id=$1 FOR UPDATE`,
      [operationId],
    );
    const operation = result.rows[0];
    if (!operation || operation.state !== 'started') {
      throw new ConflictError('Production migration operation cannot record abort consistency');
    }
    if (operation.abort_proof) {
      if (!sameCanonicalValue(operation.abort_proof, proof)) {
        throw new ConflictError('Production migration abort proof conflicts with reconciled consistency');
      }
      return;
    }
    const recorded = await client.query(
      `UPDATE rorca.database_production_migration_operations
          SET abort_proof=$2
        WHERE id=$1 AND state='started' AND abort_proof IS NULL`,
      [operationId, proof],
    );
    if (recorded.rowCount !== 1) {
      throw new ConflictError('Production migration abort proof could not be recorded exactly once');
    }
  });
}

async function settleProductionMigrationReceipt(
  receipt: SupabaseProductionMigrationReceipt,
): Promise<SupabaseProductionMigrationReceipt> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record, abort_proof, created_at
         FROM rorca.database_production_migration_operations WHERE id=$1 FOR UPDATE`,
      [receipt.operationId],
    );
    const operation = result.rows[0];
    if (!operation || operation.request_hash !== receipt.requestHash) {
      throw new ConflictError('Production migration operation subject changed');
    }
    if (operation.state !== 'started') return SupabaseProductionMigrationReceiptSchema.parse(operation.result_record);
    if (receipt.status === 'aborted') {
      if (!operation.abort_proof || !sameCanonicalValue(operation.abort_proof, receipt.abortProof)) {
        throw new ConflictError('Production migration receipt lacks its exact durable abort proof');
      }
    } else if (operation.abort_proof) {
      throw new ConflictError('Successful production migration cannot discard a durable abort proof');
    }
    await client.query(
      `INSERT INTO rorca.authority_operation_receipts (
         id, workspace_id, binding_id, provider_id, capability, binding_generation,
         request_hash, target_identity_hash, result_hash, secret_reference_id,
         secret_reference_fingerprint, redacted_evidence
       ) VALUES ($1,$2,$3,'supabase-database','database.migration.apply.production',$4,$5,$6,$7,$8,$9,$10)`,
      [receipt.receiptId, receipt.target.workspaceId, receipt.target.bindingId,
        receipt.target.bindingGeneration, receipt.requestHash, receipt.target.targetIdentityHash,
        receipt.resultHash, receipt.target.connectionReference.referenceId,
        receipt.target.connectionReference.fingerprint, receipt],
    );
    await client.query(
      `UPDATE rorca.database_production_migration_operations
          SET state=$2, receipt_id=$3, before_schema_hash=$4, after_schema_hash=$5,
              result_record=$6, abort_proof=$7, final_consistency=$8, settled_at=$9
        WHERE id=$1 AND state='started'`,
      [receipt.operationId, receipt.status, receipt.receiptId, receipt.beforeSchemaHash,
        receipt.afterSchemaHash, receipt, receipt.abortProof, receipt.finalConsistency,
        receipt.settledAt],
    );
    return receipt;
  });
}

export const databaseProductionMigrationOperationStore: ProductionMigrationOperationStore = {
  wait: waitForProductionMigration,
  start: startProductionMigration,
  load: loadProductionMigrationOperation,
  loadTargetHistory: loadProductionTargetHistory,
  loadMigrationAttempt: loadProductionMigrationAttempt,
  recordMigrationAttempt: recordProductionMigrationAttempt,
  recordMigration: recordProductionMigration,
  recordAbortProof: recordProductionAbortProof,
  settle: settleProductionMigrationReceipt,
};

function validateHistory(
  history: ProductionMigrationHistoryEntry[],
  request: SupabaseProductionMigrationRequest,
): number {
  const { baseHistory, migrations } = request.manifest;
  if (history.length < baseHistory.length) throw preflightFailure('missing_migrations');
  const baseIds = baseHistory.map((entry) => entry.id);
  const actualBaseIds = history.slice(0, baseHistory.length).map((entry) => entry.id);
  if (new Set([...baseIds, ...actualBaseIds]).size === baseIds.length
      && !sameCanonicalValue(baseIds, actualBaseIds)) {
    throw preflightFailure('reordered_migrations');
  }
  for (let index = 0; index < baseHistory.length; index += 1) {
    if (history[index]?.id !== baseHistory[index]?.id) throw preflightFailure('missing_migrations');
    if (history[index]?.contentHash !== baseHistory[index]?.contentHash) throw preflightFailure('dependency_conflicts');
  }
  const progress = history.slice(baseHistory.length);
  if (progress.length > migrations.length) throw preflightFailure('dependency_conflicts');
  for (let index = 0; index < progress.length; index += 1) {
    const actual = progress[index];
    const expected = migrations[index];
    if (!expected || actual.id !== expected.id || actual.contentHash !== expected.contentHash) {
      throw preflightFailure('dependency_conflicts');
    }
    if (actual.operationId !== request.operationId || actual.manifestDigest !== request.manifestDigest) {
      throw preflightFailure('manifest_already_applied_by_another_operation');
    }
  }
  return progress.length;
}

function receiptEntryFromHistory(
  entry: ProductionMigrationHistoryEntry,
  migration: StagingMigrationManifestEntry,
): ProductionMigrationReceiptEntry {
  return {
    migrationId: entry.id,
    contentHash: entry.contentHash,
    ordinal: entry.targetOrdinal,
    transactionMode: migration.transactionMode as 'transactional' | 'non-transactional',
    statementOutcomes: entry.statementOutcomes,
    verification: entry.verification,
  };
}


function operationStart(
  request: SupabaseProductionMigrationRequest,
  binding: SupabaseDatabaseProviderBinding,
): ProductionMigrationOperationStart {
  return {
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    workspaceId: binding.workspaceId,
    bindingId: binding.bindingId,
    bindingGeneration: binding.bindingGeneration,
    authorityGrantId: request.authorityGrant.grantId,
    issuerAuthorityHash: request.authorityGrant.issuerAuthorityHash,
    requestHash: productionMigrationSubjectHash(request),
    manifestId: request.manifest.manifestId,
    manifestDigest: request.manifestDigest,
    targetIdentityHash: supabaseDatabaseTargetIdentityHash(binding),
    targetDigest: request.target.targetDigest,
    backupArtifactId: request.backup.artifactId,
    backupRecordHash: request.backup.recordHash as `sha256:${string}`,
    windowDigest: request.changeWindow.windowDigest,
    evidenceDigest: digest(request.healthAbortEvidence),
    recoveryPlanDigest: request.recoveryPlan.planDigest,
    recoveryOwnerDigest: digest(request.recoveryOwner),
    externalGateDigest: digest(request.externalGate),
  };
}

function buildWaiting(
  request: SupabaseProductionMigrationRequest,
  snapshot: ProductionMigrationOperationSnapshot,
): SupabaseProductionMigrationWaiting {
  if (!request.externalGate.required) throw new ConflictError('External-gate waiting requires an independent gate');
  return SupabaseProductionMigrationWaitingSchema.parse({
    version: 'rorca.production-migration-waiting.v1',
    capability: 'database.migration.apply.production',
    operationId: request.operationId,
    authorityGrantId: request.authorityGrant.grantId,
    requestHash: productionMigrationSubjectHash(request),
    status: 'waiting',
    reason: 'external_gate_pending',
    gateId: request.externalGate.gateId,
    approvalDigest: request.externalGate.approvalDigest,
    waitingSince: snapshot.createdAt,
  });
}

function buildReceipt(input: {
  request: SupabaseProductionMigrationRequest;
  binding: SupabaseDatabaseProviderBinding;
  externalGate: z.infer<typeof ExternalGateSettlementSchema>;
  beforeSchemaHash: `sha256:${string}`;
  afterSchemaHash: `sha256:${string}`;
  status: 'succeeded' | 'aborted';
  migrations: ProductionMigrationReceiptEntry[];
  abortProof: ProductionMigrationAbortProof | null;
  history: ProductionMigrationHistoryEntry[];
  settledAt: string;
}): SupabaseProductionMigrationReceipt {
  const reference = input.binding.secretReferences[0];
  const withoutResultHash = {
    version: 'rorca.production-migration-receipt.v1' as const,
    receiptId: input.request.operationId,
    capability: 'database.migration.apply.production' as const,
    operationId: input.request.operationId,
    requestHash: productionMigrationSubjectHash(input.request),
    authorityGrantId: input.request.authorityGrant.grantId,
    manifestId: input.request.manifest.manifestId,
    manifestDigest: input.request.manifestDigest,
    target: {
      ...input.request.target,
      targetIdentityHash: supabaseDatabaseTargetIdentityHash(input.binding),
      databaseIdentityHash: input.binding.databaseIdentityHash,
      connectionReference: {
        referenceId: reference.referenceId,
        fingerprint: reference.fingerprint,
      },
    },
    backup: {
      artifactId: input.request.backup.artifactId,
      recordHash: input.request.backup.recordHash,
      contentHash: input.request.backup.contentHash,
      schemaHash: input.request.backup.schemaHash,
    },
    changeWindow: input.request.changeWindow,
    healthAbortEvidence: input.request.healthAbortEvidence,
    recoveryOwner: input.request.recoveryOwner,
    recoveryPlanDigest: input.request.recoveryPlan.planDigest,
    evidenceDigest: digest(input.request.healthAbortEvidence),
    recoveryOwnerDigest: digest(input.request.recoveryOwner),
    externalGateDigest: digest(input.request.externalGate),
    externalGate: input.externalGate,
    beforeSchemaHash: input.beforeSchemaHash,
    afterSchemaHash: input.afterSchemaHash,
    status: input.status,
    migrations: input.migrations,
    abortProof: input.abortProof,
    finalConsistency: {
      verified: true as const,
      schemaHash: input.afterSchemaHash,
      migrationHistoryDigest: digest(input.history.map((entry) => ({
        id: entry.id,
        contentHash: entry.contentHash,
        targetOrdinal: entry.targetOrdinal,
        schemaHashAfter: entry.schemaHashAfter,
      }))),
      historyLength: input.history.length,
      verifiedAt: input.settledAt,
    },
    settledAt: input.settledAt,
  };
  return SupabaseProductionMigrationReceiptSchema.parse({
    ...withoutResultHash,
    resultHash: digest(withoutResultHash),
  });
}

export interface SupabaseProductionMigrationAdapterDependencies {
  secretStore: DatabaseAuthoritySecretStore;
  provider?: SupabaseProductionMigrationProvider;
  restoreExecutor?: ProductionRestoreExecutor;
  externalGateVerifier?: ProductionExternalGateVerifier;
  healthMonitor?: ProductionMigrationHealthMonitor;
  operationStore?: ProductionMigrationOperationStore;
  backupStore?: Pick<DatabaseBackupRestoreOperationStore, 'loadBackupArtifact'>;
  readBinding?: (bindingId: string) => Promise<SupabaseDatabaseProviderBinding | null>;
  now?: () => Date;
}

export class SupabaseDatabaseProductionMigrationAuthorityProviderAdapter {
  readonly capabilities = Object.freeze([
    'database.migration.apply.production',
  ] as const satisfies readonly DatabaseAuthorityCapability[]);
  private readonly provider: SupabaseProductionMigrationProvider;
  private readonly store: ProductionMigrationOperationStore;
  private readonly backupStore: Pick<DatabaseBackupRestoreOperationStore, 'loadBackupArtifact'>;
  private readonly readBinding: (bindingId: string) => Promise<SupabaseDatabaseProviderBinding | null>;
  private readonly now: () => Date;

  constructor(private readonly dependencies: SupabaseProductionMigrationAdapterDependencies) {
    this.provider = dependencies.provider
      ?? new PostgresSupabaseProductionMigrationProvider(dependencies.restoreExecutor);
    this.store = dependencies.operationStore ?? databaseProductionMigrationOperationStore;
    this.backupStore = dependencies.backupStore ?? databaseBackupRestoreOperationStore;
    this.readBinding = dependencies.readBinding ?? readSupabaseDatabaseProviderBinding;
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: {
    operation: string;
    request: SupabaseProductionMigrationRequest;
  }): Promise<SupabaseProductionMigrationResult> {
    if (input.operation !== 'database.migration.apply.production') {
      throw new ForbiddenError('Production migration authority cannot execute deployment or other database operations', {
        requiredCapability: 'database.migration.apply.production',
      });
    }
    return this.applyProductionMigration(input.request);
  }

  async applyProductionMigration(
    rawRequest: SupabaseProductionMigrationRequest,
  ): Promise<SupabaseProductionMigrationResult> {
    const request = parseRequest(rawRequest);
    const now = this.now();
    const requestHash = productionMigrationSubjectHash(request);
    const existingOperation = await this.store.load(request.operationId);
    if (existingOperation && existingOperation.requestHash !== requestHash) {
      throw new ConflictError('Production migration operation subject changed before reconciliation');
    }
    const reconcilingStartedOperation = existingOperation?.state === 'started';
    assertStaticPreflight(request, now, reconcilingStartedOperation);
    assertGrant(request, now, reconcilingStartedOperation);
    const binding = await this.readBinding(request.target.bindingId);
    assertBinding(binding, request.target);
    const expectedTargetIdentityHash = supabaseDatabaseTargetIdentityHash(binding);
    if (request.backup.source.sourceIdentityHash !== databaseBackupSourceIdentityHash(binding)
        || request.backup.source.databaseIdentityHash !== binding.databaseIdentityHash) {
      throw preflightFailure('backup_target_mismatch');
    }
    const storedBackup = await this.backupStore.loadBackupArtifact(request.backup.artifactId);
    if (!storedBackup) throw preflightFailure('backup_missing');
    if (!sameCanonicalValue(storedBackup, request.backup)) throw preflightFailure('backup_verification_failed');

    const gateSettlement = reconcilingStartedOperation
      ? request.externalGate
      : await this.verifyExternalGate(request);
    const start = operationStart(request, binding);
    if (gateSettlement === null) {
      const waiting = await this.store.wait(start);
      return buildWaiting(request, waiting);
    }

    const connectionString = await resolveConnection(this.dependencies.secretStore, binding);
    const operation = await this.store.start(start);
    if (operation.state === 'succeeded' || operation.state === 'aborted') {
      if (!operation.result) throw new ConflictError('Settled production migration operation is missing its receipt');
      return SupabaseProductionMigrationReceiptSchema.parse(operation.result);
    }
    if (operation.state !== 'started') throw new ConflictError('Production migration operation remained waiting after approval');

    return this.provider.withFencedTarget({
      connectionString,
      fenceKey: `supabase-production-migration:${expectedTargetIdentityHash}`,
      binding,
      targetIdentityHash: expectedTargetIdentityHash,
    }, async (session) => {
      const refreshed = await this.store.load(request.operationId);
      if (!refreshed) throw new ConflictError('Production migration operation disappeared before target apply');
      if (refreshed.state !== 'started') {
        if (!refreshed.result) throw new ConflictError('Settled production migration operation is missing its receipt');
        return refreshed.result;
      }

      let history = await this.store.loadTargetHistory(binding.workspaceId, expectedTargetIdentityHash);
      let progress = validateHistory(history, request);
      const actualAtFence = await session.inspectSchemaHash();
      const expectedAtProgress = progress === 0
        ? request.manifest.currentSchemaHash
        : request.manifest.migrations[progress - 1].expectedSchemaHash;
      const pendingMigration = request.manifest.migrations[progress];
      const pendingAttempt = pendingMigration
        ? await this.store.loadMigrationAttempt(request.operationId, pendingMigration.id)
        : null;
      if (refreshed.abortProof) {
        const abortProof = refreshed.abortProof;
        const failedIndex = request.manifest.migrations.findIndex(
          (migration) => migration.id === abortProof.failedMigrationId,
        );
        const failedMigration = request.manifest.migrations[failedIndex];
        if (!failedMigration || failedIndex !== progress || !this.attemptMatches(
          pendingAttempt,
          request,
          failedMigration,
          request.manifest.baseHistory.length + failedIndex,
          abortProof.priorSchemaHash,
        )) {
          throw new ConflictError('Durable production abort proof conflicts with migration history');
        }
        if (actualAtFence !== abortProof.resultingSchemaHash) {
          throw recoveryFailure('durable_abort_schema_drift', failedMigration.id);
        }
        const recoveryQueries = failedMigration.recovery.classification === 'reversible'
          ? failedMigration.recovery.rollback.verificationQueries
          : failedMigration.recovery.procedure.verificationQueries;
        const reconciliationVerification = await session.verify({
          queries: recoveryQueries,
          expectedSchemaHash: abortProof.resultingSchemaHash,
        });
        if (!reconciliationVerification.passed
            || !sameCanonicalValue(reconciliationVerification, abortProof.verification)) {
          throw recoveryFailure('durable_abort_verification_failed', failedMigration.id);
        }
        const receiptEntries = history.slice(request.manifest.baseHistory.length)
          .map((entry, index) => receiptEntryFromHistory(entry, request.manifest.migrations[index]));
        receiptEntries.push({
          migrationId: failedMigration.id,
          contentHash: failedMigration.contentHash,
          ordinal: request.manifest.baseHistory.length + failedIndex,
          transactionMode: failedMigration.transactionMode as 'transactional' | 'non-transactional',
          statementOutcomes: abortProof.statementOutcomes,
          verification: abortProof.verification,
        });
        return this.settleAborted(
          request,
          binding,
          gateSettlement,
          receiptEntries,
          abortProof,
          history,
        );
      }

      if (!this.windowIsOpen(request, this.now())
          && pendingMigration
          && actualAtFence === expectedAtProgress) {
        throw preflightFailure('change_window_closed');
      }

      if (actualAtFence !== expectedAtProgress) {
        if (!pendingMigration || !this.attemptMatches(
          pendingAttempt,
          request,
          pendingMigration,
          request.manifest.baseHistory.length + progress,
          expectedAtProgress,
        )) {
          throw preflightFailure('schema_hash_drift');
        }
        if (actualAtFence === pendingMigration.expectedSchemaHash) {
          await this.recordReconciledMigration(
            session,
            request,
            binding,
            expectedTargetIdentityHash,
            pendingMigration,
            progress,
          );
          history = await this.store.loadTargetHistory(binding.workspaceId, expectedTargetIdentityHash);
          progress = validateHistory(history, request);
        } else {
          const receiptEntries = history.slice(request.manifest.baseHistory.length)
            .map((entry, index) => receiptEntryFromHistory(entry, request.manifest.migrations[index]));
          receiptEntries.push({
            migrationId: pendingMigration.id,
            contentHash: pendingMigration.contentHash,
            ordinal: request.manifest.baseHistory.length + progress,
            transactionMode: pendingMigration.transactionMode as 'transactional' | 'non-transactional',
            statementOutcomes: [],
            verification: null,
          });
          const abortProof = await this.abortMigration(
            session,
            request,
            pendingMigration,
            expectedAtProgress,
            'uncertain-outcome',
          );
          history = await this.store.loadTargetHistory(binding.workspaceId, expectedTargetIdentityHash);
          return this.settleAborted(
            request,
            binding,
            gateSettlement,
            receiptEntries,
            abortProof,
            history,
          );
        }
      }

      const receiptEntries = history.slice(request.manifest.baseHistory.length)
        .map((entry, index) => receiptEntryFromHistory(entry, request.manifest.migrations[index]));

      for (let index = progress; index < request.manifest.migrations.length; index += 1) {
        const migration = request.manifest.migrations[index];
        const priorSchemaHash = index === 0
          ? request.manifest.currentSchemaHash
          : request.manifest.migrations[index - 1].expectedSchemaHash;
        this.assertWindowOpen(request);
        await this.store.recordMigrationAttempt({
          workspaceId: binding.workspaceId,
          bindingId: binding.bindingId,
          bindingGeneration: binding.bindingGeneration,
          targetIdentityHash: expectedTargetIdentityHash,
          entry: {
            operationId: request.operationId,
            manifestDigest: request.manifestDigest,
            id: migration.id,
            contentHash: migration.contentHash,
            targetOrdinal: request.manifest.baseHistory.length + index,
            beforeSchemaHash: priorSchemaHash,
            expectedSchemaHash: migration.expectedSchemaHash,
            attemptedAt: this.now().toISOString(),
          },
        });

        let statementOutcomes: MigrationStatementOutcome[] = [];
        let verification: MigrationVerificationEvidence | null = null;
        try {
          statementOutcomes = await session.executeStatements({
            migrationId: migration.id,
            phase: 'apply',
            transactionMode: migration.transactionMode as 'transactional' | 'non-transactional',
            statements: migration.statements,
          });
          verification = await session.verify({
            queries: migration.verificationQueries,
            expectedSchemaHash: migration.expectedSchemaHash,
          });
          if (!verification.passed) throw new StagingMigrationStatementError(statementOutcomes);
        } catch (error) {
          if (error instanceof StagingMigrationStatementError && error.outcomes.length > 0) {
            statementOutcomes = error.outcomes;
          }
          receiptEntries.push({
            migrationId: migration.id,
            contentHash: migration.contentHash,
            ordinal: request.manifest.baseHistory.length + index,
            transactionMode: migration.transactionMode as 'transactional' | 'non-transactional',
            statementOutcomes,
            verification,
          });
          const abortProof = await this.abortMigration(
            session,
            request,
            migration,
            priorSchemaHash,
            'apply-failure',
          );
          history = await this.store.loadTargetHistory(binding.workspaceId, expectedTargetIdentityHash);
          return this.settleAborted(
            request,
            binding,
            gateSettlement,
            receiptEntries,
            abortProof,
            history,
          );
        }
          const health = await this.checkHealth(request, migration.id);
          const windowClosed = !this.windowIsOpen(request, this.now());
          if (health.status === 'abort' || windowClosed) {
            const entry: ProductionMigrationReceiptEntry = {
              migrationId: migration.id,
              contentHash: migration.contentHash,
              ordinal: request.manifest.baseHistory.length + index,
              transactionMode: migration.transactionMode as 'transactional' | 'non-transactional',
              statementOutcomes,
              verification,
            };
            receiptEntries.push(entry);
            const abortProof = await this.abortMigration(
              session,
              request,
              migration,
              priorSchemaHash,
              windowClosed ? 'window-closed' : 'health-abort',
            );
            history = await this.store.loadTargetHistory(binding.workspaceId, expectedTargetIdentityHash);
            return this.settleAborted(
              request,
              binding,
              gateSettlement,
              receiptEntries,
              abortProof,
              history,
            );
          }

        const historyEntry: ProductionMigrationHistoryEntry = {
          operationId: request.operationId,
          manifestDigest: request.manifestDigest,
          id: migration.id,
          contentHash: migration.contentHash,
          targetOrdinal: request.manifest.baseHistory.length + index,
          schemaHashAfter: verification.actualSchemaHash,
          statementOutcomes,
          verification,
          appliedAt: this.now().toISOString(),
        };
        await this.store.recordMigration({
          workspaceId: binding.workspaceId,
          bindingId: binding.bindingId,
          bindingGeneration: binding.bindingGeneration,
          targetIdentityHash: expectedTargetIdentityHash,
          entry: historyEntry,
        });
        receiptEntries.push(receiptEntryFromHistory(historyEntry, migration));
      }

      const afterSchemaHash = await session.inspectSchemaHash();
      if (afterSchemaHash !== request.manifest.expectedFinalSchemaHash) throw preflightFailure('schema_hash_drift');
      history = await this.store.loadTargetHistory(binding.workspaceId, expectedTargetIdentityHash);
      const settledAt = this.now().toISOString();
      const receipt = buildReceipt({
        request,
        binding,
        externalGate: gateSettlement,
        beforeSchemaHash: request.manifest.currentSchemaHash,
        afterSchemaHash,
        status: 'succeeded',
        migrations: receiptEntries,
        abortProof: null,
        history,
        settledAt,
      });
      return this.store.settle(receipt);
    });
  }

  private async verifyExternalGate(
    request: SupabaseProductionMigrationRequest,
  ): Promise<z.infer<typeof ExternalGateSettlementSchema> | null> {
    const gate = request.externalGate;
    if (!gate.required) return gate;
    if (new Date(gate.approvalExpiresAt).getTime() <= this.now().getTime()) {
      throw preflightFailure('invalid_external_gate');
    }
    if (!this.dependencies.externalGateVerifier) throw preflightFailure('invalid_external_gate');
    const decision = await this.dependencies.externalGateVerifier.verify(gate);
    if (decision.status === 'waiting') return null;
    if (decision.status !== 'approved'
        || decision.gateId !== gate.gateId
        || decision.approvalDigest !== gate.approvalDigest
        || decision.approverAuthorityHash !== gate.approverAuthorityHash
        || decision.evidenceReference !== gate.evidenceReference
        || decision.approvedAt !== gate.approvedAt
        || new Date(decision.approvedAt).getTime() > this.now().getTime()) {
      throw preflightFailure('invalid_external_gate');
    }
    return gate;
  }

  private windowIsOpen(request: SupabaseProductionMigrationRequest, now: Date): boolean {
    return now.getTime() >= new Date(request.changeWindow.opensAt).getTime()
      && now.getTime() < new Date(request.changeWindow.closesAt).getTime();
  }

  private assertWindowOpen(request: SupabaseProductionMigrationRequest): void {
    if (!this.windowIsOpen(request, this.now())) throw preflightFailure('change_window_closed');
  }

  private async checkHealth(
    request: SupabaseProductionMigrationRequest,
    migrationId: string,
  ): Promise<{ status: 'healthy' } | { status: 'abort'; reasonCode: string }> {
    if (!this.dependencies.healthMonitor) return { status: 'healthy' };
    return this.dependencies.healthMonitor.check({
      operationId: request.operationId,
      migrationId,
      expectedHealthEvidenceDigest: request.healthAbortEvidence.health.evidenceDigest,
      expectedAbortEvidenceDigest: request.healthAbortEvidence.abort.evidenceDigest,
    });
  }

  private attemptMatches(
    attempt: ProductionMigrationAttemptEntry | null,
    request: SupabaseProductionMigrationRequest,
    migration: StagingMigrationManifestEntry,
    targetOrdinal: number,
    beforeSchemaHash: `sha256:${string}`,
  ): boolean {
    return Boolean(attempt
      && attempt.operationId === request.operationId
      && attempt.manifestDigest === request.manifestDigest
      && attempt.id === migration.id
      && attempt.contentHash === migration.contentHash
      && attempt.targetOrdinal === targetOrdinal
      && attempt.beforeSchemaHash === beforeSchemaHash
      && attempt.expectedSchemaHash === migration.expectedSchemaHash);
  }

  private async recordReconciledMigration(
    session: SupabaseProductionMigrationSession,
    request: SupabaseProductionMigrationRequest,
    binding: SupabaseDatabaseProviderBinding,
    targetIdentityHash: `sha256:${string}`,
    migration: StagingMigrationManifestEntry,
    index: number,
  ): Promise<void> {
    const verification = await session.verify({
      queries: migration.verificationQueries,
      expectedSchemaHash: migration.expectedSchemaHash,
    });
    if (!verification.passed) throw preflightFailure('schema_hash_drift');
    await this.store.recordMigration({
      workspaceId: binding.workspaceId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      targetIdentityHash,
      entry: {
        operationId: request.operationId,
        manifestDigest: request.manifestDigest,
        id: migration.id,
        contentHash: migration.contentHash,
        targetOrdinal: request.manifest.baseHistory.length + index,
        schemaHashAfter: migration.expectedSchemaHash,
        statementOutcomes: migration.statements.map((statement) => ({
          migrationId: migration.id,
          statementId: statement.statementId,
          contentHash: statement.contentHash,
          phase: 'apply',
          outcome: 'reconciled-applied',
        })),
        verification,
        appliedAt: this.now().toISOString(),
      },
    });
  }

  private async abortMigration(
    session: SupabaseProductionMigrationSession,
    request: SupabaseProductionMigrationRequest,
    migration: StagingMigrationManifestEntry,
    priorSchemaHash: `sha256:${string}`,
    trigger: ProductionMigrationAbortProof['trigger'],
  ): Promise<ProductionMigrationAbortProof> {
    const planProcedure = request.recoveryPlan.procedures.find((entry) => entry.migrationId === migration.id);
    if (!planProcedure) throw recoveryFailure('recovery_procedure_missing', migration.id);
    let statementOutcomes: MigrationStatementOutcome[] = [];
    let restoreOutcome: ProductionRestoreOutcome | undefined;
    let verification: MigrationVerificationEvidence;

    try {
      if (migration.recovery.classification === 'reversible') {
        statementOutcomes = await session.executeStatements({
          migrationId: migration.id,
          phase: 'rollback',
          transactionMode: 'transactional',
          statements: migration.recovery.rollback.statements,
        });
        verification = await session.verify({
          queries: migration.recovery.rollback.verificationQueries,
          expectedSchemaHash: migration.recovery.rollback.expectedSchemaHash,
        });
        if (!verification.passed || verification.actualSchemaHash !== priorSchemaHash) {
          throw recoveryFailure('rollback_verification_failed', migration.id);
        }
      } else if (migration.recovery.procedure.strategy === 'forward-fix') {
        statementOutcomes = await session.executeStatements({
          migrationId: migration.id,
          phase: 'forward-fix',
          transactionMode: 'transactional',
          statements: migration.recovery.procedure.statements,
        });
        verification = await session.verify({
          queries: migration.recovery.procedure.verificationQueries,
          expectedSchemaHash: migration.recovery.procedure.expectedSchemaHash,
        });
        if (!verification.passed) throw recoveryFailure('forward_fix_verification_failed', migration.id);
      } else {
        restoreOutcome = await session.restoreProduction({
          artifact: request.backup,
          procedureReference: planProcedure.evidenceReference,
          restorePolicyReference: request.recoveryPlan.restorePolicyReference,
        });
        verification = await session.verify({
          queries: migration.recovery.procedure.verificationQueries,
          expectedSchemaHash: migration.recovery.procedure.expectedSchemaHash,
        });
        if (!verification.passed || verification.actualSchemaHash !== request.backup.schemaHash) {
          throw recoveryFailure('restore_verification_failed', migration.id);
        }
      }
      return ProductionAbortProofSchema.parse({
        trigger,
        classification: migration.recovery.classification,
        strategy: planProcedure.strategy,
        failedMigrationId: migration.id,
        priorSchemaHash,
        resultingSchemaHash: verification.actualSchemaHash,
        statementOutcomes,
        ...(restoreOutcome ? { restoreOutcome } : {}),
        verification,
        procedureEvidenceReference: planProcedure.evidenceReference,
      });
    } catch (error) {
      if (error instanceof UnprocessableError && error.code === 'DATABASE_PRODUCTION_MIGRATION_ABORT_FAILED') {
        throw error;
      }
      throw recoveryFailure('declared_recovery_procedure_failed', migration.id);
    }
  }

  private async settleAborted(
    request: SupabaseProductionMigrationRequest,
    binding: SupabaseDatabaseProviderBinding,
    externalGate: z.infer<typeof ExternalGateSettlementSchema>,
    migrations: ProductionMigrationReceiptEntry[],
    abortProof: ProductionMigrationAbortProof,
    history: ProductionMigrationHistoryEntry[],
  ): Promise<SupabaseProductionMigrationReceipt> {
    await this.store.recordAbortProof(request.operationId, abortProof);
    const settledAt = this.now().toISOString();
    const receipt = buildReceipt({
      request,
      binding,
      externalGate,
      beforeSchemaHash: request.manifest.currentSchemaHash,
      afterSchemaHash: abortProof.resultingSchemaHash,
      status: 'aborted',
      migrations,
      abortProof,
      history,
      settledAt,
    });
    return this.store.settle(receipt);
  }
}
