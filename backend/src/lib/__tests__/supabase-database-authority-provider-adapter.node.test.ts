/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../errors';
import {
  SUPABASE_SCHEMA_INSPECTION_SQL,
  SupabaseDatabaseAuthorityProviderAdapter,
  SupabaseDatabaseProviderBindingSchema,
  buildSupabaseSchemaInventory,
  databaseCredentialFingerprint,
  databaseEndpointFingerprint,
  databaseResourceIdentityHash,
  databaseRoleFingerprint,
  type SupabaseDatabaseProviderBinding,
  type SupabaseSchemaInspectionReceipt,
  type SupabaseSchemaInspectionRequest,
} from '../supabase-database-authority-provider-adapter';

const CONNECTION = 'postgresql://schema_inspector:credential-bytes@db.fixture.supabase.co:5432/postgres?sslmode=require';
const BINDING_ID = '11111111-1111-4111-8111-111111111111';
const RECEIPT_ID = '22222222-2222-4222-8222-222222222222';
const HASH = `sha256:${'a'.repeat(64)}` as const;
const APPLICATION_CREDENTIAL_CLASSES = [
  'application-anon',
  'application-publishable',
  'application-secret',
  'application-service-role',
] as const;
const databaseIdentity = {
  databaseName: 'postgres',
  endpointFingerprint: databaseEndpointFingerprint(CONNECTION),
};

function binding(overrides: Partial<SupabaseDatabaseProviderBinding> = {}): SupabaseDatabaseProviderBinding {
  return {
    providerId: 'supabase-database',
    bindingId: BINDING_ID,
    workspaceId: 'rorca-fixture',
    bindingStatus: 'active',
    projectRef: 'rorca-owned-fixture',
    environment: 'staging',
    databaseIdentity,
    databaseIdentityHash: databaseResourceIdentityHash(databaseIdentity),
    bindingGeneration: 7,
    roleProfile: {
      roleFingerprint: databaseRoleFingerprint('schema_inspector'),
      verified: true,
      verifiedAt: '2026-08-21T12:00:00.000Z',
      authenticationClass: 'database-role',
      capabilities: ['database.schema.inspect'],
    },
    bindingHash: HASH,
    secretReferences: [{
      purpose: 'database-connection',
      referenceId: 'secret-store://rorca-fixture/database/schema-inspector/v7',
      fingerprint: databaseCredentialFingerprint(CONNECTION),
      credentialClass: 'database-role',
    }],
    ...overrides,
  };
}

const request: SupabaseSchemaInspectionRequest = {
  bindingId: BINDING_ID,
  workspaceId: 'rorca-fixture',
  projectRef: 'rorca-owned-fixture',
  environment: 'staging',
  databaseIdentity,
  bindingGeneration: 7,
};

const catalogRows = {
  tables: [
    { schema_name: 'public', table_name: 'zeta', table_kind: 'r', persistence: 'p', rls_enabled: false, rls_forced: false },
    { schema_name: 'public', table_name: 'alpha', table_kind: 'r', persistence: 'p', rls_enabled: true, rls_forced: false },
  ],
  columns: [
    { schema_name: 'public', table_name: 'alpha', column_name: 'id', ordinal_position: 1, data_type: 'uuid', not_null: true, default_expression: 'gen_random_uuid()', identity_kind: '', generated_kind: '', collation_name: null },
  ],
  constraints: [
    { schema_name: 'public', table_name: 'alpha', constraint_name: 'alpha_pkey', constraint_type: 'p', definition: 'PRIMARY KEY (id)', deferrable: false, initially_deferred: false, validated: true },
  ],
  indexes: [
    { schema_name: 'public', index_name: 'alpha_pkey', table_name: 'alpha', is_unique: true, is_primary: true, is_valid: true, definition: 'CREATE UNIQUE INDEX alpha_pkey ON public.alpha USING btree (id)' },
  ],
  extensions: [
    { extension_name: 'pgcrypto', version: '1.3', schema_name: 'extensions', relocatable: true },
  ],
  functions: [
    { schema_name: 'public', function_name: 'alpha_fn', identity_arguments: 'uuid', result_type: 'void', language: 'sql', function_kind: 'f', volatility: 'v', security_definer: false, leakproof: false, parallel_safety: 'u', definition: 'CREATE FUNCTION public.alpha_fn(uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$' },
  ],
  rlsPolicies: [
    { schema_name: 'public', table_name: 'alpha', policy_name: 'alpha_read', permissive: 'PERMISSIVE', roles: ['authenticated'], command: 'SELECT', using_expression: 'true', check_expression: null },
  ],
};

