/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { execute, queryOne } from '../db';
import { ForbiddenError, UnprocessableError } from './errors';

export const DATABASE_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION =
  'rorca.database-authority-provider-adapter.v1' as const;
export const SUPABASE_DATABASE_PROVIDER_ID = 'supabase-database' as const;

export const DatabaseAuthorityCapabilitySchema = z.enum([
  'database.schema.inspect',
  'database.backup.create',
  'database.backup.restore',
  'database.migration.apply.staging',
  'database.migration.apply.production',
  'database.key.rotate.publishable-secret',
  'database.key.migrate.legacy',
  'database.key.rotate.jwt-signing',
  'database.provider.admin',
]);
export type DatabaseAuthorityCapability = z.infer<typeof DatabaseAuthorityCapabilitySchema>;

export const SUPABASE_SCHEMA_INSPECT_CAPABILITIES = Object.freeze([
  'database.schema.inspect',
] as const satisfies readonly DatabaseAuthorityCapability[]);

export const DatabaseCredentialClassSchema = z.enum([
  'database-role',
  'application-anon',
  'application-publishable',
  'application-secret',
  'application-service-role',
]);
export type DatabaseCredentialClass = z.infer<typeof DatabaseCredentialClassSchema>;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const SecretStoreReferenceIdSchema = z.string()
  .min(1)
  .max(1024)
  .regex(/^[a-z][a-z0-9+.-]{1,31}:\/\/[^\s]+$/)
  .refine((value) => !/^postgres(?:ql)?:\/\//i.test(value), {
    message: 'Database connection bytes are not a SecretStore reference',
  });

export const DatabaseResourceIdentitySchema = z.object({
  databaseName: z.string().min(1).max(63),
  endpointFingerprint: Sha256Schema,
}).strict();
export type DatabaseResourceIdentity = z.infer<typeof DatabaseResourceIdentitySchema>;

export const DatabaseRoleProfileSchema = z.object({
  roleFingerprint: Sha256Schema,
  verified: z.boolean(),
  verifiedAt: z.string().datetime({ offset: true }),
  authenticationClass: z.literal('database-role'),
  capabilities: z.array(DatabaseAuthorityCapabilitySchema).min(1),
}).strict();

export const DatabaseSecretReferenceSchema = z.object({
  purpose: z.literal('database-connection'),
  referenceId: SecretStoreReferenceIdSchema,
  fingerprint: Sha256Schema,
  credentialClass: z.literal('database-role'),
}).strict();
export type DatabaseSecretReference = z.infer<typeof DatabaseSecretReferenceSchema>;

/**
 * Safe projection of a core authority binding. The strict schema deliberately
 * has no connection string, password, API key, token, or provider secret field.
 */
export const SupabaseDatabaseProviderBindingSchema = z.object({
  providerId: z.literal(SUPABASE_DATABASE_PROVIDER_ID),
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  bindingStatus: z.enum(['active', 'disabled', 'invalid']),
  projectRef: z.string().min(1).max(255),
  environment: z.enum(['staging', 'production']),
  databaseIdentity: DatabaseResourceIdentitySchema,
  databaseIdentityHash: Sha256Schema,
  bindingGeneration: z.number().int().positive(),
  roleProfile: DatabaseRoleProfileSchema,
  bindingHash: Sha256Schema,
  secretReferences: z.array(DatabaseSecretReferenceSchema).length(1),
}).strict();
export type SupabaseDatabaseProviderBinding = z.infer<typeof SupabaseDatabaseProviderBindingSchema>;

export const SupabaseSchemaInspectionRequestSchema = z.object({
  bindingId: z.string().uuid(),
  workspaceId: z.string().min(1).max(255),
  projectRef: z.string().min(1).max(255),
  environment: z.enum(['staging', 'production']),
  databaseIdentity: DatabaseResourceIdentitySchema,
  bindingGeneration: z.number().int().positive(),
}).strict();
export type SupabaseSchemaInspectionRequest = z.infer<typeof SupabaseSchemaInspectionRequestSchema>;

