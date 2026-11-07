/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ForbiddenError } from '../errors';
import {
  SupabaseDatabaseProductionMigrationAuthorityProviderAdapter,
  productionMigrationRecoveryPlanDigest,
  productionMigrationSubjectHash,
  productionMigrationTargetDigest,
  productionMigrationWindowDigest,
  type ProductionExternalGateDecision,
  type ProductionExternalGateVerifier,
  type ProductionMigrationAttemptEntry,
  type ProductionMigrationExternalGate,
  type ProductionMigrationAbortProof,
  type ProductionMigrationHistoryEntry,
  type ProductionMigrationOperationSnapshot,
  type ProductionMigrationOperationStart,
  type ProductionMigrationOperationStore,
  type ProductionMigrationTarget,
  type SupabaseProductionMigrationProvider,
  type SupabaseProductionMigrationRequest,
  type SupabaseProductionMigrationSession,
  type SupabaseProductionMigrationSubject,
} from '../supabase-database-production-migration-authority-provider-adapter';
import {
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  databaseRoleFingerprint,
  type SupabaseDatabaseProviderBinding,
} from '../supabase-database-authority-provider-adapter';
import {
  StagingMigrationStatementError,
  migrationVerificationResultHash,
  stagingMigrationEntryContentHash,
  stagingMigrationManifestDigest,
  stagingMigrationSqlHash,
  type MigrationStatement,
  type MigrationStatementOutcome,
  type MigrationVerificationEvidence,
  type MigrationVerificationQuery,
  type StagingMigrationManifest,
  type StagingMigrationManifestEntry,
} from '../supabase-database-migration-authority-provider-adapter';
import {
  databaseBackupSourceIdentityHash,
  type DatabaseBackupArtifactRecord,
} from '../supabase-database-backup-authority-provider-adapter';

const NOW = new Date('2026-08-21T14:00:00.000Z');
const CONNECTION = 'postgresql://production_operator:credential-bytes@db.production.fixture.supabase.co:5432/postgres?sslmode=require';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const MANIFEST_ID = '44444444-4444-4444-8444-444444444444';
const BACKUP_ID = '55555555-5555-4555-8555-555555555555';
const WINDOW_ID = '66666666-6666-4666-8666-666666666666';
const PLAN_ID = '77777777-7777-4777-8777-777777777777';
const GATE_ID = '88888888-8888-4888-8888-888888888888';
const INITIAL_SCHEMA_HASH = hash('a');
const APPLIED_SCHEMA_HASH = hash('b');
const FORWARD_FIXED_SCHEMA_HASH = hash('c');
const PARTIAL_SCHEMA_HASH = hash('d');
const ISSUER_AUTHORITY_HASH = hash('e');
const APPROVER_AUTHORITY_HASH = hash('f');

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const DATABASE_IDENTITY = {
  databaseName: 'postgres',
  endpointFingerprint: databaseEndpointFingerprint(CONNECTION),
};

function binding(): SupabaseDatabaseProviderBinding {
  const databaseIdentityHash = databaseResourceIdentityHash(DATABASE_IDENTITY);
  return {
    providerId: 'supabase-database',
    bindingId: BINDING_ID,
    workspaceId: 'workspace-production',
    bindingStatus: 'active',
    projectRef: 'production-fixture-project',
    environment: 'production',
    databaseIdentity: DATABASE_IDENTITY,
    databaseIdentityHash,
    bindingGeneration: 7,
    roleProfile: {
      roleFingerprint: databaseRoleFingerprint('migration_operator'),
      verified: true,
      verifiedAt: '2026-08-21T12:00:00.000Z',
      authenticationClass: 'database-role',
      capabilities: ['database.migration.apply.production'],
    },
    bindingHash: hash('a'),
    secretReferences: [{
      purpose: 'database-connection',
      referenceId: 'vault://database/production/migration-role',
      fingerprint: databaseCredentialFingerprint(CONNECTION),
      credentialClass: 'database-role',
    }],
  };
}

function statement(statementId: string, sql: string): MigrationStatement {
  return { statementId, sql, contentHash: stagingMigrationSqlHash(sql) };
}

function verificationQuery(
  queryId: string,
  sql = 'SELECT count(*)::text AS count FROM widgets',
): MigrationVerificationQuery {
  return {
    queryId,
    sql,
    contentHash: stagingMigrationSqlHash(sql),
    expectedResultHash: migrationVerificationResultHash([{ count: '1' }]),
  };
}

