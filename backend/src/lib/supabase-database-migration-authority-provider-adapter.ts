/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { runtimeTransaction } from '../db';
import { ConflictError, ForbiddenError, UnprocessableError } from './errors';
import {
  SUPABASE_SCHEMA_INSPECTION_SQL,
  buildSupabaseSchemaInventory,
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  databaseRoleFingerprint,
  readSupabaseDatabaseProviderBinding,
  supabaseDatabaseTargetIdentityHash,
  type DatabaseAuthorityCapability,
  type DatabaseAuthoritySecretStore,
  type SupabaseDatabaseProviderBinding,
  type SupabaseSchemaCatalog,
} from './supabase-database-authority-provider-adapter';

const Sha256Schema = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
);
const IdentifierSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/);
const ReferenceSchema = z.string().min(1).max(2048).refine((value) => {
  if (!/^[a-z][a-z0-9+.-]{1,31}:\/\/\S+$/i.test(value)) return false;
  if (/^postgres(?:ql)?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    return !(parsed.username || parsed.password);
  } catch {
    return false;
  }
}, { message: 'Expected an opaque credential-free reference' });
const SqlSchema = z.string().trim().min(1).max(1_000_000);
const SUPPORTED_TRANSACTION_MODES: Readonly<Record<string, true>> = {
  transactional: true,
  'non-transactional': true,
};

function normalizeCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite canonical number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalizeCanonicalValue(record[key])]));
  }
  throw new TypeError('Unsupported canonical value');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function stagingMigrationSqlHash(sql: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(sql, 'utf8').digest('hex')}`;
}

const MigrationStatementSchema = z.object({
  statementId: IdentifierSchema,
  sql: SqlSchema,
  contentHash: Sha256Schema,
}).strict();
export type MigrationStatement = z.infer<typeof MigrationStatementSchema>;

const VerificationQuerySchema = z.object({
  queryId: IdentifierSchema,
  sql: SqlSchema,
  contentHash: Sha256Schema,
  expectedResultHash: Sha256Schema,
}).strict();
export type MigrationVerificationQuery = z.infer<typeof VerificationQuerySchema>;

const OrderedMigrationReferenceSchema = z.object({
  id: IdentifierSchema,
  contentHash: Sha256Schema,
}).strict();
export type OrderedMigrationReference = z.infer<typeof OrderedMigrationReferenceSchema>;

const BackupRecoveryEvidenceSchema = z.object({
  artifactId: z.string().uuid(),
  contentHash: Sha256Schema,
  schemaHash: Sha256Schema,
  verificationResult: z.literal('passed'),
  verificationReference: ReferenceSchema,
}).strict();

const RecoveryVerificationFields = {
  expectedSchemaHash: Sha256Schema,
  verificationQueries: z.array(VerificationQuerySchema).min(1).max(100),
};

const ReversibleRecoverySchema = z.object({
  classification: z.literal('reversible'),
  rollback: z.object({
    tested: z.literal(true),
    statements: z.array(MigrationStatementSchema).min(1).max(1_000),
    ...RecoveryVerificationFields,
  }).strict(),
}).strict();

const ForwardOnlyRecoverySchema = z.object({
  classification: z.literal('forward-only'),
  backupEvidence: BackupRecoveryEvidenceSchema,
  procedure: z.discriminatedUnion('strategy', [
    z.object({
      strategy: z.literal('forward-fix'),
      statements: z.array(MigrationStatementSchema).min(1).max(1_000),
      ...RecoveryVerificationFields,
    }).strict(),
    z.object({
      strategy: z.literal('scratch-restore'),
      backupArtifactId: z.string().uuid(),
      procedureReference: ReferenceSchema,
      ...RecoveryVerificationFields,
    }).strict(),
  ]),
}).strict();

export const StagingMigrationManifestEntrySchema = z.object({
  id: IdentifierSchema,
  contentHash: Sha256Schema,
  prerequisites: z.array(IdentifierSchema).max(10_000),
  transactionMode: z.string().min(1).max(64),
  statements: z.array(MigrationStatementSchema).min(1).max(1_000),
  expectedSchemaHash: Sha256Schema,
  verificationQueries: z.array(VerificationQuerySchema).min(1).max(100),
  recovery: z.union([ReversibleRecoverySchema, ForwardOnlyRecoverySchema]),
}).strict();
export type StagingMigrationManifestEntry = z.infer<typeof StagingMigrationManifestEntrySchema>;

export const StagingMigrationManifestSchema = z.object({
  version: z.literal('rorca.staging-migration-manifest.v1'),
  manifestId: z.string().uuid(),
  currentSchemaHash: Sha256Schema,
  baseHistory: z.array(OrderedMigrationReferenceSchema).max(100_000),
  migrations: z.array(StagingMigrationManifestEntrySchema).min(1).max(10_000),
  expectedFinalSchemaHash: Sha256Schema,
}).strict();
export type StagingMigrationManifest = z.infer<typeof StagingMigrationManifestSchema>;

const StagingBindingScopeSchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(1).max(255),
  environment: z.literal('staging'),
  databaseIdentity: z.object({
    databaseName: z.string().min(1).max(63),
    endpointFingerprint: Sha256Schema,
  }).strict(),
  bindingGeneration: z.number().int().positive(),
}).strict();
export type StagingBindingScope = z.infer<typeof StagingBindingScopeSchema>;

const StagingMigrationGrantSchema = z.object({
  grantId: z.string().uuid(),
  capability: z.literal('database.migration.apply.staging'),
  riskClass: z.literal('high'),
  workspaceId: z.string().min(1).max(255),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  subjectHash: Sha256Schema,
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export const SupabaseStagingMigrationSubjectSchema = z.object({
  operationId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(255),
  target: StagingBindingScopeSchema,
  manifest: StagingMigrationManifestSchema,
  manifestDigest: Sha256Schema,
}).strict();
export type SupabaseStagingMigrationSubject = z.infer<typeof SupabaseStagingMigrationSubjectSchema>;

export const SupabaseStagingMigrationRequestSchema = SupabaseStagingMigrationSubjectSchema.extend({
  authorityGrant: StagingMigrationGrantSchema,
}).strict();
export type SupabaseStagingMigrationRequest = z.infer<typeof SupabaseStagingMigrationRequestSchema>;

const StatementOutcomeSchema = z.object({
  migrationId: IdentifierSchema,
  statementId: IdentifierSchema,
  contentHash: Sha256Schema,
  phase: z.enum(['apply', 'rollback', 'forward-fix']),
  outcome: z.enum(['applied', 'failed', 'rolled-back', 'reconciled-applied']),
  errorCode: IdentifierSchema.optional(),
}).strict();
export type MigrationStatementOutcome = z.infer<typeof StatementOutcomeSchema>;

const QueryVerificationOutcomeSchema = z.object({
  queryId: IdentifierSchema,
  contentHash: Sha256Schema,
  expectedResultHash: Sha256Schema,
  actualResultHash: Sha256Schema.nullable(),
  passed: z.boolean(),
}).strict();

export const MigrationVerificationEvidenceSchema = z.object({
  queries: z.array(QueryVerificationOutcomeSchema),
  expectedSchemaHash: Sha256Schema,
  actualSchemaHash: Sha256Schema,
  schemaPassed: z.boolean(),
  passed: z.boolean(),
}).strict();
export type MigrationVerificationEvidence = z.infer<typeof MigrationVerificationEvidenceSchema>;

const RestoreActionOutcomeSchema = z.object({
  backupArtifactId: z.string().uuid(),
  procedureReference: ReferenceSchema,
  outcome: z.literal('restored'),
  providerEvidenceReference: ReferenceSchema,
}).strict();
export type StagingRestoreActionOutcome = z.infer<typeof RestoreActionOutcomeSchema>;

const MigrationReceiptEntrySchema = z.object({
  migrationId: IdentifierSchema,
  contentHash: Sha256Schema,
  ordinal: z.number().int().nonnegative(),
  transactionMode: z.enum(['transactional', 'non-transactional']),
  statementOutcomes: z.array(StatementOutcomeSchema),
  verification: MigrationVerificationEvidenceSchema.nullable(),
}).strict();
export type StagingMigrationReceiptEntry = z.infer<typeof MigrationReceiptEntrySchema>;

const RecoveryProofSchema = z.object({
  classification: z.enum(['reversible', 'forward-only']),
  strategy: z.enum(['rollback', 'forward-fix', 'scratch-restore']),
  failedMigrationId: IdentifierSchema,
  priorSchemaHash: Sha256Schema,
  resultingSchemaHash: Sha256Schema,
  statementOutcomes: z.array(StatementOutcomeSchema),
  restoreOutcome: RestoreActionOutcomeSchema.optional(),
  verification: MigrationVerificationEvidenceSchema,
  backupEvidence: BackupRecoveryEvidenceSchema.optional(),
}).strict();
export type StagingMigrationRecoveryProof = z.infer<typeof RecoveryProofSchema>;

const ReceiptTargetSchema = z.object({
  providerId: z.literal('supabase-database'),
  bindingId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(1).max(255),
  environment: z.literal('staging'),
  databaseIdentityHash: Sha256Schema,
  targetIdentityHash: Sha256Schema,
  connectionReference: z.object({ referenceId: ReferenceSchema, fingerprint: Sha256Schema }).strict(),
}).strict();

export const SupabaseStagingMigrationReceiptSchema = z.object({
  version: z.literal('rorca.staging-migration-receipt.v1'),
  receiptId: z.string().uuid(),
  capability: z.literal('database.migration.apply.staging'),
  operationId: z.string().uuid(),
  requestHash: Sha256Schema,
  resultHash: Sha256Schema,
  manifestId: z.string().uuid(),
  manifestDigest: Sha256Schema,
  authorityGrantId: z.string().uuid(),
  target: ReceiptTargetSchema,
  beforeSchemaHash: Sha256Schema,
  afterSchemaHash: Sha256Schema,
  status: z.enum(['succeeded', 'recovered']),
  migrations: z.array(MigrationReceiptEntrySchema),
  recoveryProof: RecoveryProofSchema.nullable(),
  settledAt: z.string().datetime({ offset: true }),
}).strict();
export type SupabaseStagingMigrationReceipt = z.infer<typeof SupabaseStagingMigrationReceiptSchema>;

export function stagingMigrationEntryContentHash(
  entry: Pick<StagingMigrationManifestEntry, 'id' | 'transactionMode' | 'statements'>,
): `sha256:${string}` {
  return digest({
    id: entry.id,
    transactionMode: entry.transactionMode,
    statements: entry.statements.map(({ statementId, contentHash }) => ({ statementId, contentHash })),
  });
}

export function stagingMigrationManifestDigest(manifest: StagingMigrationManifest): `sha256:${string}` {
  return digest(manifest);
}

export function stagingMigrationSubjectHash(
  rawSubject: SupabaseStagingMigrationSubject | SupabaseStagingMigrationRequest,
): `sha256:${string}` {
  if ('authorityGrant' in rawSubject) {
    const { authorityGrant: _authorityGrant, ...subject } = rawSubject;
    return digest(subject);
  }
  return digest(rawSubject);
}

export function migrationVerificationResultHash(rows: Array<Record<string, unknown>>): `sha256:${string}` {
  return digest(rows);
}

function preflightFailure(reason: string): UnprocessableError {
  return new UnprocessableError(
    'Supabase staging migration preflight rejected the request',
    'DATABASE_STAGING_MIGRATION_PREFLIGHT_REJECTED',
    { reason },
  );
}

function recoveryFailure(reason: string, migrationId: string): UnprocessableError {
  return new UnprocessableError(
    'Supabase staging migration recovery did not restore a declared consistent state',
    'DATABASE_STAGING_MIGRATION_RECOVERY_FAILED',
    { reason, migrationId },
  );
}

function parseRequest(rawRequest: SupabaseStagingMigrationRequest): SupabaseStagingMigrationRequest {
  const parsed = SupabaseStagingMigrationRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    const absentRecovery = parsed.error.issues.some((issue) => issue.path.includes('recovery'));
    throw preflightFailure(absentRecovery ? 'absent_recovery_classification' : 'manifest_invalid');
  }
  return parsed.data;
}

function assertSqlHashes(statements: MigrationStatement[], reason: string): void {
  const ids = new Set<string>();
  for (const statement of statements) {
    if (ids.has(statement.statementId)) throw preflightFailure('duplicate_statement_ids');
    ids.add(statement.statementId);
    if (stagingMigrationSqlHash(statement.sql) !== statement.contentHash) throw preflightFailure(reason);
    if (/^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i.test(statement.sql)) {
      throw preflightFailure('statement_transaction_control_forbidden');
    }
  }
}

function assertVerificationQueries(queries: MigrationVerificationQuery[]): void {
  const ids = new Set<string>();
  for (const query of queries) {
    if (ids.has(query.queryId)) throw preflightFailure('duplicate_verification_query_ids');
    ids.add(query.queryId);
    if (stagingMigrationSqlHash(query.sql) !== query.contentHash) throw preflightFailure('verification_query_hash_mismatch');
  }
}

export function assertStagingMigrationManifest(manifest: StagingMigrationManifest, manifestDigest: string): void {
  if (stagingMigrationManifestDigest(manifest) !== manifestDigest) throw preflightFailure('manifest_digest_mismatch');
  if (manifest.migrations.at(-1)?.expectedSchemaHash !== manifest.expectedFinalSchemaHash) {
    throw preflightFailure('expected_final_schema_hash_mismatch');
  }

  const allIds = [...manifest.baseHistory.map((entry) => entry.id), ...manifest.migrations.map((entry) => entry.id)];
  if (new Set(allIds).size !== allIds.length) throw preflightFailure('duplicate_ids');
  const knownBefore = new Set(manifest.baseHistory.map((entry) => entry.id));
  const futureIds = new Set(manifest.migrations.map((entry) => entry.id));
  let priorSchemaHash = manifest.currentSchemaHash;

  for (const migration of manifest.migrations) {
    if (!(migration.transactionMode in SUPPORTED_TRANSACTION_MODES)) throw preflightFailure('unsupported_transaction_mode');
    if (new Set(migration.prerequisites).size !== migration.prerequisites.length) throw preflightFailure('dependency_conflicts');
    for (const prerequisite of migration.prerequisites) {
      if (knownBefore.has(prerequisite)) continue;
      if (futureIds.has(prerequisite)) throw preflightFailure('reordered_migrations');
      throw preflightFailure('missing_migrations');
    }
    assertSqlHashes(migration.statements, 'migration_content_hash_mismatch');
    if (stagingMigrationEntryContentHash(migration) !== migration.contentHash) {
      throw preflightFailure('migration_content_hash_mismatch');
    }
    assertVerificationQueries(migration.verificationQueries);

    if (migration.recovery.classification === 'reversible') {
      if (migration.recovery.rollback.expectedSchemaHash !== priorSchemaHash) {
        throw preflightFailure('rollback_schema_hash_conflict');
      }
      assertSqlHashes(migration.recovery.rollback.statements, 'rollback_content_hash_mismatch');
      assertVerificationQueries(migration.recovery.rollback.verificationQueries);
    } else {
      if (migration.recovery.backupEvidence.schemaHash !== priorSchemaHash) {
        throw preflightFailure('backup_schema_hash_conflict');
      }
      const procedure = migration.recovery.procedure;
      if (procedure.strategy === 'forward-fix') {
        assertSqlHashes(procedure.statements, 'forward_fix_content_hash_mismatch');
      } else if (procedure.backupArtifactId !== migration.recovery.backupEvidence.artifactId) {
        throw preflightFailure('restore_artifact_conflict');
      }
      assertVerificationQueries(procedure.verificationQueries);
    }
    knownBefore.add(migration.id);
    futureIds.delete(migration.id);
    priorSchemaHash = migration.expectedSchemaHash;
  }
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertBinding(
  binding: SupabaseDatabaseProviderBinding | null,
  scope: StagingBindingScope,
): asserts binding is SupabaseDatabaseProviderBinding {
  if (!binding) throw preflightFailure('binding_not_found');
  if (binding.providerId !== 'supabase-database') throw preflightFailure('wrong_provider');
  if (binding.bindingId !== scope.bindingId) throw preflightFailure('wrong_binding');
  if (binding.workspaceId !== scope.workspaceId) throw preflightFailure('wrong_workspace');
  if (binding.projectRef !== scope.projectRef) throw preflightFailure('wrong_project');
  if (binding.environment !== 'staging' || binding.environment !== scope.environment) throw preflightFailure('wrong_environment');
  if (!sameCanonicalValue(binding.databaseIdentity, scope.databaseIdentity)) throw preflightFailure('wrong_database');
  if (binding.databaseIdentityHash !== databaseResourceIdentityHash(binding.databaseIdentity)) {
    throw preflightFailure('database_identity_hash_invalid');
  }
  if (binding.bindingGeneration !== scope.bindingGeneration) throw preflightFailure('stale_generation');
  if (binding.bindingStatus !== 'active') throw preflightFailure('binding_inactive');
  if (!binding.roleProfile.verified) throw preflightFailure('role_unverified');
  if (binding.roleProfile.authenticationClass !== 'database-role') throw preflightFailure('application_credential_forbidden');
  if (!binding.roleProfile.capabilities.includes('database.migration.apply.staging')) throw preflightFailure('capability_missing');
  const reference = binding.secretReferences[0];
  if (!reference || reference.purpose !== 'database-connection') throw preflightFailure('reference_missing');
  if (reference.credentialClass !== 'database-role') throw preflightFailure('application_credential_forbidden');
}

function assertGrant(request: SupabaseStagingMigrationRequest, now: Date): void {
  const grant = request.authorityGrant;
  if (grant.capability !== 'database.migration.apply.staging') throw preflightFailure('grant_capability_mismatch');
  if (grant.riskClass !== 'high') throw preflightFailure('grant_risk_class_mismatch');
  if (grant.workspaceId !== request.target.workspaceId || grant.bindingId !== request.target.bindingId) {
    throw preflightFailure('grant_scope_mismatch');
  }
  if (grant.bindingGeneration !== request.target.bindingGeneration) throw preflightFailure('grant_generation_mismatch');
  if (grant.subjectHash !== stagingMigrationSubjectHash(request)) throw preflightFailure('grant_subject_mismatch');
  if (new Date(grant.expiresAt).getTime() <= now.getTime()) throw preflightFailure('grant_expired');
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

export class StagingMigrationStatementError extends Error {
  constructor(readonly outcomes: MigrationStatementOutcome[]) {
    super('Staging migration statement execution failed');
    this.name = 'StagingMigrationStatementError';
  }
}

export interface SupabaseStagingMigrationSession {
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
  restoreScratch(input: {
    backupArtifactId: string;
    backupContentHash: `sha256:${string}`;
    procedureReference: string;
  }): Promise<StagingRestoreActionOutcome>;
}

export interface SupabaseStagingMigrationProvider {
  withFencedTarget<T>(input: {
    connectionString: string;
    fenceKey: string;
    binding: SupabaseDatabaseProviderBinding;
    targetIdentityHash: `sha256:${string}`;
  }, operation: (session: SupabaseStagingMigrationSession) => Promise<T>): Promise<T>;
}

interface MigrationConnection {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
}

type MigrationConnectionFactory = (connectionString: string) => Promise<MigrationConnection>;

export interface StagingScratchRestoreExecutor {
  restore(input: {
    targetConnectionString: string;
    backupArtifactId: string;
    backupContentHash: `sha256:${string}`;
    procedureReference: string;
  }): Promise<{ providerEvidenceReference: string }>;
}

async function connectPostgres(connectionString: string): Promise<MigrationConnection> {
  const client = new Client({ connectionString });
  await client.connect();
  return {
    query: async (sql, parameters) => {
      const result = await client.query(sql, parameters);
      return { rows: result.rows as Array<Record<string, unknown>> };
    },
    close: async () => client.end(),
  };
}

function statementErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code ?? 'statement_failed');
    if (/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,254}$/.test(code)) return code;
  }
  return 'statement_failed';
}

class PostgresStagingMigrationSession implements SupabaseStagingMigrationSession {
  constructor(
    private readonly connection: MigrationConnection,
    private readonly targetIdentityHash: `sha256:${string}`,
    private readonly targetConnectionString: string,
    private readonly restoreExecutor?: StagingScratchRestoreExecutor,
  ) {}

  async inspectSchemaHash(): Promise<`sha256:${string}`> {
    await this.connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const catalog: SupabaseSchemaCatalog = {
        tables: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.tables)).rows,
        columns: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.columns)).rows,
        constraints: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.constraints)).rows,
        indexes: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.indexes)).rows,
        extensions: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.extensions)).rows,
        functions: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.functions)).rows,
        rlsPolicies: (await this.connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.rlsPolicies)).rows,
      };
      await this.connection.query('COMMIT');
      return buildSupabaseSchemaInventory(this.targetIdentityHash, catalog).inventoryHash;
    } catch {
      try { await this.connection.query('ROLLBACK'); } catch { /* the provider destroys this connection */ }
      throw new UnprocessableError(
        'Staging migration schema inspection failed inside the target fence',
        'DATABASE_STAGING_MIGRATION_SCHEMA_INSPECTION_FAILED',
      );
    }
  }

  async executeStatements(input: {
    migrationId: string;
    phase: 'apply' | 'rollback' | 'forward-fix';
    transactionMode: 'transactional' | 'non-transactional';
    statements: MigrationStatement[];
  }): Promise<MigrationStatementOutcome[]> {
    const outcomes: MigrationStatementOutcome[] = [];
    const transactional = input.transactionMode === 'transactional';
    if (transactional) await this.connection.query('BEGIN');
    try {
      for (const statement of input.statements) {
        try {
          await this.connection.query(statement.sql);
          outcomes.push({
            migrationId: input.migrationId,
            statementId: statement.statementId,
            contentHash: statement.contentHash,
            phase: input.phase,
            outcome: 'applied',
          });
        } catch (error) {
          outcomes.push({
            migrationId: input.migrationId,
            statementId: statement.statementId,
            contentHash: statement.contentHash,
            phase: input.phase,
            outcome: 'failed',
            errorCode: statementErrorCode(error),
          });
          throw error;
        }
      }
      if (transactional) await this.connection.query('COMMIT');
      return outcomes;
    } catch {
      if (transactional) {
        try { await this.connection.query('ROLLBACK'); } catch { /* the provider destroys this connection */ }
        for (const outcome of outcomes) {
          if (outcome.outcome === 'applied') outcome.outcome = 'rolled-back';
        }
      }
      throw new StagingMigrationStatementError(outcomes);
    }
  }

  async verify(input: {
    queries: MigrationVerificationQuery[];
    expectedSchemaHash: `sha256:${string}`;
  }): Promise<MigrationVerificationEvidence> {
    const outcomes: Array<z.infer<typeof QueryVerificationOutcomeSchema>> = [];
    await this.connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      for (const query of input.queries) {
        try {
          const rows = (await this.connection.query(query.sql)).rows;
          const actualResultHash = migrationVerificationResultHash(rows);
          outcomes.push({
            queryId: query.queryId,
            contentHash: query.contentHash,
            expectedResultHash: query.expectedResultHash,
            actualResultHash,
            passed: actualResultHash === query.expectedResultHash,
          });
        } catch {
          outcomes.push({
            queryId: query.queryId,
            contentHash: query.contentHash,
            expectedResultHash: query.expectedResultHash,
            actualResultHash: null,
            passed: false,
          });
        }
      }
      await this.connection.query('COMMIT');
    } catch {
      try { await this.connection.query('ROLLBACK'); } catch { /* the provider destroys this connection */ }
    }
    const actualSchemaHash = await this.inspectSchemaHash();
    const schemaPassed = actualSchemaHash === input.expectedSchemaHash;
    return MigrationVerificationEvidenceSchema.parse({
      queries: outcomes,
      expectedSchemaHash: input.expectedSchemaHash,
      actualSchemaHash,
      schemaPassed,
      passed: schemaPassed && outcomes.length === input.queries.length && outcomes.every((outcome) => outcome.passed),
    });
  }

  async restoreScratch(input: {
    backupArtifactId: string;
    backupContentHash: `sha256:${string}`;
    procedureReference: string;
  }): Promise<StagingRestoreActionOutcome> {
    if (!this.restoreExecutor) throw recoveryFailure('scratch_restore_executor_unavailable', 'scratch-restore');
    let evidence: { providerEvidenceReference: string };
    try {
      evidence = await this.restoreExecutor.restore({
        targetConnectionString: this.targetConnectionString,
        ...input,
      });
    } catch {
      throw recoveryFailure('scratch_restore_failed', 'scratch-restore');
    }
    return RestoreActionOutcomeSchema.parse({
      backupArtifactId: input.backupArtifactId,
      procedureReference: input.procedureReference,
      outcome: 'restored',
      providerEvidenceReference: evidence.providerEvidenceReference,
    });
  }
}

export class PostgresSupabaseStagingMigrationProvider implements SupabaseStagingMigrationProvider {
  private readonly connect: MigrationConnectionFactory;

  constructor(private readonly dependencies: {
    connect?: MigrationConnectionFactory;
    restoreExecutor?: StagingScratchRestoreExecutor;
  } = {}) {
    this.connect = dependencies.connect ?? connectPostgres;
  }

  async withFencedTarget<T>(input: {
    connectionString: string;
    fenceKey: string;
    binding: SupabaseDatabaseProviderBinding;
    targetIdentityHash: `sha256:${string}`;
  }, operation: (session: SupabaseStagingMigrationSession) => Promise<T>): Promise<T> {
    const connection = await this.connect(input.connectionString);
    let lockHeld = false;
    try {
      await connection.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [input.fenceKey]);
      lockHeld = true;
      const target = (await connection.query(
        'SELECT current_database() AS database_name, current_user AS database_role',
      )).rows[0];
      if (!target || target.database_name !== input.binding.databaseIdentity.databaseName) {
        throw preflightFailure('connected_database_mismatch');
      }
      if (databaseRoleFingerprint(String(target.database_role ?? '')) !== input.binding.roleProfile.roleFingerprint) {
        throw preflightFailure('connected_role_mismatch');
      }
      const session = new PostgresStagingMigrationSession(
        connection,
        input.targetIdentityHash,
        input.connectionString,
        this.dependencies.restoreExecutor,
      );
      return await operation(session);
    } finally {
      try { await connection.query('ROLLBACK'); } catch { /* close below discards session state */ }
      if (lockHeld) {
        try { await connection.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [input.fenceKey]); } catch { /* close releases it */ }
      }
      try { await connection.close(); } catch { /* no reusable authority remains */ }
    }
  }
}

export interface StagingMigrationOperationStart {
  operationId: string;
  idempotencyKey: string;
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  authorityGrantId: string;
  requestHash: `sha256:${string}`;
  manifestId: string;
  manifestDigest: `sha256:${string}`;
  targetIdentityHash: `sha256:${string}`;
}

export interface StagingMigrationOperationSnapshot {
  operationId: string;
  created: boolean;
  state: 'started' | 'succeeded' | 'recovered';
  requestHash: `sha256:${string}`;
  result?: SupabaseStagingMigrationReceipt;
}

export interface StagingMigrationHistoryEntry extends OrderedMigrationReference {
  operationId: string;
  manifestDigest: `sha256:${string}`;
  targetOrdinal: number;
  schemaHashAfter: `sha256:${string}`;
  statementOutcomes: MigrationStatementOutcome[];
  verification: MigrationVerificationEvidence;
  appliedAt: string;
}

export interface StagingMigrationAttemptEntry extends OrderedMigrationReference {
  operationId: string;
  manifestDigest: `sha256:${string}`;
  targetOrdinal: number;
  beforeSchemaHash: `sha256:${string}`;
  expectedSchemaHash: `sha256:${string}`;
  attemptedAt: string;
}

export interface StagingMigrationOperationStore {
  start(input: StagingMigrationOperationStart): Promise<StagingMigrationOperationSnapshot>;
  load(operationId: string): Promise<StagingMigrationOperationSnapshot | null>;
  loadTargetHistory(workspaceId: string, targetIdentityHash: `sha256:${string}`): Promise<StagingMigrationHistoryEntry[]>;
  loadMigrationAttempt(operationId: string, migrationId: string): Promise<StagingMigrationAttemptEntry | null>;
  recordMigrationAttempt(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    targetIdentityHash: `sha256:${string}`;
    entry: StagingMigrationAttemptEntry;
  }): Promise<void>;
  recordMigration(input: {
    workspaceId: string;
    bindingId: string;
    bindingGeneration: number;
    targetIdentityHash: `sha256:${string}`;
    entry: StagingMigrationHistoryEntry;
  }): Promise<void>;
  settle(receipt: SupabaseStagingMigrationReceipt): Promise<SupabaseStagingMigrationReceipt>;
}

interface OperationRow {
  id: string;
  state: string;
  request_hash: string;
  result_record: unknown;
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

function operationSnapshot(row: OperationRow, created: boolean): StagingMigrationOperationSnapshot {
  return {
    operationId: row.id,
    created,
    state: row.state as 'started' | 'succeeded' | 'recovered',
    requestHash: row.request_hash as `sha256:${string}`,
    ...(row.result_record ? { result: SupabaseStagingMigrationReceiptSchema.parse(row.result_record) } : {}),
  };
}

async function startStagingMigrationOperation(
  input: StagingMigrationOperationStart,
): Promise<StagingMigrationOperationSnapshot> {
  return runtimeTransaction(async (client) => {
    const grantResult = await client.query<GrantRow>(
      `SELECT id, workspace_id, binding_id, binding_generation, capability, risk_class,
              subject_hash, expires_at > clock_timestamp() AS unexpired,
              consumed_by_operation_id, revoked_at
         FROM rorca.database_authority_operation_grants
        WHERE id=$1 FOR UPDATE`,
      [input.authorityGrantId],
    );
    const grant = grantResult.rows[0];
    if (!grant
        || grant.workspace_id !== input.workspaceId
        || grant.binding_id !== input.bindingId
        || Number(grant.binding_generation) !== input.bindingGeneration
        || grant.capability !== 'database.migration.apply.staging'
        || grant.risk_class !== 'high'
        || grant.subject_hash !== input.requestHash
        || !grant.unexpired
        || grant.revoked_at
        || (grant.consumed_by_operation_id !== null && grant.consumed_by_operation_id !== input.operationId)) {
      throw new ForbiddenError('Exact unexpired staging migration authority grant is required', {
        reason: 'authority_grant_unauthorized',
      });
    }

    const inserted = await client.query(
      `INSERT INTO rorca.database_staging_migration_operations (
         id, workspace_id, binding_id, binding_generation, authority_grant_id,
         idempotency_key, request_hash, manifest_id, manifest_digest, target_identity_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [input.operationId, input.workspaceId, input.bindingId, input.bindingGeneration,
        input.authorityGrantId, input.idempotencyKey, input.requestHash, input.manifestId,
        input.manifestDigest, input.targetIdentityHash],
    );
    const result = await client.query<OperationRow>(
      `SELECT id, state, request_hash, result_record
         FROM rorca.database_staging_migration_operations
        WHERE id=$1
           OR (workspace_id=$2 AND idempotency_key=$3)
           OR (workspace_id=$2 AND target_identity_hash=$4 AND manifest_digest=$5)
        ORDER BY (id=$1) DESC LIMIT 1 FOR UPDATE`,
      [input.operationId, input.workspaceId, input.idempotencyKey, input.targetIdentityHash, input.manifestDigest],
    );
    const row = result.rows[0];
    if (!row || row.id !== input.operationId || row.request_hash !== input.requestHash) {
      throw new ConflictError('Staging migration manifest or idempotency key is already bound to another operation');
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
        throw new ForbiddenError('Staging migration authority grant could not be consumed exactly once', {
          reason: 'authority_grant_consumption_failed',
        });
      }
    }
    return operationSnapshot(row, inserted.rowCount === 1);
  });
}

