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
  DatabaseBackupArtifactRecordSchema,
  SupabaseDatabaseBackupAuthorityProviderAdapter,
  SupabaseDatabaseRestoreAuthorityProviderAdapter,
  databaseBackupCreateSubjectHash,
  databaseBackupRestoreSubjectHash,
  restoreTargetIdentityHash,
  type BackupProviderEvidence,
  type CleanupRequiredEvidence,
  type DatabaseAuthorityOperationSnapshot,
  type DatabaseAuthorityOperationStart,
  type DatabaseBackupArtifactRecord,
  type DatabaseBackupCreateReceipt,
  type DatabaseBackupRestoreOperationReceipt,
  type DatabaseBackupRestoreOperationStore,
  type RestoreVerificationEvidence,
  type SupabaseBackupCreateRequest,
  type SupabaseBackupCreateSubject,
  type SupabaseBackupProvider,
  type SupabaseBackupRestoreRequest,
  type SupabaseBackupRestoreSubject,
  type SupabaseRestoreProvider,
} from '../supabase-database-backup-authority-provider-adapter';
import {
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  databaseRoleFingerprint,
  type DatabaseAuthorityCapability,
  type SupabaseDatabaseProviderBinding,
} from '../supabase-database-authority-provider-adapter';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const SOURCE_CONNECTION = 'postgresql://backup_operator:credential-bytes@db.source.fixture.supabase.co:5432/postgres?sslmode=require';
const TARGET_CONNECTION = 'postgresql://restore_operator:other-credential-bytes@db.scratch.fixture.supabase.co:5432/postgres?sslmode=require';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const SOURCE_DATABASE_IDENTITY = {
  databaseName: 'postgres',
  endpointFingerprint: databaseEndpointFingerprint(SOURCE_CONNECTION),
};
const TARGET_DATABASE_IDENTITY = {
  databaseName: 'restore_scratch',
  endpointFingerprint: databaseEndpointFingerprint(TARGET_CONNECTION),
};

function binding(capability: DatabaseAuthorityCapability): SupabaseDatabaseProviderBinding {
  return {
    providerId: 'supabase-database',
    bindingId: BINDING_ID,
    workspaceId: 'rorca-fixture',
    bindingStatus: 'active',
    projectRef: 'rorca-owned-source',
    environment: 'staging',
    databaseIdentity: SOURCE_DATABASE_IDENTITY,
    databaseIdentityHash: databaseResourceIdentityHash(SOURCE_DATABASE_IDENTITY),
    bindingGeneration: 7,
    roleProfile: {
      roleFingerprint: databaseRoleFingerprint('backup_operator'),
      verified: true,
      verifiedAt: '2026-08-21T11:00:00.000Z',
      authenticationClass: 'database-role',
      capabilities: [capability],
    },
    bindingHash: hash('1'),
    secretReferences: [{
      purpose: 'database-connection',
      referenceId: 'secret-store://rorca-fixture/database/source/v7',
      fingerprint: databaseCredentialFingerprint(SOURCE_CONNECTION),
      credentialClass: 'database-role',
    }],
  };
}

function sourceScope() {
  return {
    bindingId: BINDING_ID,
    workspaceId: 'rorca-fixture',
    projectRef: 'rorca-owned-source',
    environment: 'staging' as const,
    databaseIdentity: SOURCE_DATABASE_IDENTITY,
    bindingGeneration: 7,
  };
}

function backupSubject(): SupabaseBackupCreateSubject {
  return {
    operationId: OPERATION_ID,
    idempotencyKey: 'backup-fixture-20260821',
    source: sourceScope(),
    artifactId: ARTIFACT_ID,
    storageProviderId: 'fixture-object-store',
    storageLocationReference: `s3://rorca-backups/${ARTIFACT_ID}.dump`,
    encryption: {
      algorithm: 'AES-256-GCM',
      keyReferenceId: 'secret-store://rorca-fixture/backup-encryption/v3',
      keyFingerprint: hash('2'),
    },
    retention: {
      policy: 'scratch-drill-30d',
      retainUntil: '2026-09-20T12:00:00.000Z',
    },
    expectedSchemaHash: hash('3'),
  };
}

