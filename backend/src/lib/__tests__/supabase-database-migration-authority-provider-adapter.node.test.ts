/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, ConflictError } from '../errors';
import {
  StagingMigrationStatementError,
  SupabaseDatabaseStagingMigrationAuthorityProviderAdapter,
  PostgresSupabaseStagingMigrationProvider,
  stagingMigrationEntryContentHash,
  stagingMigrationManifestDigest,
  migrationVerificationResultHash,
  stagingMigrationSqlHash,
  stagingMigrationSubjectHash,
  type MigrationStatement,
  type MigrationStatementOutcome,
  type MigrationVerificationEvidence,
  type MigrationVerificationQuery,
  type StagingMigrationHistoryEntry,
  type StagingMigrationAttemptEntry,
  type StagingMigrationManifest,
  type StagingMigrationManifestEntry,
  type StagingMigrationOperationSnapshot,
  type StagingMigrationOperationStart,
  type StagingMigrationOperationStore,
  type StagingRestoreActionOutcome,
  type SupabaseStagingMigrationProvider,
  type SupabaseStagingMigrationReceipt,
  type SupabaseStagingMigrationRequest,
  type SupabaseStagingMigrationSession,
} from '../supabase-database-migration-authority-provider-adapter';
import {
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  databaseRoleFingerprint,
  supabaseDatabaseTargetIdentityHash,
  type SupabaseDatabaseProviderBinding,
} from '../supabase-database-authority-provider-adapter';

const NOW = new Date('2026-08-21T14:00:00.000Z');
const CONNECTION = 'postgresql://migration_operator:credential-bytes@db.staging.fixture.supabase.co:5432/postgres?sslmode=require';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const GRANT_ID = '33333333-3333-4333-8333-333333333333';
const MANIFEST_ID = '44444444-4444-4444-8444-444444444444';
const BACKUP_ID = '55555555-5555-4555-8555-555555555555';
const INITIAL_SCHEMA_HASH = hash('a');
const APPLIED_SCHEMA_HASH = hash('b');
const FORWARD_FIXED_SCHEMA_HASH = hash('c');
const PARTIAL_SCHEMA_HASH = hash('d');

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const DATABASE_IDENTITY = {
  databaseName: 'postgres',
  endpointFingerprint: databaseEndpointFingerprint(CONNECTION),
};

function binding(): SupabaseDatabaseProviderBinding {
  return {
    providerId: 'supabase-database',
    bindingId: BINDING_ID,
    workspaceId: 'rorca-fixture',
    bindingStatus: 'active',
    projectRef: 'rorca-owned-staging',
    environment: 'staging',
    databaseIdentity: DATABASE_IDENTITY,
    databaseIdentityHash: databaseResourceIdentityHash(DATABASE_IDENTITY),
    bindingGeneration: 9,
    roleProfile: {
      roleFingerprint: databaseRoleFingerprint('migration_operator'),
      verified: true,
      verifiedAt: '2026-08-21T13:00:00.000Z',
      authenticationClass: 'database-role',
      capabilities: ['database.migration.apply.staging'],
    },
    bindingHash: hash('e'),
    secretReferences: [{
      purpose: 'database-connection',
      referenceId: 'secret-store://rorca-fixture/database/staging/v9',
      fingerprint: databaseCredentialFingerprint(CONNECTION),
      credentialClass: 'database-role',
    }],
  };
}

function statement(statementId: string, sql: string): MigrationStatement {
  return { statementId, sql, contentHash: stagingMigrationSqlHash(sql) };
}

function verificationQuery(queryId: string, sql = 'SELECT count(*)::text AS count FROM widgets'): MigrationVerificationQuery {
  return {
    queryId,
    sql,
    contentHash: stagingMigrationSqlHash(sql),
    expectedResultHash: hash('f'),
  };
}