function fakeConnection(reverseTables = false) {
  const statements: string[] = [];
  let closed = false;
  return {
    statements,
    get closed() { return closed; },
    connection: {
      async query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
        statements.push(sql);
        if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.includes("current_setting('transaction_read_only')")) {
          return { rows: [{ database_name: 'postgres', database_role: 'schema_inspector', transaction_read_only: 'on' }] };
        }
        for (const [key, statement] of Object.entries(SUPABASE_SCHEMA_INSPECTION_SQL)) {
          if (sql === statement) {
            const rows = catalogRows[key as keyof typeof catalogRows];
            return { rows: key === 'tables' && reverseTables ? [...rows].reverse() : [...rows] };
          }
        }
        throw new Error(`Unexpected inspection SQL: ${sql}`);
      },
      async close(): Promise<void> { closed = true; },
    },
  };
}

function adapterFor(
  projectedBinding: SupabaseDatabaseProviderBinding = binding(),
  options: { resolved?: string | null; reverseTables?: boolean } = {},
) {
  const fake = fakeConnection(options.reverseTables);
  const receipts: SupabaseSchemaInspectionReceipt[] = [];
  let resolutions = 0;
  let connections = 0;
  const adapter = new SupabaseDatabaseAuthorityProviderAdapter({
    secretStore: {
      async resolveDatabaseConnection() {
        resolutions += 1;
        return options.resolved === undefined ? CONNECTION : options.resolved;
      },
    },
    readBinding: async () => projectedBinding,
    connect: async () => {
      connections += 1;
      return fake.connection;
    },
    writeReceipt: async (receipt) => { receipts.push(receipt); },
    now: () => new Date('2026-08-21T12:01:00.000Z'),
    createReceiptId: () => RECEIPT_ID,
  });
  return { adapter, fake, receipts, resolutions: () => resolutions, connections: () => connections };
}

async function expectPreflightReason(
  projectedBinding: SupabaseDatabaseProviderBinding,
  requested: SupabaseSchemaInspectionRequest,
  reason: string,
): Promise<void> {
  const fixture = adapterFor(projectedBinding);
  await assert.rejects(
    fixture.adapter.inspectSchema(requested),
    (error: unknown) => {
      if (!(error instanceof AppError)) return false;
      return error.code === 'DATABASE_AUTHORITY_PREFLIGHT_REJECTED'
        && error.details?.reason === reason;
    },
  );
  assert.equal(fixture.resolutions(), 0, 'scope/profile rejection must happen before SecretStore resolution');
  assert.equal(fixture.connections(), 0, 'scope/profile rejection must happen before database connection');
}

test('binding preflight rejects wrong scope, target, generation, role, capability, and application credentials', async () => {
  await expectPreflightReason(binding(), { ...request, workspaceId: 'other-workspace' }, 'wrong_workspace');
  await expectPreflightReason(binding(), { ...request, projectRef: 'other-project' }, 'wrong_project');
  await expectPreflightReason(binding(), { ...request, environment: 'production' }, 'wrong_environment');
  await expectPreflightReason(binding(), {
    ...request,
    databaseIdentity: { ...databaseIdentity, databaseName: 'other_database' },
  }, 'wrong_database');
  await expectPreflightReason(binding(), { ...request, bindingGeneration: 6 }, 'stale_generation');
  await expectPreflightReason(binding({
    roleProfile: { ...binding().roleProfile, verified: false },
  }), request, 'role_unverified');
  await expectPreflightReason(binding({
    roleProfile: { ...binding().roleProfile, capabilities: ['database.backup.create'] },
  }), request, 'capability_missing');
  for (const authenticationClass of APPLICATION_CREDENTIAL_CLASSES) {
    await expectPreflightReason(binding({
      roleProfile: {
        ...binding().roleProfile,
        authenticationClass,
      } as unknown as SupabaseDatabaseProviderBinding['roleProfile'],
    }), request, 'application_credential_forbidden');
    await expectPreflightReason(binding({
      secretReferences: [{
        ...binding().secretReferences[0],
        credentialClass: authenticationClass,
      }] as unknown as SupabaseDatabaseProviderBinding['secretReferences'],
    }), request, 'application_credential_forbidden');
  }
});

test('unresolved and changed SecretStore references fail before connecting and expose no credential', async () => {
  const unresolved = adapterFor(binding(), { resolved: null });
  await assert.rejects(unresolved.adapter.inspectSchema(request), (error: unknown) => {
    return error instanceof AppError && error.details?.reason === 'reference_unresolved';
  });
  assert.equal(unresolved.connections(), 0);

  const changed = adapterFor(binding(), {
    resolved: 'postgresql://schema_inspector:different@db.fixture.supabase.co:5432/postgres',
  });
  await assert.rejects(changed.adapter.inspectSchema(request), (error: unknown) => {
    assert.equal(JSON.stringify(error).includes('different'), false);
    return error instanceof AppError && error.details?.reason === 'reference_fingerprint_mismatch';
  });
  assert.equal(changed.connections(), 0);
});