function backupRequest(): SupabaseBackupCreateRequest {
  const subject = backupSubject();
  return {
    ...subject,
    authorityGrant: {
      grantId: GRANT_ID,
      capability: 'database.backup.create',
      riskClass: 'elevated',
      workspaceId: subject.source.workspaceId,
      bindingId: subject.source.bindingId,
      bindingGeneration: subject.source.bindingGeneration,
      subjectHash: databaseBackupCreateSubjectHash(subject),
      expiresAt: '2026-08-21T12:10:00.000Z',
    },
  };
}

function backupEvidence(): BackupProviderEvidence {
  const subject = backupSubject();
  return {
    artifactId: subject.artifactId,
    providerArtifactReference: `supabase-backup://rorca-owned-source/${subject.artifactId}`,
    storageProviderId: subject.storageProviderId,
    storageLocationReference: subject.storageLocationReference,
    contentHash: hash('4'),
    byteLength: 4096,
    schemaHash: subject.expectedSchemaHash,
    databaseVersion: 'PostgreSQL 16.4',
    encryption: {
      ...subject.encryption,
      encrypted: true,
    },
    verification: {
      verified: true,
      verifiedContentHash: hash('4'),
      verifiedAt: '2026-08-21T12:01:00.000Z',
    },
    createdAt: '2026-08-21T12:00:30.000Z',
  };
}

function storedArtifact(overrides: Partial<DatabaseBackupArtifactRecord> = {}): DatabaseBackupArtifactRecord {
  const record: DatabaseBackupArtifactRecord = {
    version: 'rorca.database-backup-artifact.v1',
    artifactId: ARTIFACT_ID,
    source: {
      providerId: 'supabase-database',
      bindingId: BINDING_ID,
      bindingGeneration: 7,
      workspaceId: 'rorca-fixture',
      projectRef: 'rorca-owned-source',
      environment: 'staging',
      databaseIdentity: SOURCE_DATABASE_IDENTITY,
      databaseIdentityHash: databaseResourceIdentityHash(SOURCE_DATABASE_IDENTITY),
      sourceIdentityHash: hash('5'),
    },
    providerArtifactReference: `supabase-backup://rorca-owned-source/${ARTIFACT_ID}`,
    storageProviderId: 'fixture-object-store',
    storageLocationReference: `s3://rorca-backups/${ARTIFACT_ID}.dump`,
    contentHash: hash('4'),
    byteLength: 4096,
    schemaHash: hash('3'),
    databaseVersion: 'PostgreSQL 16.4',
    encryption: {
      algorithm: 'AES-256-GCM',
      keyReferenceId: 'secret-store://rorca-fixture/backup-encryption/v3',
      keyFingerprint: hash('2'),
      encrypted: true,
    },
    retention: {
      policy: 'scratch-drill-30d',
      retainUntil: '2026-09-20T12:00:00.000Z',
    },
    verification: {
      verified: true,
      verifiedContentHash: hash('4'),
      verifiedAt: '2026-08-21T12:01:00.000Z',
    },
    createdAt: '2026-08-21T12:00:30.000Z',
    recordHash: hash('6'),
    ...overrides,
  };
  return DatabaseBackupArtifactRecordSchema.parse(record);
}

function restoreSubject(artifact: DatabaseBackupArtifactRecord = storedArtifact()): SupabaseBackupRestoreSubject {
  const target = {
    projectRef: 'rorca-owned-scratch',
    environment: 'scratch' as const,
    databaseIdentity: TARGET_DATABASE_IDENTITY,
    connectionReferenceId: 'secret-store://rorca-fixture/database/restore-scratch/v2',
    connectionFingerprint: databaseCredentialFingerprint(TARGET_CONNECTION),
    verifiedAt: '2026-08-21T11:55:00.000Z',
    verificationExpiresAt: '2026-08-21T12:05:00.000Z',
  };
  return {
    operationId: OPERATION_ID,
    idempotencyKey: 'restore-fixture-20260821',
    source: sourceScope(),
    artifactId: artifact.artifactId,
    expectedArtifactHash: artifact.recordHash,
    target: { ...target, targetIdentityHash: restoreTargetIdentityHash(target) },
    expectedDataChecks: [
      { checkId: 'tenant-row-count', expectedHash: hash('7') },
      { checkId: 'seed-records', expectedHash: hash('8') },
    ],
  };
}