function reversibleMigration(overrides: Partial<StagingMigrationManifestEntry> = {}): StagingMigrationManifestEntry {
  const migrationWithoutHash = {
    id: '001-create-widgets',
    transactionMode: 'transactional',
    prerequisites: [] as string[],
    statements: [statement('create-widgets', 'CREATE TABLE public.widgets (id bigint PRIMARY KEY)')],
    expectedSchemaHash: APPLIED_SCHEMA_HASH,
    verificationQueries: [verificationQuery('widgets-created')],
    recovery: {
      classification: 'reversible' as const,
      rollback: {
        tested: true as const,
        statements: [statement('drop-widgets', 'DROP TABLE IF EXISTS public.widgets')],
        expectedSchemaHash: INITIAL_SCHEMA_HASH,
        verificationQueries: [verificationQuery('widgets-removed', "SELECT count(*)::text AS count FROM pg_tables WHERE schemaname='public' AND tablename='widgets'")],
      },
    },
    ...overrides,
  };
  return {
    ...migrationWithoutHash,
    contentHash: stagingMigrationEntryContentHash(migrationWithoutHash),
  };
}

function forwardOnlyMigration(
  strategy: 'forward-fix' | 'scratch-restore' = 'forward-fix',
): StagingMigrationManifestEntry {
  const recoveryProcedure = strategy === 'forward-fix'
    ? {
      strategy,
      statements: [statement('finish-widget-index', 'CREATE INDEX widgets_id_idx ON public.widgets (id)')],
      expectedSchemaHash: FORWARD_FIXED_SCHEMA_HASH,
      verificationQueries: [verificationQuery('widget-index-fixed')],
    }
    : {
      strategy,
      backupArtifactId: BACKUP_ID,
      procedureReference: 'restore-procedure://rorca-fixture/staging/widgets-v1',
      expectedSchemaHash: FORWARD_FIXED_SCHEMA_HASH,
      verificationQueries: [verificationQuery('widget-backup-restored')],
    };
  const migrationWithoutHash = {
    id: '001-forward-widgets',
    transactionMode: 'non-transactional',
    prerequisites: [] as string[],
    statements: [statement('create-widget-index', 'CREATE INDEX CONCURRENTLY widgets_id_idx ON public.widgets (id)')],
    expectedSchemaHash: APPLIED_SCHEMA_HASH,
    verificationQueries: [verificationQuery('widget-index-created')],
    recovery: {
      classification: 'forward-only' as const,
      backupEvidence: {
        artifactId: BACKUP_ID,
        contentHash: hash('1'),
        schemaHash: INITIAL_SCHEMA_HASH,
        verificationResult: 'passed' as const,
        verificationReference: 'backup-verification://rorca-fixture/staging/widgets-v1',
      },
      procedure: recoveryProcedure,
    },
  };
  return {
    ...migrationWithoutHash,
    contentHash: stagingMigrationEntryContentHash(migrationWithoutHash),
  } as StagingMigrationManifestEntry;
}

function manifest(
  migration: StagingMigrationManifestEntry = reversibleMigration(),
  baseHistory: StagingMigrationManifest['baseHistory'] = [],
): StagingMigrationManifest {
  return {
    version: 'rorca.staging-migration-manifest.v1',
    manifestId: MANIFEST_ID,
    currentSchemaHash: INITIAL_SCHEMA_HASH,
    baseHistory,
    migrations: [migration],
    expectedFinalSchemaHash: migration.expectedSchemaHash,
  };
}

function requestFor(selectedManifest: StagingMigrationManifest = manifest()): SupabaseStagingMigrationRequest {
  const subject = {
    operationId: OPERATION_ID,
    idempotencyKey: 'staging-migration-fixture-20260821',
    target: {
      bindingId: BINDING_ID,
      workspaceId: 'rorca-fixture',
      projectRef: 'rorca-owned-staging',
      environment: 'staging' as const,
      databaseIdentity: DATABASE_IDENTITY,
      bindingGeneration: 9,
    },
    manifest: selectedManifest,
    manifestDigest: stagingMigrationManifestDigest(selectedManifest),
  };
  return {
    ...subject,
    authorityGrant: {
      grantId: GRANT_ID,
      capability: 'database.migration.apply.staging',
      riskClass: 'high',
      workspaceId: subject.target.workspaceId,
      bindingId: subject.target.bindingId,
      bindingGeneration: subject.target.bindingGeneration,
      subjectHash: stagingMigrationSubjectHash(subject),
      expiresAt: '2026-08-21T14:15:00.000Z',
    },
  };
}