export type SchemaInventoryKind =
  | 'table'
  | 'column'
  | 'constraint'
  | 'index'
  | 'extension'
  | 'function'
  | 'rls-policy';

export interface SchemaInventoryObject {
  objectId: `sha256:${string}`;
  objectHash: `sha256:${string}`;
  identity: string;
  attributes: Record<string, unknown>;
}

export interface SupabaseSchemaInventory {
  version: 'rorca.supabase-schema-inventory.v1';
  targetIdentityHash: `sha256:${string}`;
  tables: SchemaInventoryObject[];
  columns: SchemaInventoryObject[];
  constraints: SchemaInventoryObject[];
  indexes: SchemaInventoryObject[];
  extensions: SchemaInventoryObject[];
  functions: SchemaInventoryObject[];
  rlsPolicies: SchemaInventoryObject[];
  inventoryHash: `sha256:${string}`;
}

export interface SupabaseSchemaCatalog {
  tables: Array<Record<string, unknown>>;
  columns: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  indexes: Array<Record<string, unknown>>;
  extensions: Array<Record<string, unknown>>;
  functions: Array<Record<string, unknown>>;
  rlsPolicies: Array<Record<string, unknown>>;
}

export interface SupabaseSchemaInspectionReceipt {
  receiptId: string;
  capability: 'database.schema.inspect';
  bindingId: string;
  bindingGeneration: number;
  workspaceId: string;
  projectRef: string;
  environment: 'staging' | 'production';
  targetIdentityHash: `sha256:${string}`;
  inventoryHash: `sha256:${string}`;
  requestHash: `sha256:${string}`;
  connectionReference: {
    referenceId: string;
    fingerprint: `sha256:${string}`;
  };
  objectCounts: Record<'tables' | 'columns' | 'constraints' | 'indexes' | 'extensions' | 'functions' | 'rlsPolicies', number>;
  inspectedAt: string;
}

export interface SupabaseSchemaInspectionResult {
  inventory: SupabaseSchemaInventory;
  receipt: SupabaseSchemaInspectionReceipt;
}

/** Secret bytes exist only in the return value and must never be persisted or logged. */
export interface DatabaseAuthoritySecretStore {
  resolveDatabaseConnection(referenceId: string): Promise<string | null>;
}

interface InspectionConnection {
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
}

interface BindingRow {
  id: string;
  workspace_id: string;
  provider_id: string;
  provider_subject_ref: string;
  environment: string;
  resource_identity: unknown;
  resource_identity_hash: string;
  binding_generation: string | number;
  binding_status: string;
  role_profile: unknown;
  binding_hash: string;
  secret_references: unknown;
}

type BindingReader = (bindingId: string) => Promise<SupabaseDatabaseProviderBinding | null>;
type ConnectionFactory = (connectionString: string) => Promise<InspectionConnection>;
type ReceiptWriter = (receipt: SupabaseSchemaInspectionReceipt) => Promise<void>;

export interface SupabaseDatabaseAdapterDependencies {
  secretStore: DatabaseAuthoritySecretStore;
  readBinding?: BindingReader;
  connect?: ConnectionFactory;
  writeReceipt?: ReceiptWriter;
  now?: () => Date;
  createReceiptId?: () => string;
}

export interface DatabaseAuthorityProviderAdapter {
  readonly contractVersion: typeof DATABASE_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly providerId: typeof SUPABASE_DATABASE_PROVIDER_ID;
  readonly capabilities: readonly DatabaseAuthorityCapability[];
  getProviderBinding(bindingId: string): Promise<SupabaseDatabaseProviderBinding | null>;
  inspectSchema(request: SupabaseSchemaInspectionRequest): Promise<SupabaseSchemaInspectionResult>;
  execute(input: { operation: string; request: SupabaseSchemaInspectionRequest }): Promise<SupabaseSchemaInspectionResult>;
}