function restoreRequest(artifact: DatabaseBackupArtifactRecord = storedArtifact()): SupabaseBackupRestoreRequest {
  const subject = restoreSubject(artifact);
  return {
    ...subject,
    authorityGrant: {
      grantId: GRANT_ID,
      capability: 'database.backup.restore',
      riskClass: 'high',
      workspaceId: subject.source.workspaceId,
      bindingId: subject.source.bindingId,
      bindingGeneration: subject.source.bindingGeneration,
      subjectHash: databaseBackupRestoreSubjectHash(subject),
      expiresAt: '2026-08-21T12:03:00.000Z',
    },
  };
}

function restoreVerification(): RestoreVerificationEvidence {
  return {
    schemaHash: hash('3'),
    dataChecks: [
      { checkId: 'tenant-row-count', actualHash: hash('7'), passed: true },
      { checkId: 'seed-records', actualHash: hash('8'), passed: true },
    ],
    providerVerificationReference: `supabase-restore-check://rorca-owned-scratch/${OPERATION_ID}`,
    verifiedAt: '2026-08-21T12:02:00.000Z',
  };
}

class MemoryOperationStore implements DatabaseBackupRestoreOperationStore {
  artifact: DatabaseBackupArtifactRecord | null;
  snapshot: DatabaseAuthorityOperationSnapshot | null = null;
  startCalls = 0;
  resumeCalls = 0;
  backupSettlements: DatabaseBackupCreateReceipt[] = [];
  restoreSettlements: DatabaseBackupRestoreOperationReceipt[] = [];
  cleanupRecords: CleanupRequiredEvidence[] = [];
  readonly authorizedGrantId: string;

  constructor(artifact: DatabaseBackupArtifactRecord | null = null, authorizedGrantId = GRANT_ID) {
    this.artifact = artifact;
    this.authorizedGrantId = authorizedGrantId;
  }

  async start(input: DatabaseAuthorityOperationStart): Promise<DatabaseAuthorityOperationSnapshot> {
    this.startCalls += 1;
    if (input.authorityGrantId !== this.authorizedGrantId) {
      throw new ForbiddenError('Exact unexpired database authority grant is required', {
        reason: 'authority_grant_unauthorized',
      });
    }
    if (this.snapshot) {
      assert.equal(this.snapshot.operationId, input.operationId);
      assert.equal(this.snapshot.requestHash, input.requestHash);
      return { ...this.snapshot, created: false };
    }
    this.snapshot = {
      operationId: input.operationId,
      requestHash: input.requestHash,
      state: 'started',
      created: true,
    };
    return this.snapshot;
  }

  async resume(input: DatabaseAuthorityOperationStart): Promise<DatabaseAuthorityOperationSnapshot | null> {
    this.resumeCalls += 1;
    if (!this.snapshot) return null;
    if (input.authorityGrantId !== this.authorizedGrantId) {
      throw new ForbiddenError('Exact consumed database authority grant is required', {
        reason: 'authority_grant_unauthorized',
      });
    }
    assert.equal(this.snapshot.operationId, input.operationId);
    assert.equal(this.snapshot.requestHash, input.requestHash);
    return { ...this.snapshot, created: false };
  }

  async loadBackupArtifact(artifactId: string): Promise<DatabaseBackupArtifactRecord | null> {
    return this.artifact?.artifactId === artifactId ? this.artifact : null;
  }

  async settleBackup(receipt: DatabaseBackupCreateReceipt): Promise<DatabaseBackupCreateReceipt> {
    this.backupSettlements.push(receipt);
    this.artifact = receipt.artifact;
    this.snapshot = {
      operationId: receipt.operationId,
      requestHash: receipt.requestHash,
      state: 'succeeded',
      created: false,
      result: receipt,
    };
    return receipt;
  }