test('schema inspection is fixed, read-only, complete, deterministic, and reference-only', async () => {
  const first = adapterFor(binding());
  const second = adapterFor(binding(), { reverseTables: true });
  const firstResult = await first.adapter.inspectSchema(request);
  const secondResult = await second.adapter.inspectSchema(request);

  assert.deepEqual(firstResult.inventory, secondResult.inventory);
  assert.deepEqual(Object.keys(firstResult.inventory).sort(), [
    'columns', 'constraints', 'extensions', 'functions', 'indexes', 'inventoryHash',
    'rlsPolicies', 'tables', 'targetIdentityHash', 'version',
  ]);
  assert.deepEqual(firstResult.inventory.tables.map((entry) => entry.identity), ['public.alpha', 'public.zeta']);
  for (const entries of [
    firstResult.inventory.tables,
    firstResult.inventory.columns,
    firstResult.inventory.constraints,
    firstResult.inventory.indexes,
    firstResult.inventory.extensions,
    firstResult.inventory.functions,
    firstResult.inventory.rlsPolicies,
  ]) {
    for (const entry of entries) {
      assert.match(entry.objectId, /^sha256:[0-9a-f]{64}$/);
      assert.match(entry.objectHash, /^sha256:[0-9a-f]{64}$/);
    }
  }
  assert.match(firstResult.inventory.inventoryHash, /^sha256:[0-9a-f]{64}$/);

  const statements = first.fake.statements;
  assert.equal(statements[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(statements.at(-1), 'COMMIT');
  assert.equal(statements.filter((sql) => sql.trimStart().startsWith('SELECT')).length, 8);
  assert.equal(statements.some((sql) => /^\s*(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|COPY|CALL|DO|VACUUM|REINDEX|CLUSTER|GRANT|REVOKE)\b/i.test(sql)), false);
  assert.equal(first.fake.closed, true);

  assert.deepEqual(first.receipts, [firstResult.receipt]);
  assert.deepEqual(firstResult.receipt.connectionReference, binding().secretReferences[0] && {
    referenceId: binding().secretReferences[0].referenceId,
    fingerprint: binding().secretReferences[0].fingerprint,
  });
  const serialized = JSON.stringify(firstResult);
  assert.equal(serialized.includes('credential-bytes'), false);
  assert.equal(serialized.includes(CONNECTION), false);
  assert.equal(serialized.includes('password'), false);
});

test('stable object IDs distinguish quoted PostgreSQL identifiers with the same display label', () => {
  const catalog = {
    tables: [
      { schema_name: 'a', table_name: 'b.c' },
      { schema_name: 'a.b', table_name: 'c' },
    ],
    columns: [],
    constraints: [],
    indexes: [],
    extensions: [],
    functions: [],
    rlsPolicies: [],
  };
  const first = buildSupabaseSchemaInventory(HASH, catalog);
  const reversed = buildSupabaseSchemaInventory(HASH, {
    ...catalog,
    tables: [...catalog.tables].reverse(),
  });

  assert.deepEqual(first, reversed);
  assert.deepEqual(first.tables.map((entry) => entry.identity), ['a.b.c', 'a.b.c']);
  assert.notEqual(first.tables[0]?.objectId, first.tables[1]?.objectId);
});

test('inspect authority cannot dispatch mutation, backup, restore, migration, rotation, or administration', async () => {
  const fixture = adapterFor(binding());
  assert.deepEqual(fixture.adapter.capabilities, ['database.schema.inspect']);
  for (const operation of [
    'database.backup.create',
    'database.backup.restore',
    'database.migration.apply.staging',
    'database.migration.apply.production',
    'database.key.rotate.publishable-secret',
    'database.key.migrate.legacy',
    'database.key.rotate.jwt-signing',
    'database.provider.admin',
    'database.sql.execute',
  ]) {
    await assert.rejects(
      fixture.adapter.execute({ operation, request }),
      (error: unknown) => error instanceof AppError && error.code === 'FORBIDDEN',
    );
  }
  assert.equal(fixture.resolutions(), 0);
  assert.equal(fixture.connections(), 0);
});

test('safe binding schema rejects credential-value fields', () => {
  const safe = binding();
  for (const field of ['connectionString', 'password', 'token', 'apiKey', 'secret', 'serviceRoleKey']) {
    assert.throws(() => SupabaseDatabaseProviderBindingSchema.parse({ ...safe, [field]: 'credential-bytes' }));
  }
  assert.throws(() => SupabaseDatabaseProviderBindingSchema.parse({
    ...safe,
    secretReferences: [{ ...safe.secretReferences[0], referenceId: CONNECTION }],
  }));
  for (const authenticationClass of APPLICATION_CREDENTIAL_CLASSES) {
    assert.throws(() => SupabaseDatabaseProviderBindingSchema.parse({
      ...safe,
      roleProfile: { ...safe.roleProfile, authenticationClass },
    }));
    assert.throws(() => SupabaseDatabaseProviderBindingSchema.parse({
      ...safe,
      secretReferences: [{ ...safe.secretReferences[0], credentialClass: authenticationClass }],
    }));
  }
  assert.equal(JSON.stringify(safe).includes('credential-bytes'), false);
});