const CORE_BINDING_SQL = `
  SELECT b.id, b.workspace_id, b.provider_id, b.provider_subject_ref,
         b.environment, b.resource_identity, b.resource_identity_hash,
         b.binding_generation, b.binding_status, b.role_profile, b.binding_hash,
         COALESCE(
           jsonb_agg(jsonb_build_object(
             'purpose', reference.purpose,
             'referenceId', reference.reference_id,
             'fingerprint', reference.reference_fingerprint,
             'credentialClass', reference.credential_class
           ) ORDER BY reference.purpose) FILTER (WHERE reference.binding_id IS NOT NULL),
           '[]'::jsonb
         ) AS secret_references
    FROM rorca.authority_provider_bindings b
    LEFT JOIN rorca.authority_secret_references reference
      ON reference.binding_id = b.id AND reference.workspace_id = b.workspace_id
   WHERE b.id = $1
   GROUP BY b.id`;

const TARGET_IDENTITY_SQL = `SELECT
  current_database() AS database_name,
  current_user AS database_role,
  current_setting('transaction_read_only') AS transaction_read_only`;

/** Fixed catalog reads. No caller-controlled statement is accepted by inspect. */
export const SUPABASE_SCHEMA_INSPECTION_SQL = Object.freeze({
  tables: `SELECT n.nspname AS schema_name, c.relname AS table_name,
                  c.relkind AS table_kind, c.relpersistence AS persistence,
                  c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
             FROM pg_catalog.pg_class c
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r', 'p')
              AND n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname !~ '^pg_toast'
            ORDER BY n.nspname, c.relname`,
  columns: `SELECT n.nspname AS schema_name, c.relname AS table_name,
                   a.attname AS column_name, a.attnum AS ordinal_position,
                   pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                   a.attnotnull AS not_null,
                   pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) AS default_expression,
                   a.attidentity AS identity_kind, a.attgenerated AS generated_kind,
                   coll.collname AS collation_name
              FROM pg_catalog.pg_attribute a
              JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
         LEFT JOIN pg_catalog.pg_collation coll ON coll.oid = a.attcollation AND a.attcollation <> 0
             WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname !~ '^pg_toast'
             ORDER BY n.nspname, c.relname, a.attnum`,
  constraints: `SELECT n.nspname AS schema_name, c.relname AS table_name,
                       con.conname AS constraint_name, con.contype AS constraint_type,
                       pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
                       con.condeferrable AS deferrable, con.condeferred AS initially_deferred,
                       con.convalidated AS validated
                  FROM pg_catalog.pg_constraint con
                  JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
                  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
                   AND n.nspname !~ '^pg_toast'
                 ORDER BY n.nspname, c.relname, con.conname`,
  indexes: `SELECT n.nspname AS schema_name, idx.relname AS index_name,
                   tbl.relname AS table_name, i.indisunique AS is_unique,
                   i.indisprimary AS is_primary, i.indisvalid AS is_valid,
                   pg_catalog.pg_get_indexdef(i.indexrelid, 0, true) AS definition
              FROM pg_catalog.pg_index i
              JOIN pg_catalog.pg_class idx ON idx.oid = i.indexrelid
              JOIN pg_catalog.pg_class tbl ON tbl.oid = i.indrelid
              JOIN pg_catalog.pg_namespace n ON n.oid = tbl.relnamespace
             WHERE tbl.relkind IN ('r', 'p')
               AND n.nspname NOT IN ('pg_catalog', 'information_schema')
               AND n.nspname !~ '^pg_toast'
             ORDER BY n.nspname, idx.relname`,
  extensions: `SELECT ext.extname AS extension_name, ext.extversion AS version,
                       n.nspname AS schema_name, ext.extrelocatable AS relocatable
                  FROM pg_catalog.pg_extension ext
                  JOIN pg_catalog.pg_namespace n ON n.oid = ext.extnamespace
                 ORDER BY ext.extname`,
  functions: `SELECT n.nspname AS schema_name, p.proname AS function_name,
                      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
                      pg_catalog.pg_get_function_result(p.oid) AS result_type,
                      lang.lanname AS language, p.prokind AS function_kind,
                      p.provolatile AS volatility, p.prosecdef AS security_definer,
                      p.proleakproof AS leakproof, p.proparallel AS parallel_safety,
                      pg_catalog.pg_get_functiondef(p.oid) AS definition
                 FROM pg_catalog.pg_proc p
                 JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                 JOIN pg_catalog.pg_language lang ON lang.oid = p.prolang
                WHERE p.prokind IN ('f', 'p', 'w')
                  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  AND n.nspname !~ '^pg_toast'
                ORDER BY n.nspname, p.proname,
                         pg_catalog.pg_get_function_identity_arguments(p.oid)`,
  rlsPolicies: `SELECT schemaname AS schema_name, tablename AS table_name,
                       policyname AS policy_name, permissive, roles, cmd AS command,
                       qual AS using_expression, with_check AS check_expression
                  FROM pg_catalog.pg_policies
                 WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
                   AND schemaname !~ '^pg_toast'
                 ORDER BY schemaname, tablename, policyname`,
} as const);

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite catalog number');
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('Unsupported catalog value');
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function databaseCredentialFingerprint(secret: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('hex')}`;
}

export function databaseResourceIdentityHash(identity: DatabaseResourceIdentity): `sha256:${string}` {
  return digest(identity);
}

export function databaseRoleFingerprint(roleName: string): `sha256:${string}` {
  return digest(roleName);
}

export function databaseEndpointFingerprint(connectionString: string): `sha256:${string}` {
  let endpoint: { hostname: string; port: string; database: string };
  try {
    const url = new URL(connectionString);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new TypeError('invalid protocol');
    endpoint = {
      hostname: url.hostname.toLowerCase(),
      port: url.port || '5432',
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    };
  } catch {
    throw new UnprocessableError(
      'Database authority SecretStore reference did not resolve to a PostgreSQL connection',
      'DATABASE_AUTHORITY_REFERENCE_INVALID',
    );
  }
  return digest(endpoint);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite catalog number');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, normalizeValue(record[key])]));
  }
  throw new TypeError('Unsupported catalog value');
}

function identityComponentsFor(kind: SchemaInventoryKind, row: Record<string, unknown>): readonly string[] {
  const text = (key: string): string => String(row[key] ?? '');
  switch (kind) {
    case 'table': return [text('schema_name'), text('table_name')];
    case 'column': return [text('schema_name'), text('table_name'), text('column_name')];
    case 'constraint': return [text('schema_name'), text('table_name'), text('constraint_name')];
    case 'index': return [text('schema_name'), text('index_name')];
    case 'extension': return [text('extension_name')];
    case 'function': return [text('schema_name'), text('function_name'), text('identity_arguments')];
    case 'rls-policy': return [text('schema_name'), text('table_name'), text('policy_name')];
  }
}

function displayIdentity(kind: SchemaInventoryKind, components: readonly string[]): string {
  switch (kind) {
    case 'table': return `${components[0]}.${components[1]}`;
    case 'column': return `${components[0]}.${components[1]}.${components[2]}`;
    case 'constraint': return `${components[0]}.${components[1]}.${components[2]}`;
    case 'index': return `${components[0]}.${components[1]}`;
    case 'extension': return components[0] ?? '';
    case 'function': return `${components[0]}.${components[1]}(${components[2]})`;
    case 'rls-policy': return `${components[0]}.${components[1]}.${components[2]}`;
  }
}

function inventoryObjects(
  kind: SchemaInventoryKind,
  rows: Array<Record<string, unknown>>,
  scope: Record<string, unknown>,
): SchemaInventoryObject[] {
  return rows.map((row) => {
    const attributes = normalizeValue(row) as Record<string, unknown>;
    const identityComponents = identityComponentsFor(kind, attributes);
    const identity = displayIdentity(kind, identityComponents);
    return {
      objectId: digest({ ...scope, kind, identityComponents }),
      objectHash: digest({ kind, identityComponents, attributes }),
      identity,
      attributes,
    };
  }).sort((left, right) => {
    if (left.identity < right.identity) return -1;
    if (left.identity > right.identity) return 1;
    return left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0;
  });
}

export function supabaseDatabaseTargetIdentityHash(
  binding: Pick<SupabaseDatabaseProviderBinding, 'providerId' | 'projectRef' | 'environment' | 'databaseIdentity'>,
): `sha256:${string}` {
  return digest({
    providerId: binding.providerId,
    projectRef: binding.projectRef,
    environment: binding.environment,
    databaseIdentity: binding.databaseIdentity,
  });
}

export function buildSupabaseSchemaInventory(
  targetIdentityHash: `sha256:${string}`,
  catalog: SupabaseSchemaCatalog,
): SupabaseSchemaInventory {
  const scope = { targetIdentityHash };
  const inventoryWithoutHash = {
    version: 'rorca.supabase-schema-inventory.v1' as const,
    targetIdentityHash,
    tables: inventoryObjects('table', catalog.tables, scope),
    columns: inventoryObjects('column', catalog.columns, scope),
    constraints: inventoryObjects('constraint', catalog.constraints, scope),
    indexes: inventoryObjects('index', catalog.indexes, scope),
    extensions: inventoryObjects('extension', catalog.extensions, scope),
    functions: inventoryObjects('function', catalog.functions, scope),
    rlsPolicies: inventoryObjects('rls-policy', catalog.rlsPolicies, scope),
  };
  return {
    ...inventoryWithoutHash,
    inventoryHash: digest(inventoryWithoutHash),
  };
}

function preflightFailure(reason: string): UnprocessableError {
  return new UnprocessableError(
    'Supabase database authority binding preflight rejected the request',
    'DATABASE_AUTHORITY_PREFLIGHT_REJECTED',
    { reason },
  );
}

export async function readSupabaseDatabaseProviderBinding(
  bindingId: string,
): Promise<SupabaseDatabaseProviderBinding | null> {
  const row = await queryOne<BindingRow>(CORE_BINDING_SQL, [bindingId]);
  if (!row) return null;
  return SupabaseDatabaseProviderBindingSchema.parse({
    providerId: row.provider_id,
    bindingId: row.id,
    workspaceId: row.workspace_id,
    bindingStatus: row.binding_status,
    projectRef: row.provider_subject_ref,
    environment: row.environment,
    databaseIdentity: asObject(row.resource_identity),
    databaseIdentityHash: row.resource_identity_hash,
    bindingGeneration: Number(row.binding_generation),
    roleProfile: asObject(row.role_profile),
    bindingHash: row.binding_hash,
    secretReferences: row.secret_references,
  });
}

async function connectPostgres(connectionString: string): Promise<InspectionConnection> {
  const client = new Client({ connectionString });
  await client.connect();
  return {
    query: async (sql) => {
      const result = await client.query<Record<string, unknown>>(sql);
      return { rows: result.rows };
    },
    close: async () => client.end(),
  };
}

async function persistReceipt(receipt: SupabaseSchemaInspectionReceipt): Promise<void> {
  await execute(
    `INSERT INTO rorca.authority_operation_receipts (
       id, workspace_id, binding_id, provider_id, capability, binding_generation,
       request_hash, target_identity_hash, result_hash,
       secret_reference_id, secret_reference_fingerprint, redacted_evidence
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      receipt.receiptId, receipt.workspaceId, receipt.bindingId, SUPABASE_DATABASE_PROVIDER_ID,
      receipt.capability, receipt.bindingGeneration, receipt.requestHash,
      receipt.targetIdentityHash, receipt.inventoryHash,
      receipt.connectionReference.referenceId, receipt.connectionReference.fingerprint,
      { objectCounts: receipt.objectCounts, inspectedAt: receipt.inspectedAt },
    ],
  );
}