  async settleRestore(receipt: DatabaseBackupRestoreOperationReceipt): Promise<DatabaseBackupRestoreOperationReceipt> {
    this.restoreSettlements.push(receipt);
    this.snapshot = {
      operationId: receipt.operationId,
      requestHash: receipt.requestHash,
      state: 'succeeded',
      created: false,
      result: receipt,
    };
    return receipt;
  }

  async markCleanupRequired(evidence: CleanupRequiredEvidence): Promise<void> {
    this.cleanupRecords.push(evidence);
    this.snapshot = {
      operationId: evidence.operationId,
      requestHash: this.snapshot?.requestHash ?? hash('9'),
      state: 'cleanup-required',
      created: false,
      cleanupReason: evidence.reason,
    };
  }
}

function backupProvider(overrides: Partial<SupabaseBackupProvider> = {}): SupabaseBackupProvider {
  return {
    async createEncryptedBackup() { return backupEvidence(); },
    async reconcileBackup() { return { state: 'absent' }; },
    ...overrides,
  };
}

function restoreProvider(overrides: Partial<SupabaseRestoreProvider> = {}): SupabaseRestoreProvider {
  return {
    async inspectTarget() {
      return {
        projectRef: 'rorca-owned-scratch',
        environment: 'scratch',
        databaseIdentity: TARGET_DATABASE_IDENTITY,
        scratchPurposeVerified: true,
        empty: true,
      };
    },
    async restoreEncryptedBackup() {},
    async verifyRestore() { return restoreVerification(); },
    async reconcileRestore() { return { state: 'absent' }; },
    ...overrides,
  };
}

function errorReason(error: unknown, reason: string): boolean {
  return error instanceof AppError && error.details?.reason === reason;
}

test('backup creation settles verifiable encrypted artifact evidence without credential bytes', async () => {
  const store = new MemoryOperationStore();
  let providerInput: Parameters<SupabaseBackupProvider['createEncryptedBackup']>[0] | undefined;
  const provider = backupProvider({
    async createEncryptedBackup(input) {
      providerInput = input;
      return backupEvidence();
    },
  });
  const adapter = new SupabaseDatabaseBackupAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return SOURCE_CONNECTION; } },
    provider,
    operationStore: store,
    readBinding: async () => binding('database.backup.create'),
    now: () => NOW,
  });

  const receipt = await adapter.createBackup(backupRequest());

  assert.equal(providerInput?.sourceConnectionString, SOURCE_CONNECTION);
  assert.equal(receipt.artifact.contentHash, hash('4'));
  assert.equal(receipt.artifact.source.projectRef, 'rorca-owned-source');
  assert.equal(receipt.artifact.encryption.encrypted, true);
  assert.equal(receipt.artifact.verification.verifiedContentHash, receipt.artifact.contentHash);
  assert.equal(receipt.artifact.retention.policy, 'scratch-drill-30d');
  assert.equal(receipt.authorityGrantId, GRANT_ID);
  assert.equal(receipt.grantRiskClass, 'elevated');
  assert.equal(store.backupSettlements.length, 1);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes('credential-bytes'), false);
  assert.equal(serialized.includes(SOURCE_CONNECTION), false);
  for (const field of ['password', 'connectionString', 'secret', 'token', 'apiKey']) {
    assert.equal(serialized.includes(`"${field}"`), false);
  }
});