function reversibleMigration(): StagingMigrationManifestEntry {
  const statements = [statement('create-table', 'CREATE TABLE widgets (id bigint PRIMARY KEY)')];
  return {
    id: '202608211400_create_widgets',
    contentHash: stagingMigrationEntryContentHash({
      id: '202608211400_create_widgets',
      transactionMode: 'transactional',
      statements,
    }),
    prerequisites: [],
    transactionMode: 'transactional',
    statements,
    expectedSchemaHash: APPLIED_SCHEMA_HASH,
    verificationQueries: [verificationQuery('widgets-created')],
    recovery: {
      classification: 'reversible',
      rollback: {
        tested: true,
        statements: [statement('drop-table', 'DROP TABLE widgets')],
        expectedSchemaHash: INITIAL_SCHEMA_HASH,
        verificationQueries: [verificationQuery('widgets-removed', 'SELECT count(*)::text AS count FROM pg_class')],
      },
    },
  };
}

function forwardOnlyMigration(strategy: 'forward-fix' | 'scratch-restore'): StagingMigrationManifestEntry {
  const statements = [statement('alter-enum', "ALTER TYPE widget_state ADD VALUE 'archived'")];
  const recovery = strategy === 'forward-fix'
    ? {
        classification: 'forward-only' as const,
        backupEvidence: {
          artifactId: BACKUP_ID,
          contentHash: hash('b'),
          schemaHash: INITIAL_SCHEMA_HASH,
          verificationResult: 'passed' as const,
          verificationReference: 'evidence://backup/verified',
        },
        procedure: {
          strategy: 'forward-fix' as const,
          statements: [statement('add-compatibility-row', 'INSERT INTO migration_markers VALUES (1)')],
          expectedSchemaHash: FORWARD_FIXED_SCHEMA_HASH,
          verificationQueries: [verificationQuery('forward-fix-verified')],
        },
      }
    : {
        classification: 'forward-only' as const,
        backupEvidence: {
          artifactId: BACKUP_ID,
          contentHash: hash('b'),
          schemaHash: INITIAL_SCHEMA_HASH,
          verificationResult: 'passed' as const,
          verificationReference: 'evidence://backup/verified',
        },
        procedure: {
          strategy: 'scratch-restore' as const,
          backupArtifactId: BACKUP_ID,
          procedureReference: 'runbook://database/restore-production',
          expectedSchemaHash: INITIAL_SCHEMA_HASH,
          verificationQueries: [verificationQuery('restore-verified')],
        },
      };
  return {
    id: '202608211405_forward_only',
    contentHash: stagingMigrationEntryContentHash({
      id: '202608211405_forward_only',
      transactionMode: 'non-transactional',
      statements,
    }),
    prerequisites: [],
    transactionMode: 'non-transactional',
    statements,
    expectedSchemaHash: APPLIED_SCHEMA_HASH,
    verificationQueries: [verificationQuery('enum-updated')],
    recovery,
  };
}

function manifest(migration: StagingMigrationManifestEntry = reversibleMigration()): StagingMigrationManifest {
  return {
    version: 'rorca.staging-migration-manifest.v1',
    manifestId: MANIFEST_ID,
    currentSchemaHash: INITIAL_SCHEMA_HASH,
    baseHistory: [],
    migrations: [migration],
    expectedFinalSchemaHash: APPLIED_SCHEMA_HASH,
  };
}

function backupArtifact(): DatabaseBackupArtifactRecord {
  const targetBinding = binding();
  return {
    version: 'rorca.database-backup-artifact.v1',
    artifactId: BACKUP_ID,
    source: {
      providerId: 'supabase-database',
      bindingId: BINDING_ID,
      bindingGeneration: targetBinding.bindingGeneration,
      workspaceId: targetBinding.workspaceId,
      projectRef: targetBinding.projectRef,
      environment: 'production',
      databaseIdentity: targetBinding.databaseIdentity,
      databaseIdentityHash: targetBinding.databaseIdentityHash,
      sourceIdentityHash: databaseBackupSourceIdentityHash(targetBinding),
    },
    providerArtifactReference: 'supabase-backup://production/artifact-1',
    storageProviderId: 'rorca-fixture-storage',
    storageLocationReference: 's3://rorca-fixture/backups/artifact-1',
    contentHash: hash('b'),
    byteLength: 4096,
    schemaHash: INITIAL_SCHEMA_HASH,
    databaseVersion: 'PostgreSQL 16',
    encryption: {
      algorithm: 'AES-256-GCM',
      keyReferenceId: 'kms://rorca-fixture/backup-key',
      keyFingerprint: hash('c'),
      encrypted: true,
    },
    retention: {
      policy: 'production-change-window',
      retainUntil: '2026-09-21T14:00:00.000Z',
    },
    verification: {
      verified: true,
      verifiedContentHash: hash('b'),
      verifiedAt: '2026-08-21T13:30:00.000Z',
    },
    createdAt: '2026-08-21T13:00:00.000Z',
    recordHash: hash('d'),
  };
}