function verificationEvidence(
  queries: MigrationVerificationQuery[],
  expectedSchemaHash: `sha256:${string}`,
  actualSchemaHash: `sha256:${string}`,
): MigrationVerificationEvidence {
  const passed = expectedSchemaHash === actualSchemaHash;
  return {
    queries: queries.map((query) => ({
      queryId: query.queryId,
      contentHash: query.contentHash,
      expectedResultHash: query.expectedResultHash,
      actualResultHash: query.expectedResultHash,
      passed,
    })),
    expectedSchemaHash,
    actualSchemaHash,
    schemaPassed: passed,
    passed,
  };
}

class MemoryMigrationStore implements StagingMigrationOperationStore {
  snapshot: StagingMigrationOperationSnapshot | null = null;
  history: StagingMigrationHistoryEntry[];
  starts = 0;
  settlements = 0;
  readonly manifestDigestByOperation = new Map<string, string>();
  readonly attempts = new Map<string, StagingMigrationAttemptEntry>();

  constructor(history: StagingMigrationHistoryEntry[] = []) {
    this.history = [...history];
  }

  async start(input: StagingMigrationOperationStart): Promise<StagingMigrationOperationSnapshot> {
    this.starts += 1;
    const existingOperation = [...this.manifestDigestByOperation.entries()]
      .find(([, manifestDigest]) => manifestDigest === input.manifestDigest)?.[0];
    if (existingOperation && existingOperation !== input.operationId) {
      throw new ConflictError('Staging migration manifest is already bound to another operation');
    }
    if (this.snapshot) {
      assert.equal(this.snapshot.operationId, input.operationId);
      assert.equal(this.snapshot.requestHash, input.requestHash);
      return { ...this.snapshot, created: false };
    }
    this.manifestDigestByOperation.set(input.operationId, input.manifestDigest);
    this.snapshot = {
      operationId: input.operationId,
      created: true,
      state: 'started',
      requestHash: input.requestHash,
    };
    return this.snapshot;
  }

  async load(operationId: string): Promise<StagingMigrationOperationSnapshot | null> {
    return this.snapshot?.operationId === operationId ? { ...this.snapshot, created: false } : null;
  }

  async loadTargetHistory(): Promise<StagingMigrationHistoryEntry[]> {
    return [...this.history].sort((left, right) => left.targetOrdinal - right.targetOrdinal);
  }

  async loadMigrationAttempt(operationId: string, migrationId: string): Promise<StagingMigrationAttemptEntry | null> {
    return this.attempts.get(`${operationId}:${migrationId}`) ?? null;
  }

  async recordMigrationAttempt(input: { entry: StagingMigrationAttemptEntry }): Promise<void> {
    const key = `${input.entry.operationId}:${input.entry.id}`;
    const existing = this.attempts.get(key);
    if (existing) {
      assert.deepEqual(existing, input.entry);
      return;
    }
    this.attempts.set(key, input.entry);
  }

  async recordMigration(input: { entry: StagingMigrationHistoryEntry }): Promise<void> {
    const existing = this.history.find((entry) => entry.id === input.entry.id);
    if (existing) {
      assert.deepEqual(existing, input.entry);
      return;
    }
    this.history.push(input.entry);
  }

  async settle(receipt: SupabaseStagingMigrationReceipt): Promise<SupabaseStagingMigrationReceipt> {
    if (this.snapshot?.state !== 'started') {
      assert.deepEqual(this.snapshot?.result, receipt);
      return receipt;
    }
    this.settlements += 1;
    this.snapshot = {
      operationId: receipt.operationId,
      created: false,
      state: receipt.status,
      requestHash: receipt.requestHash,
      result: receipt,
    };
    return receipt;
  }
}