async function loadStagingMigrationOperation(
  operationId: string,
): Promise<StagingMigrationOperationSnapshot | null> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<OperationRow>(
      'SELECT id, state, request_hash, result_record FROM rorca.database_staging_migration_operations WHERE id=$1',
      [operationId],
    );
    return result.rows[0] ? operationSnapshot(result.rows[0], false) : null;
  });
}

async function loadStagingTargetHistory(
  workspaceId: string,
  targetIdentityHash: `sha256:${string}`,
): Promise<StagingMigrationHistoryEntry[]> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<HistoryRow>(
      `SELECT operation_id, manifest_digest, migration_id, migration_content_hash,
              target_ordinal, schema_hash_after, statement_outcomes, verification, applied_at
         FROM rorca.database_staging_migration_history
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

function migrationAttemptFromRow(row: AttemptRow): StagingMigrationAttemptEntry {
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

async function loadStagingMigrationAttempt(
  operationId: string,
  migrationId: string,
): Promise<StagingMigrationAttemptEntry | null> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<AttemptRow>(
      `SELECT operation_id, manifest_digest, migration_id, migration_content_hash,
              target_ordinal, before_schema_hash, expected_schema_hash, attempted_at
         FROM rorca.database_staging_migration_attempts
        WHERE operation_id=$1 AND migration_id=$2`,
      [operationId, migrationId],
    );
    return result.rows[0] ? migrationAttemptFromRow(result.rows[0]) : null;
  });
}

async function recordStagingMigrationAttempt(input: {
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  targetIdentityHash: `sha256:${string}`;
  entry: StagingMigrationAttemptEntry;
}): Promise<void> {
  await runtimeTransaction(async (client) => {
    const operation = await client.query<OperationRow>(
      'SELECT id, state, request_hash, result_record FROM rorca.database_staging_migration_operations WHERE id=$1 FOR UPDATE',
      [input.entry.operationId],
    );
    if (operation.rows[0]?.state !== 'started') throw new ConflictError('Staging migration operation cannot cross a new apply boundary');
    await client.query(
      `INSERT INTO rorca.database_staging_migration_attempts (
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
         FROM rorca.database_staging_migration_attempts
        WHERE operation_id=$1 AND migration_id=$2`,
      [input.entry.operationId, input.entry.id],
    );
    if (!existing.rows[0] || !sameCanonicalValue(migrationAttemptFromRow(existing.rows[0]), input.entry)) {
      throw new ConflictError('Staging migration apply boundary conflicts with immutable manifest progress');
    }
  });
}

async function recordStagingMigration(input: {
  workspaceId: string;
  bindingId: string;
  bindingGeneration: number;
  targetIdentityHash: `sha256:${string}`;
  entry: StagingMigrationHistoryEntry;
}): Promise<void> {
  await runtimeTransaction(async (client) => {
    const operation = await client.query<OperationRow>(
      'SELECT id, state, request_hash, result_record FROM rorca.database_staging_migration_operations WHERE id=$1 FOR UPDATE',
      [input.entry.operationId],
    );
    if (operation.rows[0]?.state !== 'started') throw new ConflictError('Staging migration operation cannot accept progress');
    await client.query(
      `INSERT INTO rorca.database_staging_migration_history (
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
         FROM rorca.database_staging_migration_history
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
      throw new ConflictError('Staging migration history conflicts with immutable manifest progress');
    }
  });
}