test('scratch restore writes only after exact target preflight and records schema and data verification', async () => {
  const artifact = storedArtifact();
  const store = new MemoryOperationStore(artifact);
  const events: string[] = [];
  const provider = restoreProvider({
    async inspectTarget() {
      events.push('inspect-target');
      return {
        projectRef: 'rorca-owned-scratch', environment: 'scratch',
        databaseIdentity: TARGET_DATABASE_IDENTITY, scratchPurposeVerified: true, empty: true,
      };
    },
    async restoreEncryptedBackup() { events.push('restore-write'); },
    async verifyRestore() { events.push('verify'); return restoreVerification(); },
  });
  const adapter = new SupabaseDatabaseRestoreAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return TARGET_CONNECTION; } },
    provider,
    operationStore: store,
    readBinding: async () => binding('database.backup.restore'),
    now: () => NOW,
  });

  const request = restoreRequest(artifact);
  const receipt = await adapter.restoreBackup({
    ...request,
    target: { ...request.target, environment: undefined },
  } as unknown as SupabaseBackupRestoreRequest);

  assert.deepEqual(events, ['inspect-target', 'restore-write', 'verify']);
  assert.equal(receipt.targetIdentityHash, restoreRequest(artifact).target.targetIdentityHash);
  assert.equal(receipt.artifactContentHash, artifact.contentHash);
  assert.equal(receipt.authorityGrantId, GRANT_ID);
  assert.equal(receipt.grantRiskClass, 'high');
  assert.deepEqual(receipt.verification.dataChecks.map((check) => check.checkId), ['tenant-row-count', 'seed-records']);
  assert.equal(receipt.verification.schemaHash, artifact.schemaHash);
  assert.equal(store.restoreSettlements.length, 1);
  assert.equal(JSON.stringify(receipt).includes('other-credential-bytes'), false);
  assert.equal(JSON.stringify(receipt).includes(TARGET_CONNECTION), false);
});

test('restore rejects ambiguous, source-equal, production, stale, and unauthorized targets before provider writes', async () => {
  const artifact = storedArtifact();

  async function rejectedBeforeWrite(rawRequest: unknown, reason?: string, expectedStartCalls = 0): Promise<void> {
    const store = new MemoryOperationStore(artifact);
    let writes = 0;
    const adapter = new SupabaseDatabaseRestoreAuthorityProviderAdapter({
      secretStore: { async resolveDatabaseConnection() { return TARGET_CONNECTION; } },
      provider: restoreProvider({ async restoreEncryptedBackup() { writes += 1; } }),
      operationStore: store,
      readBinding: async () => binding('database.backup.restore'),
      now: () => NOW,
    });
    await assert.rejects(
      adapter.restoreBackup(rawRequest as SupabaseBackupRestoreRequest),
      reason ? (error: unknown) => errorReason(error, reason) : undefined,
    );
    assert.equal(writes, 0);
    assert.equal(store.startCalls, expectedStartCalls);
  }

  const ambiguous = { ...restoreRequest(artifact), target: undefined };
  await rejectedBeforeWrite(ambiguous);

  const equalTarget = {
    projectRef: 'rorca-owned-source',
    environment: 'scratch' as const,
    databaseIdentity: SOURCE_DATABASE_IDENTITY,
    connectionReferenceId: 'secret-store://rorca-fixture/database/source-equal/v1',
    connectionFingerprint: databaseCredentialFingerprint(SOURCE_CONNECTION),
    verifiedAt: '2026-08-21T11:55:00.000Z',
    verificationExpiresAt: '2026-08-21T12:05:00.000Z',
  };
  const equalSubject = { ...restoreSubject(artifact), target: { ...equalTarget, targetIdentityHash: restoreTargetIdentityHash(equalTarget) } };
  await rejectedBeforeWrite({
    ...equalSubject,
    authorityGrant: { ...restoreRequest(artifact).authorityGrant, subjectHash: databaseBackupRestoreSubjectHash(equalSubject) },
  }, 'source_equal_target');

  const productionTarget = { ...restoreSubject(artifact).target, environment: 'production' as const };
  const productionSubject = {
    ...restoreSubject(artifact),
    target: { ...productionTarget, targetIdentityHash: restoreTargetIdentityHash(productionTarget) },
  };
  await rejectedBeforeWrite({
    ...productionSubject,
    authorityGrant: { ...restoreRequest(artifact).authorityGrant, subjectHash: databaseBackupRestoreSubjectHash(productionSubject) },
  }, 'production_restore_policy_unavailable');

  const staleSubject = {
    ...restoreSubject(artifact),
    target: { ...restoreSubject(artifact).target, verificationExpiresAt: NOW.toISOString() },
  };
  await rejectedBeforeWrite({
    ...staleSubject,
    authorityGrant: { ...restoreRequest(artifact).authorityGrant, subjectHash: databaseBackupRestoreSubjectHash(staleSubject) },
  }, 'target_verification_stale');

  await rejectedBeforeWrite({
    ...restoreRequest(artifact),
    authorityGrant: {
      ...restoreRequest(artifact).authorityGrant,
      capability: 'database.backup.create',
      riskClass: 'elevated',
    },
  });
  await rejectedBeforeWrite({
    ...restoreRequest(artifact),
    authorityGrant: {
      ...restoreRequest(artifact).authorityGrant,
      capability: 'database.schema.inspect',
    },
  });
  await rejectedBeforeWrite({
    ...restoreRequest(artifact),
    authorityGrant: {
      ...restoreRequest(artifact).authorityGrant,
      grantId: '55555555-5555-4555-8555-555555555555',
    },
  }, 'authority_grant_unauthorized', 1);
});