class FixtureSession implements SupabaseStagingMigrationSession {
  schemaHash: `sha256:${string}`;
  readonly events: string[] = [];
  applyCalls = 0;

  constructor(
    schemaHash: `sha256:${string}` = INITIAL_SCHEMA_HASH,
    private readonly failApply = false,
    private readonly successfulApplyHash: `sha256:${string}` = APPLIED_SCHEMA_HASH,
  ) {
    this.schemaHash = schemaHash;
  }

  async inspectSchemaHash(): Promise<`sha256:${string}`> {
    this.events.push('inspect');
    return this.schemaHash;
  }

  async executeStatements(input: {
    migrationId: string;
    phase: 'apply' | 'rollback' | 'forward-fix';
    transactionMode: 'transactional' | 'non-transactional';
    statements: MigrationStatement[];
  }): Promise<MigrationStatementOutcome[]> {
    this.events.push(input.phase);
    const outcomes: MigrationStatementOutcome[] = input.statements.map((item) => ({
      migrationId: input.migrationId,
      statementId: item.statementId,
      contentHash: item.contentHash,
      phase: input.phase,
      outcome: 'applied',
    }));
    if (input.phase === 'apply') {
      this.applyCalls += 1;
      if (this.failApply) {
        this.schemaHash = PARTIAL_SCHEMA_HASH;
        outcomes[0].outcome = 'failed';
        throw new StagingMigrationStatementError(outcomes);
      }
      this.schemaHash = this.successfulApplyHash;
    } else if (input.phase === 'rollback') {
      this.schemaHash = INITIAL_SCHEMA_HASH;
    } else {
      this.schemaHash = FORWARD_FIXED_SCHEMA_HASH;
    }
    return outcomes;
  }

  async verify(input: {
    queries: MigrationVerificationQuery[];
    expectedSchemaHash: `sha256:${string}`;
  }): Promise<MigrationVerificationEvidence> {
    this.events.push('verify');
    return verificationEvidence(input.queries, input.expectedSchemaHash, this.schemaHash);
  }

  async restoreScratch(input: {
    backupArtifactId: string;
    procedureReference: string;
  }): Promise<StagingRestoreActionOutcome> {
    this.events.push('scratch-restore');
    this.schemaHash = FORWARD_FIXED_SCHEMA_HASH;
    return {
      backupArtifactId: input.backupArtifactId,
      procedureReference: input.procedureReference,
      outcome: 'restored',
      providerEvidenceReference: 'restore-evidence://rorca-fixture/staging/widgets-v1',
    };
  }
}

class FencedFixtureProvider implements SupabaseStagingMigrationProvider {
  calls = 0;
  private fence = Promise.resolve();

  constructor(readonly session: FixtureSession) {}

  async withFencedTarget<T>(
    _input: Parameters<SupabaseStagingMigrationProvider['withFencedTarget']>[0],
    operation: (session: SupabaseStagingMigrationSession) => Promise<T>,
  ): Promise<T> {
    this.calls += 1;
    const previous = this.fence;
    let release = (): void => undefined;
    this.fence = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation(this.session);
    } finally {
      release();
    }
  }
}

function adapter(store: MemoryMigrationStore, provider: FencedFixtureProvider) {
  return new SupabaseDatabaseStagingMigrationAuthorityProviderAdapter({
    secretStore: { async resolveDatabaseConnection() { return CONNECTION; } },
    provider,
    operationStore: store,
    readBinding: async () => binding(),
    now: () => NOW,
  });
}

function errorReason(error: unknown, reason: string): boolean {
  return error instanceof AppError && error.details?.reason === reason;
}