async function settleStagingMigrationReceipt(
  receipt: SupabaseStagingMigrationReceipt,
): Promise<SupabaseStagingMigrationReceipt> {
  return runtimeTransaction(async (client) => {
    const result = await client.query<OperationRow>(
      'SELECT id, state, request_hash, result_record FROM rorca.database_staging_migration_operations WHERE id=$1 FOR UPDATE',
      [receipt.operationId],
    );
    const operation = result.rows[0];
    if (!operation || operation.request_hash !== receipt.requestHash) {
      throw new ConflictError('Staging migration operation subject changed');
    }
    if (operation.state !== 'started') return SupabaseStagingMigrationReceiptSchema.parse(operation.result_record);
    await client.query(
      `INSERT INTO rorca.authority_operation_receipts (
         id, workspace_id, binding_id, provider_id, capability, binding_generation,
         request_hash, target_identity_hash, result_hash, secret_reference_id,
         secret_reference_fingerprint, redacted_evidence
       ) VALUES ($1,$2,$3,'supabase-database','database.migration.apply.staging',$4,$5,$6,$7,$8,$9,$10)`,
      [receipt.receiptId, receipt.target.workspaceId, receipt.target.bindingId,
        receipt.target.bindingGeneration, receipt.requestHash, receipt.target.targetIdentityHash,
        receipt.resultHash, receipt.target.connectionReference.referenceId,
        receipt.target.connectionReference.fingerprint, receipt],
    );
    await client.query(
      `UPDATE rorca.database_staging_migration_operations
          SET state=$2, receipt_id=$3, before_schema_hash=$4, after_schema_hash=$5,
              result_record=$6, recovery_proof=$7, settled_at=$8
        WHERE id=$1 AND state='started'`,
      [receipt.operationId, receipt.status, receipt.receiptId, receipt.beforeSchemaHash,
        receipt.afterSchemaHash, receipt, receipt.recoveryProof, receipt.settledAt],
    );
    return receipt;
  });
}