test('backup, restore, inspect, and migration authority surfaces cannot substitute for one another', async () => {
  const backupStore = new MemoryOperationStore();
  const backup = new SupabaseDatabaseBackupAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return SOURCE_CONNECTION; } },
    provider: backupProvider(),
    operationStore: backupStore,
    readBinding: async () => binding('database.backup.create'),
    now: () => NOW,
  });
  const restoreStore = new MemoryOperationStore(storedArtifact());
  const restore = new SupabaseDatabaseRestoreAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return TARGET_CONNECTION; } },
    provider: restoreProvider(),
    operationStore: restoreStore,
    readBinding: async () => binding('database.backup.restore'),
    now: () => NOW,
  });

  assert.deepEqual(backup.capabilities, ['database.backup.create']);
  assert.deepEqual(restore.capabilities, ['database.backup.restore']);
  for (const operation of ['database.schema.inspect', 'database.backup.restore', 'database.migration.apply.staging']) {
    await assert.rejects(backup.execute({ operation, request: backupRequest() }), (error: unknown) => {
      return error instanceof AppError && error.code === 'FORBIDDEN';
    });
  }
  for (const operation of ['database.schema.inspect', 'database.backup.create', 'database.migration.apply.production']) {
    await assert.rejects(restore.execute({ operation, request: restoreRequest() }), (error: unknown) => {
      return error instanceof AppError && error.code === 'FORBIDDEN';
    });
  }
  assert.equal(backupStore.startCalls, 0);
  assert.equal(restoreStore.startCalls, 0);
});

test('uncertain backup completion reconciles to one receipt without creating a second artifact', async () => {
  const store = new MemoryOperationStore();
  let creates = 0;
  let reconciliations = 0;
  const adapter = new SupabaseDatabaseBackupAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return SOURCE_CONNECTION; } },
    provider: backupProvider({
      async createEncryptedBackup() {
        creates += 1;
        throw new Error('provider response lost after upload');
      },
      async reconcileBackup() {
        reconciliations += 1;
        return { state: 'complete', evidence: backupEvidence() };
      },
    }),
    operationStore: store,
    readBinding: async () => binding('database.backup.create'),
    now: () => NOW,
  });

  const receipt = await adapter.createBackup(backupRequest());
  assert.equal(receipt.artifact.artifactId, ARTIFACT_ID);
  assert.equal(creates, 1);
  assert.equal(reconciliations, 1);
  assert.equal(store.backupSettlements.length, 1);
  assert.equal(store.cleanupRecords.length, 0);

  const replayed = await adapter.createBackup(backupRequest());
  assert.deepEqual(replayed, receipt);
  assert.equal(creates, 1);
  assert.equal(store.backupSettlements.length, 1);
});