function historyEntry(id: string, contentHash: `sha256:${string}`, targetOrdinal: number): StagingMigrationHistoryEntry {
  return {
    operationId: '66666666-6666-4666-8666-666666666666',
    manifestDigest: hash('2'),
    id,
    contentHash,
    targetOrdinal,
    schemaHashAfter: INITIAL_SCHEMA_HASH,
    statementOutcomes: [],
    verification: verificationEvidence([verificationQuery(`history-${targetOrdinal}`)], INITIAL_SCHEMA_HASH, INITIAL_SCHEMA_HASH),
    appliedAt: '2026-08-20T12:00:00.000Z',
  };
}

test('preflight rejects schema drift, missing/reordered history, duplicate ids, dependency conflicts, unsupported modes, and absent recovery', async () => {
  async function rejects(
    selectedRequest: SupabaseStagingMigrationRequest,
    reason: string,
    store = new MemoryMigrationStore(),
    session = new FixtureSession(),
  ): Promise<void> {
    await assert.rejects(adapter(store, new FencedFixtureProvider(session)).applyStagingMigration(selectedRequest), (error: unknown) => {
      return errorReason(error, reason);
    });
    assert.equal(session.applyCalls, 0);
  }

  await rejects(requestFor(), 'schema_hash_drift', new MemoryMigrationStore(), new FixtureSession(PARTIAL_SCHEMA_HASH));
  await rejects(requestFor(), 'schema_hash_drift', new MemoryMigrationStore(), new FixtureSession(APPLIED_SCHEMA_HASH));

  const baseOne = { id: '000-base-one', contentHash: hash('3') };
  const baseTwo = { id: '000-base-two', contentHash: hash('4') };
  const baseMigration = reversibleMigration({ prerequisites: [baseOne.id] });
  await rejects(requestFor(manifest(baseMigration, [baseOne])), 'missing_migrations');
  await rejects(
    requestFor(manifest(baseMigration, [baseOne, baseTwo])),
    'reordered_migrations',
    new MemoryMigrationStore([
      historyEntry(baseTwo.id, baseTwo.contentHash, 0),
      historyEntry(baseOne.id, baseOne.contentHash, 1),
    ]),
  );

  const duplicateManifest = manifest();
  duplicateManifest.migrations = [duplicateManifest.migrations[0], duplicateManifest.migrations[0]];
  duplicateManifest.expectedFinalSchemaHash = duplicateManifest.migrations[1].expectedSchemaHash;
  await rejects(requestFor(duplicateManifest), 'duplicate_ids');

  const conflictingMigration = reversibleMigration({ prerequisites: [baseOne.id, baseOne.id] });
  await rejects(requestFor(manifest(conflictingMigration, [baseOne])), 'dependency_conflicts');

  const unsupportedMigration = reversibleMigration({ transactionMode: 'provider-default' });
  await rejects(requestFor(manifest(unsupportedMigration)), 'unsupported_transaction_mode');

  const noRecoveryManifest = manifest();
  const migrationWithoutRecovery = { ...noRecoveryManifest.migrations[0] } as Partial<StagingMigrationManifestEntry>;
  delete migrationWithoutRecovery.recovery;
  noRecoveryManifest.migrations = [migrationWithoutRecovery as StagingMigrationManifestEntry];
  await rejects(requestFor(noRecoveryManifest), 'absent_recovery_classification');
});

test('reversible failure executes tested rollback and verifies the exact prior schema', async () => {
  const store = new MemoryMigrationStore();
  const session = new FixtureSession(INITIAL_SCHEMA_HASH, true);
  const receipt = await adapter(store, new FencedFixtureProvider(session)).applyStagingMigration(requestFor());

  assert.equal(receipt.status, 'recovered');
  assert.equal(receipt.beforeSchemaHash, INITIAL_SCHEMA_HASH);
  assert.equal(receipt.afterSchemaHash, INITIAL_SCHEMA_HASH);
  assert.equal(receipt.recoveryProof?.classification, 'reversible');
  assert.equal(receipt.recoveryProof?.strategy, 'rollback');
  assert.equal(receipt.recoveryProof?.verification.passed, true);
  assert.deepEqual(session.events, ['inspect', 'apply', 'rollback', 'verify']);
  assert.equal(store.settlements, 1);
  assert.equal(store.history.length, 0);
});