function noExternalGate(): ProductionMigrationExternalGate {
  return { required: false, policyDigest: hash('a') };
}

function independentGate(): ProductionMigrationExternalGate {
  return {
    required: true,
    gateId: GATE_ID,
    policyDigest: hash('a'),
    approvalDigest: hash('b'),
    approverAuthorityHash: APPROVER_AUTHORITY_HASH,
    evidenceReference: 'approval://production/gate-1',
    approvedAt: '2026-08-21T13:50:00.000Z',
    approvalExpiresAt: '2026-08-21T15:00:00.000Z',
  };
}

function subjectFor(options: {
  selectedManifest?: StagingMigrationManifest;
  backup?: DatabaseBackupArtifactRecord;
  gate?: ProductionMigrationExternalGate;
  operationId?: string;
  idempotencyKey?: string;
  opensAt?: string;
  closesAt?: string;
} = {}): SupabaseProductionMigrationSubject {
  const selectedManifest = options.selectedManifest ?? manifest();
  const manifestDigest = stagingMigrationManifestDigest(selectedManifest);
  const targetCore = {
    bindingId: BINDING_ID,
    workspaceId: 'workspace-production',
    projectRef: 'production-fixture-project',
    environment: 'production' as const,
    databaseIdentity: DATABASE_IDENTITY,
    bindingGeneration: 7,
  };
  const target: ProductionMigrationTarget = {
    ...targetCore,
    targetDigest: productionMigrationTargetDigest(targetCore),
  };
  const changeWindowCore = {
    windowId: WINDOW_ID,
    opensAt: options.opensAt ?? '2026-08-21T13:00:00.000Z',
    closesAt: options.closesAt ?? '2026-08-21T15:00:00.000Z',
  };
  const backup = options.backup ?? backupArtifact();
  const procedures = selectedManifest.migrations.map((migrationEntry) => ({
    migrationId: migrationEntry.id,
    classification: migrationEntry.recovery.classification,
    strategy: migrationEntry.recovery.classification === 'reversible'
      ? 'rollback' as const
      : migrationEntry.recovery.procedure.strategy === 'forward-fix'
        ? 'forward-fix' as const
        : 'restore' as const,
    evidenceReference: `runbook://database/recovery/${migrationEntry.id}`,
  }));
  const recoveryPlanCore = {
    planId: PLAN_ID,
    manifestDigest,
    backupRecordHash: backup.recordHash,
    verified: true as const,
    verifiedAt: '2026-08-21T13:40:00.000Z',
    verificationReference: 'evidence://production/recovery-plan',
    restorePolicyReference: 'policy://production/restore-reviewed',
    procedures,
  };
  return {
    operationId: options.operationId ?? OPERATION_ID,
    idempotencyKey: options.idempotencyKey ?? 'production-migration-1',
    target,
    manifest: selectedManifest,
    manifestDigest,
    backup,
    changeWindow: {
      ...changeWindowCore,
      windowDigest: productionMigrationWindowDigest(changeWindowCore),
    },
    healthAbortEvidence: {
      manifestDigest,
      targetDigest: target.targetDigest,
      health: {
        evidenceDigest: hash('b'),
        evidenceReference: 'evidence://production/health-checks',
        verified: true,
        verifiedAt: '2026-08-21T13:45:00.000Z',
      },
      abort: {
        evidenceDigest: hash('c'),
        evidenceReference: 'evidence://production/abort-criteria',
        verified: true,
        verifiedAt: '2026-08-21T13:45:00.000Z',
      },
    },
    recoveryOwner: {
      ownerId: 'database-oncall-primary',
      authorityHash: hash('d'),
      acknowledgementDigest: hash('e'),
      acknowledgedAt: '2026-08-21T13:45:00.000Z',
    },
    recoveryPlan: {
      ...recoveryPlanCore,
      planDigest: productionMigrationRecoveryPlanDigest(recoveryPlanCore),
    },
    externalGate: options.gate ?? noExternalGate(),
  };
}

function signedRequest(
  subject: SupabaseProductionMigrationSubject = subjectFor(),
  grantOverrides: Partial<SupabaseProductionMigrationRequest['authorityGrant']> = {},
): SupabaseProductionMigrationRequest {
  return {
    ...subject,
    authorityGrant: {
      grantId: GRANT_ID,
      capability: 'database.migration.apply.production',
      riskClass: 'critical',
      workspaceId: subject.target.workspaceId,
      bindingId: subject.target.bindingId,
      bindingGeneration: subject.target.bindingGeneration,
      subjectHash: productionMigrationSubjectHash(subject),
      issuerAuthorityHash: ISSUER_AUTHORITY_HASH,
      expiresAt: '2026-08-21T15:00:00.000Z',
      ...grantOverrides,
    },
  };
}