function sameIdentity(left: DatabaseResourceIdentity, right: DatabaseResourceIdentity): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertBindingPreflight(
  binding: SupabaseDatabaseProviderBinding | null,
  request: SupabaseSchemaInspectionRequest,
): asserts binding is SupabaseDatabaseProviderBinding {
  if (!binding) throw preflightFailure('binding_not_found');
  if (binding.providerId !== SUPABASE_DATABASE_PROVIDER_ID) throw preflightFailure('wrong_provider');
  if (binding.bindingId !== request.bindingId) throw preflightFailure('wrong_binding');
  if (binding.workspaceId !== request.workspaceId) throw preflightFailure('wrong_workspace');
  if (binding.projectRef !== request.projectRef) throw preflightFailure('wrong_project');
  if (binding.environment !== request.environment) throw preflightFailure('wrong_environment');
  if (!sameIdentity(binding.databaseIdentity, request.databaseIdentity)) throw preflightFailure('wrong_database');
  if (binding.databaseIdentityHash !== digest(binding.databaseIdentity)) throw preflightFailure('database_identity_hash_invalid');
  if (binding.bindingGeneration !== request.bindingGeneration) throw preflightFailure('stale_generation');
  if (binding.bindingStatus !== 'active') throw preflightFailure('binding_inactive');
  if (!binding.roleProfile.verified) throw preflightFailure('role_unverified');
  if (binding.roleProfile.authenticationClass !== 'database-role') throw preflightFailure('application_credential_forbidden');
  if (!binding.roleProfile.capabilities.includes('database.schema.inspect')) throw preflightFailure('capability_missing');
  const reference = binding.secretReferences[0];
  if (!reference || reference.purpose !== 'database-connection') throw preflightFailure('reference_missing');
  if (reference.credentialClass !== 'database-role') throw preflightFailure('application_credential_forbidden');
}