test('forward-only failure executes declared forward-fix and records resulting schema and backup proof', async () => {
  const selectedManifest = manifest(forwardOnlyMigration('forward-fix'));
  const store = new MemoryMigrationStore();
  const session = new FixtureSession(INITIAL_SCHEMA_HASH, true);
  const receipt = await adapter(store, new FencedFixtureProvider(session)).applyStagingMigration(requestFor(selectedManifest));

  assert.equal(receipt.status, 'recovered');
  assert.equal(receipt.afterSchemaHash, FORWARD_FIXED_SCHEMA_HASH);
  assert.equal(receipt.recoveryProof?.classification, 'forward-only');
  assert.equal(receipt.recoveryProof?.strategy, 'forward-fix');
  assert.equal(receipt.recoveryProof?.backupEvidence?.artifactId, BACKUP_ID);
  assert.equal(receipt.recoveryProof?.verification.actualSchemaHash, FORWARD_FIXED_SCHEMA_HASH);
  assert.deepEqual(session.events, ['inspect', 'apply', 'forward-fix', 'verify']);
});

test('forward-only scratch-restore procedure is executed and verified as a separate recovery path', async () => {
  const selectedManifest = manifest(forwardOnlyMigration('scratch-restore'));
  const session = new FixtureSession(INITIAL_SCHEMA_HASH, true);
  const receipt = await adapter(new MemoryMigrationStore(), new FencedFixtureProvider(session))
    .applyStagingMigration(requestFor(selectedManifest));

  assert.equal(receipt.recoveryProof?.strategy, 'scratch-restore');
  assert.equal(receipt.recoveryProof?.restoreOutcome?.backupArtifactId, BACKUP_ID);
  assert.equal(receipt.recoveryProof?.verification.passed, true);
  assert.deepEqual(session.events, ['inspect', 'apply', 'scratch-restore', 'verify']);
});

test('concurrent and replayed apply attempts settle once and never execute a manifest twice', async () => {
  const store = new MemoryMigrationStore();
  const session = new FixtureSession();
  const provider = new FencedFixtureProvider(session);
  const migrationAdapter = adapter(store, provider);
  const request = requestFor();

  const [first, concurrent] = await Promise.all([
    migrationAdapter.applyStagingMigration(request),
    migrationAdapter.applyStagingMigration(request),
  ]);
  const replay = await migrationAdapter.applyStagingMigration(request);
  const competingSubject = {
    ...request,
    operationId: '77777777-7777-4777-8777-777777777777',
    idempotencyKey: 'competing-staging-manifest-20260821',
  };
  const competingRequest: SupabaseStagingMigrationRequest = {
    ...competingSubject,
    authorityGrant: {
      ...request.authorityGrant,
      grantId: '88888888-8888-4888-8888-888888888888',
      subjectHash: stagingMigrationSubjectHash(competingSubject),
    },
  };
  await assert.rejects(migrationAdapter.applyStagingMigration(competingRequest), ConflictError);

  assert.deepEqual(concurrent, first);
  assert.deepEqual(replay, first);
  assert.equal(first.status, 'succeeded');
  assert.equal(session.applyCalls, 1);
  assert.equal(store.history.length, 1);
  assert.equal(store.settlements, 1);
  assert.equal(provider.calls, 2);
});