function verificationEvidence(
  queries: MigrationVerificationQuery[],
  expectedSchemaHash: `sha256:${string}`,
  actualSchemaHash: `sha256:${string}`,
): MigrationVerificationEvidence {
  const passed = actualSchemaHash === expectedSchemaHash;
  return {
    queries: queries.map((query) => ({
      queryId: query.queryId,
      contentHash: query.contentHash,
      expectedResultHash: query.expectedResultHash,
      actualResultHash: passed ? query.expectedResultHash : null,
      passed,
    })),
    expectedSchemaHash,
    actualSchemaHash,
    schemaPassed: passed,
    passed,
  };
}

class MemoryProductionMigrationStore implements ProductionMigrationOperationStore {
  snapshot: ProductionMigrationOperationSnapshot | null = null;
  history: ProductionMigrationHistoryEntry[] = [];
  readonly attempts = new Map<string, ProductionMigrationAttemptEntry>();
  waitCalls = 0;
  startCalls = 0;
  settleCalls = 0;
  consumedBy: string | null = null;
  failSettleOnce = false;
  grantSubjectHash: string | null = null;

  async wait(input: ProductionMigrationOperationStart): Promise<ProductionMigrationOperationSnapshot> {
    this.waitCalls += 1;
    this.assertGrant(input);
    if (!this.snapshot) {
      this.snapshot = {
        operationId: input.operationId,
        created: true,
        state: 'waiting',
        requestHash: input.requestHash,
        createdAt: NOW.toISOString(),
      };
    }
    return { ...this.snapshot };
  }

  async start(input: ProductionMigrationOperationStart): Promise<ProductionMigrationOperationSnapshot> {
    this.startCalls += 1;
    this.assertGrant(input);
    if (this.consumedBy && this.consumedBy !== input.operationId) {
      throw new ForbiddenError('Production grant replay rejected', { reason: 'authority_grant_unauthorized' });
    }
    this.consumedBy = input.operationId;
    if (!this.snapshot) {
      this.snapshot = {
        operationId: input.operationId,
        created: true,
        state: 'started',
        requestHash: input.requestHash,
        createdAt: NOW.toISOString(),
      };
    } else if (this.snapshot.operationId !== input.operationId || this.snapshot.requestHash !== input.requestHash) {
      throw new ForbiddenError('Production grant replay rejected', { reason: 'authority_grant_unauthorized' });
    } else if (this.snapshot.state === 'waiting') {
      this.snapshot = { ...this.snapshot, created: false, state: 'started' };
    }
    return { ...this.snapshot };
  }

  async load(operationId: string): Promise<ProductionMigrationOperationSnapshot | null> {
    return this.snapshot?.operationId === operationId ? { ...this.snapshot } : null;
  }

  async loadTargetHistory(): Promise<ProductionMigrationHistoryEntry[]> {
    return this.history.map((entry) => ({ ...entry }));
  }

  async loadMigrationAttempt(
    operationId: string,
    migrationId: string,
  ): Promise<ProductionMigrationAttemptEntry | null> {
    const attempt = this.attempts.get(`${operationId}:${migrationId}`);
    return attempt ? { ...attempt } : null;
  }

  async recordMigrationAttempt(input: { entry: ProductionMigrationAttemptEntry }): Promise<void> {
    const key = `${input.entry.operationId}:${input.entry.id}`;
    const current = this.attempts.get(key);
    if (current && JSON.stringify(current) !== JSON.stringify(input.entry)) {
      throw new ForbiddenError('Attempt subject changed');
    }
    this.attempts.set(key, { ...input.entry });
  }

  async recordMigration(input: { entry: ProductionMigrationHistoryEntry }): Promise<void> {
    const current = this.history.find((entry) => entry.id === input.entry.id);
    if (!current) this.history.push({ ...input.entry });
  }

  async recordAbortProof(
    operationId: string,
    proof: ProductionMigrationAbortProof,
  ): Promise<void> {
    if (!this.snapshot || this.snapshot.operationId !== operationId || this.snapshot.state !== 'started') {
      throw new ForbiddenError('Abort proof operation is not active');
    }
    if (this.snapshot.abortProof
        && JSON.stringify(this.snapshot.abortProof) !== JSON.stringify(proof)) {
      throw new ForbiddenError('Abort proof changed');
    }
    this.snapshot = { ...this.snapshot, abortProof: structuredClone(proof) };
  }