export const databaseStagingMigrationOperationStore: StagingMigrationOperationStore = {
  start: startStagingMigrationOperation,
  load: loadStagingMigrationOperation,
  loadTargetHistory: loadStagingTargetHistory,
  recordMigration: recordStagingMigration,
  settle: settleStagingMigrationReceipt,
  loadMigrationAttempt: loadStagingMigrationAttempt,
  recordMigrationAttempt: recordStagingMigrationAttempt,
};

function validateHistory(
  history: StagingMigrationHistoryEntry[],
  request: SupabaseStagingMigrationRequest,
): number {
  const { baseHistory, migrations } = request.manifest;
  if (history.length < baseHistory.length) throw preflightFailure('missing_migrations');
  const baseIds = baseHistory.map((entry) => entry.id);
  const historyBaseIds = history.slice(0, baseHistory.length).map((entry) => entry.id);
  if (new Set([...baseIds, ...historyBaseIds]).size === baseIds.length
      && !sameCanonicalValue(baseIds, historyBaseIds)) {
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

function receiptEntryFromHistory(entry: StagingMigrationHistoryEntry, migration: StagingMigrationManifestEntry): StagingMigrationReceiptEntry {
  return {
    migrationId: entry.id,
    contentHash: entry.contentHash,
    ordinal: entry.targetOrdinal,
    transactionMode: migration.transactionMode as 'transactional' | 'non-transactional',
    statementOutcomes: entry.statementOutcomes,
    verification: entry.verification,
  };
}

function buildReceipt(input: {
  request: SupabaseStagingMigrationRequest;
  binding: SupabaseDatabaseProviderBinding;
  beforeSchemaHash: `sha256:${string}`;
  afterSchemaHash: `sha256:${string}`;
  status: 'succeeded' | 'recovered';
  migrations: StagingMigrationReceiptEntry[];
  recoveryProof: StagingMigrationRecoveryProof | null;
  settledAt: string;
}): SupabaseStagingMigrationReceipt {
  const reference = input.binding.secretReferences[0];
  const withoutResultHash = {
    version: 'rorca.staging-migration-receipt.v1' as const,
    receiptId: input.request.operationId,
    capability: 'database.migration.apply.staging' as const,
    operationId: input.request.operationId,
    requestHash: stagingMigrationSubjectHash(input.request),
    manifestId: input.request.manifest.manifestId,
    manifestDigest: input.request.manifestDigest,
    authorityGrantId: input.request.authorityGrant.grantId,
    target: {
      providerId: input.binding.providerId,
      bindingId: input.binding.bindingId,
      bindingGeneration: input.binding.bindingGeneration,
      workspaceId: input.binding.workspaceId,
      projectRef: input.binding.projectRef,
      environment: 'staging' as const,
      databaseIdentityHash: input.binding.databaseIdentityHash,
      targetIdentityHash: supabaseDatabaseTargetIdentityHash(input.binding),
      connectionReference: {
        referenceId: reference.referenceId,
        fingerprint: reference.fingerprint,
      },
    },
    beforeSchemaHash: input.beforeSchemaHash,
    afterSchemaHash: input.afterSchemaHash,
    status: input.status,
    migrations: input.migrations,
    recoveryProof: input.recoveryProof,
    settledAt: input.settledAt,
  };
  return SupabaseStagingMigrationReceiptSchema.parse({
    ...withoutResultHash,
    resultHash: digest(withoutResultHash),
  });
}

export interface SupabaseStagingMigrationAdapterDependencies {
  secretStore: DatabaseAuthoritySecretStore;
  provider?: SupabaseStagingMigrationProvider;
  operationStore?: StagingMigrationOperationStore;
  readBinding?: (bindingId: string) => Promise<SupabaseDatabaseProviderBinding | null>;
  now?: () => Date;
}

export class SupabaseDatabaseStagingMigrationAuthorityProviderAdapter {
  readonly capabilities = Object.freeze([
    'database.migration.apply.staging',
  ] as const satisfies readonly DatabaseAuthorityCapability[]);
  private readonly provider: SupabaseStagingMigrationProvider;
  private readonly store: StagingMigrationOperationStore;
  private readonly readBinding: (bindingId: string) => Promise<SupabaseDatabaseProviderBinding | null>;
  private readonly now: () => Date;

  constructor(private readonly dependencies: SupabaseStagingMigrationAdapterDependencies) {
    this.provider = dependencies.provider ?? new PostgresSupabaseStagingMigrationProvider();
    this.store = dependencies.operationStore ?? databaseStagingMigrationOperationStore;
    this.readBinding = dependencies.readBinding ?? readSupabaseDatabaseProviderBinding;
    this.now = dependencies.now ?? (() => new Date());
  }

  async execute(input: {
    operation: string;
    request: SupabaseStagingMigrationRequest;
  }): Promise<SupabaseStagingMigrationReceipt> {
    if (input.operation !== 'database.migration.apply.staging') {
      throw new ForbiddenError('Supabase staging migration authority cannot execute other database operations', {
        requiredCapability: 'database.migration.apply.staging',
      });
    }
    return this.applyStagingMigration(input.request);
  }

  async applyStagingMigration(rawRequest: SupabaseStagingMigrationRequest): Promise<SupabaseStagingMigrationReceipt> {
    const request = parseRequest(rawRequest);
    assertStagingMigrationManifest(request.manifest, request.manifestDigest);
    const now = this.now();
    assertGrant(request, now);
    const binding = await this.readBinding(request.target.bindingId);
    assertBinding(binding, request.target);
    const connectionString = await resolveConnection(this.dependencies.secretStore, binding);
    const targetIdentityHash = supabaseDatabaseTargetIdentityHash(binding);
    const operation = await this.store.start({
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      workspaceId: binding.workspaceId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.bindingGeneration,
      authorityGrantId: request.authorityGrant.grantId,
      requestHash: stagingMigrationSubjectHash(request),
      manifestId: request.manifest.manifestId,
      manifestDigest: request.manifestDigest,
      targetIdentityHash,
    });
    if (operation.state !== 'started') {
      if (!operation.result) throw new ConflictError('Settled staging migration operation is missing its receipt');
      return SupabaseStagingMigrationReceiptSchema.parse(operation.result);
    }

    return this.provider.withFencedTarget({
      connectionString,
      fenceKey: `supabase-staging-migration:${targetIdentityHash}`,
      binding,
      targetIdentityHash,
    }, async (session) => {
      const refreshed = await this.store.load(request.operationId);
      if (!refreshed) throw new ConflictError('Staging migration operation disappeared before target apply');
      if (refreshed.state !== 'started') {
        if (!refreshed.result) throw new ConflictError('Settled staging migration operation is missing its receipt');
        return refreshed.result;
      }

      let history = await this.store.loadTargetHistory(binding.workspaceId, targetIdentityHash);
      let progress = validateHistory(history, request);
      const pendingMigration = request.manifest.migrations[progress];
      const pendingAttempt = pendingMigration
        ? await this.store.loadMigrationAttempt(request.operationId, pendingMigration.id)
        : null;
      const actualAtFence = await session.inspectSchemaHash();
      const expectedAtProgress = progress === 0
        ? request.manifest.currentSchemaHash
        : request.manifest.migrations[progress - 1].expectedSchemaHash;

      if (actualAtFence !== expectedAtProgress) {
        const next = request.manifest.migrations[progress];
        const attemptedOrdinal = request.manifest.baseHistory.length + progress;
        if (!next
            || !pendingAttempt
            || pendingAttempt.operationId !== request.operationId
            || pendingAttempt.manifestDigest !== request.manifestDigest
            || pendingAttempt.id !== next.id
            || pendingAttempt.contentHash !== next.contentHash
            || pendingAttempt.targetOrdinal !== attemptedOrdinal
            || pendingAttempt.beforeSchemaHash !== expectedAtProgress
            || pendingAttempt.expectedSchemaHash !== next.expectedSchemaHash
            || actualAtFence !== next.expectedSchemaHash) {
          throw preflightFailure('schema_hash_drift');
        }
        const reconciliationVerification = await session.verify({
          queries: next.verificationQueries,
          expectedSchemaHash: next.expectedSchemaHash,
        });
        if (!reconciliationVerification.passed) throw preflightFailure('schema_hash_drift');
        const reconciledOutcomes: MigrationStatementOutcome[] = next.statements.map((statement) => ({
          migrationId: next.id,
          statementId: statement.statementId,
          contentHash: statement.contentHash,
          phase: 'apply',
          outcome: 'reconciled-applied',
        }));
        await this.store.recordMigration({
          workspaceId: binding.workspaceId,
          bindingId: binding.bindingId,
          bindingGeneration: binding.bindingGeneration,
          targetIdentityHash,
          entry: {
            operationId: request.operationId,
            manifestDigest: request.manifestDigest,
            id: next.id,
            contentHash: next.contentHash,
            targetOrdinal: request.manifest.baseHistory.length + progress,
            schemaHashAfter: next.expectedSchemaHash,
            statementOutcomes: reconciledOutcomes,
            verification: reconciliationVerification,
            appliedAt: this.now().toISOString(),
          },
        });
        history = await this.store.loadTargetHistory(binding.workspaceId, targetIdentityHash);
        progress = validateHistory(history, request);
      }

      const beforeSchemaHash = request.manifest.currentSchemaHash;
      const receiptEntries = history.slice(request.manifest.baseHistory.length)
        .map((entry, index) => receiptEntryFromHistory(entry, request.manifest.migrations[index]));

      for (let index = progress; index < request.manifest.migrations.length; index += 1) {
        const migration = request.manifest.migrations[index];
        const priorSchemaHash = index === 0
          ? request.manifest.currentSchemaHash
          : request.manifest.migrations[index - 1].expectedSchemaHash;
        let statementOutcomes: MigrationStatementOutcome[] = [];
        let verification: MigrationVerificationEvidence | null = null;
        await this.store.recordMigrationAttempt({
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
            beforeSchemaHash: priorSchemaHash,
            expectedSchemaHash: migration.expectedSchemaHash,
            attemptedAt: this.now().toISOString(),
          },
        });
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
          const failedEntry: StagingMigrationReceiptEntry = {
            migrationId: migration.id,
            contentHash: migration.contentHash,
            ordinal: request.manifest.baseHistory.length + index,
            transactionMode: migration.transactionMode as 'transactional' | 'non-transactional',
            statementOutcomes,
            verification,
          };
          receiptEntries.push(failedEntry);
          const recoveryProof = await this.recoverMigration(session, migration, priorSchemaHash);
          const receipt = buildReceipt({
            request,
            binding,
            beforeSchemaHash,
            afterSchemaHash: recoveryProof.resultingSchemaHash,
            status: 'recovered',
            migrations: receiptEntries,
            recoveryProof,
            settledAt: this.now().toISOString(),
          });
          return this.store.settle(receipt);
        }

        const historyEntry: StagingMigrationHistoryEntry = {
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
          targetIdentityHash,
          entry: historyEntry,
        });
        receiptEntries.push(receiptEntryFromHistory(historyEntry, migration));
      }

      const afterSchemaHash = await session.inspectSchemaHash();
      if (afterSchemaHash !== request.manifest.expectedFinalSchemaHash) throw preflightFailure('schema_hash_drift');
      const receipt = buildReceipt({
        request,
        binding,
        beforeSchemaHash,
        afterSchemaHash,
        status: 'succeeded',
        migrations: receiptEntries,
        recoveryProof: null,
        settledAt: this.now().toISOString(),
      });
      return this.store.settle(receipt);
    });
  }

  private async recoverMigration(
    session: SupabaseStagingMigrationSession,
    migration: StagingMigrationManifestEntry,
    priorSchemaHash: `sha256:${string}`,
  ): Promise<StagingMigrationRecoveryProof> {
    const recovery = migration.recovery;
    let statementOutcomes: MigrationStatementOutcome[] = [];
    let restoreOutcome: StagingRestoreActionOutcome | undefined;
    let verification: MigrationVerificationEvidence;

    try {
      if (recovery.classification === 'reversible') {
        statementOutcomes = await session.executeStatements({
          migrationId: migration.id,
          phase: 'rollback',
          transactionMode: 'transactional',
          statements: recovery.rollback.statements,
        });
        verification = await session.verify({
          queries: recovery.rollback.verificationQueries,
          expectedSchemaHash: recovery.rollback.expectedSchemaHash,
        });
        if (!verification.passed || verification.actualSchemaHash !== priorSchemaHash) {
          throw recoveryFailure('rollback_verification_failed', migration.id);
        }
        return RecoveryProofSchema.parse({
          classification: recovery.classification,
          strategy: 'rollback',
          failedMigrationId: migration.id,
          priorSchemaHash,
          resultingSchemaHash: verification.actualSchemaHash,
          statementOutcomes,
          verification,
        });
      }

      const procedure = recovery.procedure;
      if (procedure.strategy === 'forward-fix') {
        statementOutcomes = await session.executeStatements({
          migrationId: migration.id,
          phase: 'forward-fix',
          transactionMode: 'transactional',
          statements: procedure.statements,
        });
      } else {
        restoreOutcome = await session.restoreScratch({
          backupArtifactId: procedure.backupArtifactId,
          backupContentHash: recovery.backupEvidence.contentHash,
          procedureReference: procedure.procedureReference,
        });
      }
      verification = await session.verify({
        queries: procedure.verificationQueries,
        expectedSchemaHash: procedure.expectedSchemaHash,
      });
      if (!verification.passed) throw recoveryFailure('forward_only_recovery_verification_failed', migration.id);
      return RecoveryProofSchema.parse({
        classification: recovery.classification,
        strategy: procedure.strategy,
        failedMigrationId: migration.id,
        priorSchemaHash,
        resultingSchemaHash: verification.actualSchemaHash,
        statementOutcomes,
        ...(restoreOutcome ? { restoreOutcome } : {}),
        verification,
        backupEvidence: recovery.backupEvidence,
      });
    } catch (error) {
      if (error instanceof UnprocessableError && error.code === 'DATABASE_STAGING_MIGRATION_RECOVERY_FAILED') throw error;
      throw recoveryFailure('declared_recovery_procedure_failed', migration.id);
    }
  }
}