/**
 * Generic Supabase database AuthorityProviderAdapter.
 *
 * Implements SMC-001 requirements:
 * - Read-only schema inspection via REPEATABLE READ transaction.
 * - Strict preflight validation of binding, project, environment, and role.
 * - Reference-only data model with no credential bytes.
 * - Rejection of all non-inspect operations.
 */
export class SupabaseDatabaseAuthorityProviderAdapter implements DatabaseAuthorityProviderAdapter {
  readonly contractVersion = DATABASE_AUTHORITY_PROVIDER_ADAPTER_CONTRACT_VERSION;
  readonly providerId = SUPABASE_DATABASE_PROVIDER_ID;
  readonly capabilities = SUPABASE_SCHEMA_INSPECT_CAPABILITIES;

  private readonly readBinding: BindingReader;
  private readonly connect: ConnectionFactory;
  private readonly writeReceipt: ReceiptWriter;
  private readonly now: () => Date;
  private readonly createReceiptId: () => string;

  constructor(private readonly dependencies: SupabaseDatabaseAdapterDependencies) {
    this.readBinding = dependencies.readBinding ?? readSupabaseDatabaseProviderBinding;
    this.connect = dependencies.connect ?? connectPostgres;
    this.writeReceipt = dependencies.writeReceipt ?? persistReceipt;
    this.now = dependencies.now ?? (() => new Date());
    this.createReceiptId = dependencies.createReceiptId ?? randomUUID;
  }