  async settle(receipt: Parameters<ProductionMigrationOperationStore['settle']>[0]) {
    this.settleCalls += 1;
    if (this.failSettleOnce) {
      this.failSettleOnce = false;
      throw new ForbiddenError('Fixture crash after durable abort proof');
    }
    this.snapshot = {
      operationId: receipt.operationId,
      created: false,
      state: receipt.status,
      requestHash: receipt.requestHash,
      createdAt: this.snapshot?.createdAt ?? NOW.toISOString(),
      result: receipt,
    };
    return receipt;
  }

  resumeStarted(request: SupabaseProductionMigrationRequest): void {
    this.snapshot = {
      operationId: request.operationId,
      created: false,
      state: 'started',
      requestHash: request.authorityGrant.subjectHash,
      createdAt: NOW.toISOString(),
    };
    this.consumedBy = request.operationId;
    this.grantSubjectHash = request.authorityGrant.subjectHash;
  }

  preloadAttempt(request: SupabaseProductionMigrationRequest): void {
    const migrationEntry = request.manifest.migrations[0];
    this.attempts.set(`${request.operationId}:${migrationEntry.id}`, {
      operationId: request.operationId,
      manifestDigest: request.manifestDigest,
      id: migrationEntry.id,
      contentHash: migrationEntry.contentHash,
      targetOrdinal: request.manifest.baseHistory.length,
      beforeSchemaHash: request.manifest.currentSchemaHash,
      expectedSchemaHash: migrationEntry.expectedSchemaHash,
      attemptedAt: '2026-08-21T13:55:00.000Z',
    });
  }

  private assertGrant(input: ProductionMigrationOperationStart): void {
    if (this.grantSubjectHash && this.grantSubjectHash !== input.requestHash) {
      throw new ForbiddenError('Production grant subject replay rejected', { reason: 'authority_grant_unauthorized' });
    }
    this.grantSubjectHash ??= input.requestHash;
  }
}

class FixtureProductionSession implements SupabaseProductionMigrationSession {
  readonly phases: Array<'apply' | 'rollback' | 'forward-fix' | 'restore'> = [];

  constructor(
    public schemaHash: `sha256:${string}` = INITIAL_SCHEMA_HASH,
    private readonly failApply = false,
  ) {}

  async inspectSchemaHash(): Promise<`sha256:${string}`> {
    return this.schemaHash;
  }

  async executeStatements(input: {
    migrationId: string;
    phase: 'apply' | 'rollback' | 'forward-fix';
    statements: MigrationStatement[];
  }): Promise<MigrationStatementOutcome[]> {
    this.phases.push(input.phase);
    if (input.phase === 'apply' && this.failApply) {
      this.schemaHash = PARTIAL_SCHEMA_HASH;
      throw new StagingMigrationStatementError(input.statements.map((entry) => ({
        migrationId: input.migrationId,
        statementId: entry.statementId,
        contentHash: entry.contentHash,
        phase: 'apply',
        outcome: 'failed',
        errorCode: 'FIXTURE_FAILURE',
      })));
    }
    this.schemaHash = input.phase === 'apply'
      ? APPLIED_SCHEMA_HASH
      : input.phase === 'rollback'
        ? INITIAL_SCHEMA_HASH
        : FORWARD_FIXED_SCHEMA_HASH;
    return input.statements.map((entry) => ({
      migrationId: input.migrationId,
      statementId: entry.statementId,
      contentHash: entry.contentHash,
      phase: input.phase,
      outcome: input.phase === 'rollback' ? 'rolled-back' : 'applied',
    }));
  }

  async verify(input: {
    queries: MigrationVerificationQuery[];
    expectedSchemaHash: `sha256:${string}`;
  }): Promise<MigrationVerificationEvidence> {
    return verificationEvidence(input.queries, input.expectedSchemaHash, this.schemaHash);
  }

  async restoreProduction(input: {
    artifact: DatabaseBackupArtifactRecord;
    procedureReference: string;
    restorePolicyReference: string;
  }) {
    this.phases.push('restore');
    this.schemaHash = input.artifact.schemaHash as `sha256:${string}`;
    return {
      backupArtifactId: input.artifact.artifactId,
      backupRecordHash: input.artifact.recordHash as `sha256:${string}`,
      procedureReference: input.procedureReference,
      restorePolicyReference: input.restorePolicyReference,
      outcome: 'restored' as const,
      providerEvidenceReference: 'evidence://production/restore-complete',
    };
  }
}

class FixtureProductionProvider implements SupabaseProductionMigrationProvider {
  calls = 0;

  constructor(readonly session: FixtureProductionSession) {}

  async withFencedTarget<T>(
    _input: unknown,
    operation: (session: SupabaseProductionMigrationSession) => Promise<T>,
  ): Promise<T> {
    this.calls += 1;
    return operation(this.session);
  }
}