test('restore retry after a process crash reconciles its populated scratch target without a second write', async () => {
  const artifact = storedArtifact();
  const request = restoreRequest(artifact);
  const store = new MemoryOperationStore(artifact);
  store.snapshot = {
    operationId: request.operationId,
    requestHash: request.authorityGrant.subjectHash,
    state: 'started',
    created: false,
  };
  let writes = 0;
  let reconciliations = 0;
  const adapter = new SupabaseDatabaseRestoreAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return TARGET_CONNECTION; } },
    provider: restoreProvider({
      async inspectTarget() {
        return {
          projectRef: 'rorca-owned-scratch',
          environment: 'scratch',
          databaseIdentity: TARGET_DATABASE_IDENTITY,
          scratchPurposeVerified: true,
          empty: false,
        };
      },
      async restoreEncryptedBackup() { writes += 1; },
      async reconcileRestore() {
        reconciliations += 1;
        return { state: 'complete', verification: restoreVerification() };
      },
    }),
    operationStore: store,
    readBinding: async () => binding('database.backup.restore'),
    now: () => new Date('2026-08-21T12:10:00.000Z'),
  });

  const receipt = await adapter.restoreBackup(request);
  assert.equal(receipt.operationId, OPERATION_ID);
  assert.equal(receipt.verification.schemaHash, artifact.schemaHash);
  assert.equal(reconciliations, 1);
  assert.equal(writes, 0);
  assert.equal(store.resumeCalls, 1);
  assert.equal(store.startCalls, 0);
  assert.equal(store.restoreSettlements.length, 1);
});

test('restore retry records cleanup-required when provider reconciliation itself fails', async () => {
  const artifact = storedArtifact();
  const request = restoreRequest(artifact);
  const store = new MemoryOperationStore(artifact);
  store.snapshot = {
    operationId: request.operationId,
    requestHash: request.authorityGrant.subjectHash,
    state: 'started',
    created: false,
  };
  let writes = 0;
  const adapter = new SupabaseDatabaseRestoreAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return TARGET_CONNECTION; } },
    provider: restoreProvider({
      async inspectTarget() {
        return {
          projectRef: 'rorca-owned-scratch',
          environment: 'scratch',
          databaseIdentity: TARGET_DATABASE_IDENTITY,
          scratchPurposeVerified: true,
          empty: false,
        };
      },
      async restoreEncryptedBackup() { writes += 1; },
      async reconcileRestore() { throw new Error('provider reconciliation unavailable'); },
    }),
    operationStore: store,
    readBinding: async () => binding('database.backup.restore'),
    now: () => new Date('2026-08-21T12:10:00.000Z'),
  });

  await assert.rejects(adapter.restoreBackup(request), (error: unknown) => {
    return error instanceof AppError && error.code === 'DATABASE_BACKUP_CLEANUP_REQUIRED';
  });
  assert.equal(writes, 0);
  assert.deepEqual(store.cleanupRecords.map((record) => record.reason), ['provider_reconciliation_failed']);
  assert.equal(store.restoreSettlements.length, 0);
});

test('uncertain restore that cannot be verified leaves one explicit cleanup-required record', async () => {
  const artifact = storedArtifact();
  const store = new MemoryOperationStore(artifact);
  let writes = 0;
  const adapter = new SupabaseDatabaseRestoreAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return TARGET_CONNECTION; } },
    provider: restoreProvider({
      async restoreEncryptedBackup() {
        writes += 1;
        throw new Error('connection lost during restore');
      },
      async reconcileRestore() {
        return {
          state: 'cleanup-required',
          reason: 'provider_reports_partial_restore',
          providerStateReference: `supabase-restore-state://rorca-owned-scratch/${OPERATION_ID}`,
        };
      },
    }),
    operationStore: store,
    readBinding: async () => binding('database.backup.restore'),
    now: () => NOW,
  });

  await assert.rejects(adapter.restoreBackup(restoreRequest(artifact)), (error: unknown) => {
    return error instanceof AppError && error.code === 'DATABASE_BACKUP_CLEANUP_REQUIRED';
  });
  assert.equal(writes, 1);
  assert.equal(store.restoreSettlements.length, 0);
  assert.deepEqual(store.cleanupRecords.map((record) => record.reason), ['provider_reports_partial_restore']);
  assert.equal(JSON.stringify(store.cleanupRecords).includes('credential-bytes'), false);
});