  async getProviderBinding(bindingId: string): Promise<SupabaseDatabaseProviderBinding | null> {
    return this.readBinding(bindingId);
  }

  async execute(input: { operation: string; request: SupabaseSchemaInspectionRequest }): Promise<SupabaseSchemaInspectionResult> {
    if (input.operation !== 'database.schema.inspect') {
      throw new ForbiddenError('Supabase inspect authority cannot execute provider mutations', {
        requiredCapability: 'database.schema.inspect',
      });
    }
    return this.inspectSchema(input.request);
  }

  async inspectSchema(rawRequest: SupabaseSchemaInspectionRequest): Promise<SupabaseSchemaInspectionResult> {
    const request = SupabaseSchemaInspectionRequestSchema.parse(rawRequest);
    const binding = await this.readBinding(request.bindingId);
    assertBindingPreflight(binding, request);
    const reference = binding.secretReferences[0];

    let connectionString: string | null;
    try {
      connectionString = await this.dependencies.secretStore.resolveDatabaseConnection(reference.referenceId);
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

    let connection: InspectionConnection | undefined;
    let transactionActive = false;
    try {
      connection = await this.connect(connectionString);
      await connection.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionActive = true;
      await connection.query("SET LOCAL statement_timeout = '15s'");
      const target = (await connection.query(TARGET_IDENTITY_SQL)).rows[0];
      if (!target
          || target.transaction_read_only !== 'on'
          || target.database_name !== binding.databaseIdentity.databaseName) {
        throw preflightFailure('connected_database_mismatch');
      }
      if (digest(String(target.database_role ?? '')) !== binding.roleProfile.roleFingerprint) {
        throw preflightFailure('connected_role_mismatch');
      }

      const catalog: SupabaseSchemaCatalog = {
        tables: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.tables)).rows,
        columns: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.columns)).rows,
        constraints: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.constraints)).rows,
        indexes: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.indexes)).rows,
        extensions: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.extensions)).rows,
        functions: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.functions)).rows,
        rlsPolicies: (await connection.query(SUPABASE_SCHEMA_INSPECTION_SQL.rlsPolicies)).rows,
      };
      await connection.query('COMMIT');
      transactionActive = false;

      const targetIdentityHash = supabaseDatabaseTargetIdentityHash(binding);
      const inventory = buildSupabaseSchemaInventory(targetIdentityHash, catalog);
      const inspectedAt = this.now().toISOString();
      const requestHash = digest({ capability: 'database.schema.inspect', request, bindingHash: binding.bindingHash });
      const receipt: SupabaseSchemaInspectionReceipt = {
        receiptId: this.createReceiptId(),
        capability: 'database.schema.inspect',
        bindingId: binding.bindingId,
        bindingGeneration: binding.bindingGeneration,
        workspaceId: binding.workspaceId,
        projectRef: binding.projectRef,
        environment: binding.environment,
        targetIdentityHash,
        inventoryHash: inventory.inventoryHash,
        requestHash,
        connectionReference: {
          referenceId: reference.referenceId,
          fingerprint: reference.fingerprint,
        },
        objectCounts: {
          tables: inventory.tables.length,
          columns: inventory.columns.length,
          constraints: inventory.constraints.length,
          indexes: inventory.indexes.length,
          extensions: inventory.extensions.length,
          functions: inventory.functions.length,
          rlsPolicies: inventory.rlsPolicies.length,
        },
        inspectedAt,
      };
      await this.writeReceipt(receipt);
      return { inventory, receipt };
    } catch (error) {
      if (connection && transactionActive) {
        try { await connection.query('ROLLBACK'); } catch { /* destroy the connection below */ }
      }
      if (error instanceof UnprocessableError || error instanceof ForbiddenError) throw error;
      throw new UnprocessableError(
        'Supabase schema inspection failed inside the read-only database boundary',
        'DATABASE_SCHEMA_INSPECTION_FAILED',
      );
    } finally {
      if (connection) {
        try { await connection.close(); } catch { /* closed connections carry no reusable authority */ }
      }
    }
  }
}