class MutableGateVerifier implements ProductionExternalGateVerifier {
  decision: ProductionExternalGateDecision = { status: 'waiting' };

  async verify(): Promise<ProductionExternalGateDecision> {
    return this.decision;
  }
}

function adapter(options: {
  store?: MemoryProductionMigrationStore;
  session?: FixtureProductionSession;
  gateVerifier?: ProductionExternalGateVerifier;
  healthAbort?: boolean;
  artifact?: DatabaseBackupArtifactRecord | null;
} = {}) {
  const store = options.store ?? new MemoryProductionMigrationStore();
  const provider = new FixtureProductionProvider(options.session ?? new FixtureProductionSession());
  const artifact = options.artifact === undefined ? backupArtifact() : options.artifact;
  return {
    store,
    provider,
    adapter: new SupabaseDatabaseProductionMigrationAuthorityProviderAdapter({
      secretStore: { resolveDatabaseConnection: async () => CONNECTION },
      provider,
      operationStore: store,
      backupStore: { loadBackupArtifact: async () => artifact },
      readBinding: async () => binding(),
      now: () => NOW,
      externalGateVerifier: options.gateVerifier,
      ...(options.healthAbort
        ? { healthMonitor: { check: async () => ({ status: 'abort' as const, reasonCode: 'fixture_abort' }) } }
        : {}),
    }),
  };
}

function errorReason(error: unknown, reason: string): boolean {
  return error instanceof AppError && error.details?.reason === reason;
}

test('production preflight rejects missing/changed backup, manifest/schema drift, closed window, invalid gate, expiry, and recovery drift', async () => {
  const valid = signedRequest();
  await assert.rejects(
    adapter({ artifact: null }).adapter.applyProductionMigration(valid),
    (error: unknown) => errorReason(error, 'backup_missing'),
  );

  const changedBackup = structuredClone(valid);
  changedBackup.backup.recordHash = hash('f');
  changedBackup.recoveryPlan.backupRecordHash = changedBackup.backup.recordHash;
  changedBackup.recoveryPlan.planDigest = productionMigrationRecoveryPlanDigest(changedBackup.recoveryPlan);
  changedBackup.authorityGrant.subjectHash = productionMigrationSubjectHash(changedBackup);
  await assert.rejects(
    adapter().adapter.applyProductionMigration(changedBackup),
    (error: unknown) => errorReason(error, 'backup_verification_failed'),
  );

  const changedManifest = structuredClone(valid);
  changedManifest.manifest.migrations[0].statements[0].sql = 'CREATE TABLE changed (id bigint)';
  changedManifest.authorityGrant.subjectHash = productionMigrationSubjectHash(changedManifest);
  await assert.rejects(
    adapter().adapter.applyProductionMigration(changedManifest),
    (error: unknown) => errorReason(error, 'manifest_digest_mismatch'),
  );

  await assert.rejects(
    adapter({ session: new FixtureProductionSession(PARTIAL_SCHEMA_HASH) }).adapter.applyProductionMigration(valid),
    (error: unknown) => errorReason(error, 'schema_hash_drift'),
  );

  const closedWindow = signedRequest(subjectFor({
    opensAt: '2026-08-21T12:00:00.000Z',
    closesAt: '2026-08-21T13:00:00.000Z',
  }));
  await assert.rejects(
    adapter().adapter.applyProductionMigration(closedWindow),
    (error: unknown) => errorReason(error, 'change_window_closed'),
  );

  const gateRequest = signedRequest(subjectFor({ gate: independentGate() }));
  const invalidGate = new MutableGateVerifier();
  invalidGate.decision = {
    status: 'approved',
    gateId: GATE_ID,
    approvalDigest: hash('f'),
    approverAuthorityHash: APPROVER_AUTHORITY_HASH,
    evidenceReference: 'approval://production/gate-1',
    approvedAt: '2026-08-21T13:50:00.000Z',
  };
  await assert.rejects(
    adapter({ gateVerifier: invalidGate }).adapter.applyProductionMigration(gateRequest),
    (error: unknown) => errorReason(error, 'invalid_external_gate'),
  );

  const expired = signedRequest(subjectFor(), { expiresAt: '2026-08-21T13:59:59.000Z' });
  await assert.rejects(
    adapter().adapter.applyProductionMigration(expired),
    (error: unknown) => errorReason(error, 'grant_expired'),
  );

  const recoveryDrift = structuredClone(valid);
  recoveryDrift.recoveryPlan.procedures[0].evidenceReference = 'runbook://database/recovery/changed';
  recoveryDrift.authorityGrant.subjectHash = productionMigrationSubjectHash(recoveryDrift);
  await assert.rejects(
    adapter().adapter.applyProductionMigration(recoveryDrift),
    (error: unknown) => errorReason(error, 'recovery_plan_unverified'),
  );
});