test('replay reconciles an uncertain apply only after its durable attempt boundary', async () => {
  const store = new MemoryMigrationStore();
  const request = requestFor();
  await store.start({
    operationId: request.operationId,
    idempotencyKey: request.idempotencyKey,
    workspaceId: request.target.workspaceId,
    bindingId: request.target.bindingId,
    bindingGeneration: request.target.bindingGeneration,
    authorityGrantId: request.authorityGrant.grantId,
    requestHash: request.authorityGrant.subjectHash,
    manifestId: request.manifest.manifestId,
    manifestDigest: request.manifestDigest,
    targetIdentityHash: supabaseDatabaseTargetIdentityHash(binding()),
  });
  const selectedMigration = request.manifest.migrations[0];
  await store.recordMigrationAttempt({
    entry: {
      operationId: request.operationId,
      manifestDigest: request.manifestDigest,
      id: selectedMigration.id,
      contentHash: selectedMigration.contentHash,
      targetOrdinal: 0,
      beforeSchemaHash: request.manifest.currentSchemaHash,
      expectedSchemaHash: selectedMigration.expectedSchemaHash,
      attemptedAt: NOW.toISOString(),
    },
  });
  const session = new FixtureSession(APPLIED_SCHEMA_HASH);

  const receipt = await adapter(store, new FencedFixtureProvider(session)).applyStagingMigration(request);

  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.migrations[0].statementOutcomes[0].outcome, 'reconciled-applied');
  assert.equal(session.applyCalls, 0);
  assert.equal(store.attempts.size, 1);
});

test('PostgreSQL provider fences the exact target and verifies through read-only transactions', async () => {
  const events: string[] = [];
  const providerBinding = binding();
  const provider = new PostgresSupabaseStagingMigrationProvider({
    connect: async () => ({
      async query(sql: string) {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        events.push(normalized);
        if (normalized.startsWith('SELECT current_database()')) {
          return { rows: [{ database_name: 'postgres', database_role: 'migration_operator' }] };
        }
        if (normalized === 'SELECT 1::int AS value') return { rows: [{ value: 1 }] };
        return { rows: [] };
      },
      async close() { events.push('close'); },
    }),
  });
  const targetIdentityHash = supabaseDatabaseTargetIdentityHash(providerBinding);

  const verified = await provider.withFencedTarget({
    connectionString: CONNECTION,
    fenceKey: `supabase-staging-migration:${targetIdentityHash}`,
    binding: providerBinding,
    targetIdentityHash,
  }, async (session) => {
    const schemaHash = await session.inspectSchemaHash();
    await session.executeStatements({
      migrationId: 'provider-protocol',
      phase: 'apply',
      transactionMode: 'transactional',
      statements: [statement('provider-ddl', 'CREATE TABLE public.provider_protocol (id bigint)')],
    });
    const query = verificationQuery('provider-read-only', 'SELECT 1::int AS value');
    query.expectedResultHash = migrationVerificationResultHash([{ value: 1 }]);
    return session.verify({ queries: [query], expectedSchemaHash: schemaHash });
  });

  assert.equal(verified.passed, true);
  assert.match(events[0], /^SELECT pg_advisory_lock/);
  assert.equal(events.filter((event) => event === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 3);
  assert.ok(events.includes('CREATE TABLE public.provider_protocol (id bigint)'));
  assert.deepEqual(events.slice(-3), [
    'ROLLBACK',
    'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
    'close',
  ]);
});

test('receipt binds manifest, target, hashes, statements, verification, and recovery without credentials', async () => {
  const store = new MemoryMigrationStore();
  const receipt = await adapter(store, new FencedFixtureProvider(new FixtureSession()))
    .applyStagingMigration(requestFor());

  assert.equal(receipt.manifestDigest, stagingMigrationManifestDigest(manifest()));
  assert.equal(receipt.target.projectRef, 'rorca-owned-staging');
  assert.equal(receipt.target.bindingGeneration, 9);
  assert.equal(receipt.beforeSchemaHash, INITIAL_SCHEMA_HASH);
  assert.equal(receipt.afterSchemaHash, APPLIED_SCHEMA_HASH);
  assert.equal(receipt.migrations[0].statementOutcomes[0].outcome, 'applied');
  assert.equal(receipt.migrations[0].verification?.passed, true);
  assert.equal(receipt.recoveryProof, null);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(CONNECTION), false);
  assert.equal(serialized.includes('credential-bytes'), false);
  for (const field of ['password', 'connectionString', 'credential', 'secret', 'token', 'apiKey', 'sql']) {
    assert.equal(serialized.includes(`"${field}"`), false);
  }
});