test('deployment and production-migration grants are non-interchangeable', async () => {
  const request = signedRequest();
  const fixture = adapter();
  await assert.rejects(
    fixture.adapter.execute({ operation: 'deployment.apply', request }),
    (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
  );

  const deployGrantFixture = {
    ...structuredClone(request),
    authorityGrant: { ...request.authorityGrant, capability: 'deployment.apply' },
  };
  const deployGrant = deployGrantFixture as unknown as SupabaseProductionMigrationRequest;
  await assert.rejects(
    fixture.adapter.execute({ operation: 'database.migration.apply.production', request: deployGrant }),
    (error: unknown) => errorReason(error, 'request_invalid'),
  );
  assert.equal(fixture.store.startCalls, 0);
  assert.equal(fixture.provider.calls, 0);
});

test('grant digest binds the exact backup, manifest, target, window, evidence, and recovery owner', () => {
  const subject = subjectFor();
  const baseline = productionMigrationSubjectHash(subject);
  const variants = [
    (() => { const value = structuredClone(subject); value.backup.contentHash = hash('f'); return value; })(),
    (() => { const value = structuredClone(subject); value.manifest.expectedFinalSchemaHash = hash('f'); return value; })(),
    (() => { const value = structuredClone(subject); value.target.projectRef = 'changed-project'; return value; })(),
    (() => { const value = structuredClone(subject); value.changeWindow.closesAt = '2026-08-21T14:30:00.000Z'; return value; })(),
    (() => { const value = structuredClone(subject); value.healthAbortEvidence.abort.evidenceDigest = hash('f'); return value; })(),
    (() => { const value = structuredClone(subject); value.recoveryOwner.ownerId = 'different-owner'; return value; })(),
  ];
  for (const variant of variants) assert.notEqual(productionMigrationSubjectHash(variant), baseline);
  assert.equal(productionMigrationSubjectHash(signedRequest(subject)), baseline);
});

test('independent external gate WAITING is durable, immediate, unconsumed, and resumes the exact subject', async () => {
  const request = signedRequest(subjectFor({ gate: independentGate() }));
  const verifier = new MutableGateVerifier();
  const fixture = adapter({ gateVerifier: verifier });

  const waiting = await fixture.adapter.applyProductionMigration(request);
  assert.equal(waiting.status, 'waiting');
  assert.equal(fixture.store.waitCalls, 1);
  assert.equal(fixture.store.startCalls, 0);
  assert.equal(fixture.store.consumedBy, null);
  assert.equal(fixture.provider.calls, 0);

  verifier.decision = {
    status: 'approved',
    gateId: GATE_ID,
    approvalDigest: hash('b'),
    approverAuthorityHash: APPROVER_AUTHORITY_HASH,
    evidenceReference: 'approval://production/gate-1',
    approvedAt: '2026-08-21T13:50:00.000Z',
  };
  const settled = await fixture.adapter.applyProductionMigration(request);
  assert.equal(settled.status, 'succeeded');
  assert.equal(fixture.store.consumedBy, request.operationId);
  assert.equal(fixture.provider.calls, 1);
});

test('crashes before, during, and after apply reconcile schema/history without double apply', async () => {
  const request = signedRequest();

  const beforeStore = new MemoryProductionMigrationStore();
  beforeStore.resumeStarted(request);
  const beforeSession = new FixtureProductionSession(INITIAL_SCHEMA_HASH);
  const before = adapter({ store: beforeStore, session: beforeSession });
  const beforeReceipt = await before.adapter.applyProductionMigration(request);
  assert.equal(beforeReceipt.status, 'succeeded');
  assert.deepEqual(beforeSession.phases, ['apply']);

  const afterStore = new MemoryProductionMigrationStore();
  afterStore.resumeStarted(request);
  afterStore.preloadAttempt(request);
  const afterSession = new FixtureProductionSession(APPLIED_SCHEMA_HASH);
  const after = adapter({ store: afterStore, session: afterSession });
  const afterReceipt = await after.adapter.applyProductionMigration(request);
  assert.equal(afterReceipt.status, 'succeeded');
  assert.deepEqual(afterSession.phases, []);
  assert.equal(afterReceipt.migrations[0].statementOutcomes[0].outcome, 'reconciled-applied');

  const duringStore = new MemoryProductionMigrationStore();
  duringStore.resumeStarted(request);
  duringStore.preloadAttempt(request);
  const duringSession = new FixtureProductionSession(PARTIAL_SCHEMA_HASH);
  const during = adapter({ store: duringStore, session: duringSession });
  const duringReceipt = await during.adapter.applyProductionMigration(request);
  assert.equal(duringReceipt.status, 'aborted');
  assert.deepEqual(duringSession.phases, ['rollback']);
  assert.equal(duringReceipt.finalConsistency.schemaHash, INITIAL_SCHEMA_HASH);

  const callsBeforeReplay = after.provider.calls;
  const replay = await after.adapter.applyProductionMigration(request);
  assert.equal(replay.status, 'succeeded');
  assert.equal(after.provider.calls, callsBeforeReplay);

  const competing = signedRequest(subjectFor({
    operationId: '99999999-9999-4999-8999-999999999999',
    idempotencyKey: 'production-migration-2',
  }));
  await assert.rejects(

    after.adapter.applyProductionMigration(competing),
    (error: unknown) => errorReason(error, 'authority_grant_unauthorized'),
  );
});
test('crash after abort proof reconciles final consistency without repeating recovery', async () => {
  const request = signedRequest();
  const store = new MemoryProductionMigrationStore();
  const session = new FixtureProductionSession(INITIAL_SCHEMA_HASH, true);
  store.failSettleOnce = true;
  const fixture = adapter({ store, session });

  await assert.rejects(
    fixture.adapter.applyProductionMigration(request),
    /Fixture crash after durable abort proof/,
  );
  assert.deepEqual(session.phases, ['apply', 'rollback']);
  assert.equal(store.snapshot?.state, 'started');
  assert.equal(store.snapshot?.abortProof?.resultingSchemaHash, INITIAL_SCHEMA_HASH);

  const receipt = await fixture.adapter.applyProductionMigration(request);
  assert.equal(receipt.status, 'aborted');
  assert.equal(receipt.finalConsistency.schemaHash, INITIAL_SCHEMA_HASH);
  assert.deepEqual(session.phases, ['apply', 'rollback']);
  assert.equal(store.settleCalls, 2);
});

test('abort executes and records reversible rollback, forward-fix, and reviewed restore consistency', async () => {
  const cases: Array<{
    migration: StagingMigrationManifestEntry;
    expectedStrategy: 'rollback' | 'forward-fix' | 'restore';
    expectedSchemaHash: `sha256:${string}`;
    expectedPhase: 'rollback' | 'forward-fix' | 'restore';
  }> = [
    {
      migration: reversibleMigration(),
      expectedStrategy: 'rollback',
      expectedSchemaHash: INITIAL_SCHEMA_HASH,
      expectedPhase: 'rollback',
    },
    {
      migration: forwardOnlyMigration('forward-fix'),
      expectedStrategy: 'forward-fix',
      expectedSchemaHash: FORWARD_FIXED_SCHEMA_HASH,
      expectedPhase: 'forward-fix',
    },
    {
      migration: forwardOnlyMigration('scratch-restore'),
      expectedStrategy: 'restore',
      expectedSchemaHash: INITIAL_SCHEMA_HASH,
      expectedPhase: 'restore',
    },
  ];

  for (const fixtureCase of cases) {
    const request = signedRequest(subjectFor({ selectedManifest: manifest(fixtureCase.migration) }));
    const session = new FixtureProductionSession(INITIAL_SCHEMA_HASH, true);
    const fixture = adapter({ session });
    const receipt = await fixture.adapter.applyProductionMigration(request);
    assert.equal(receipt.status, 'aborted');
    assert.equal(receipt.abortProof?.strategy, fixtureCase.expectedStrategy);
    assert.equal(receipt.afterSchemaHash, fixtureCase.expectedSchemaHash);
    assert.equal(receipt.finalConsistency.verified, true);
    assert.equal(receipt.finalConsistency.schemaHash, fixtureCase.expectedSchemaHash);
    assert.deepEqual(session.phases, ['apply', fixtureCase.expectedPhase]);
    assert.equal(fixture.store.settleCalls, 1);
    assert.doesNotMatch(JSON.stringify(receipt), /credential-bytes|production_operator/);
  }
});

test('health abort uses the exact declared recovery procedure before settling consistency', async () => {
  const session = new FixtureProductionSession();
  const fixture = adapter({ session, healthAbort: true });
  const receipt = await fixture.adapter.applyProductionMigration(signedRequest());
  assert.equal(receipt.status, 'aborted');
  assert.equal(receipt.abortProof?.trigger, 'health-abort');
  assert.equal(receipt.abortProof?.strategy, 'rollback');
  assert.deepEqual(session.phases, ['apply', 'rollback']);
  assert.equal(receipt.finalConsistency.schemaHash, INITIAL_SCHEMA_HASH);
});
