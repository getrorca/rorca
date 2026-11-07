/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Invocation-bound PostgreSQL test authority. Fixed/shared test identities are forbidden. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { observeExactProcessInstance } from './process-instance-identity';

export const TEST_DATABASE_SUFFIX = '_test';
export const JEST_INVOCATION_PREFIX = 'rorca-jest-invocation-';
export const TEST_DB_STATE_SCHEMA_VERSION = 2 as const;
const JEST_DATABASE_NAME = /^rorca_jest_[a-f0-9]{24}_test$/;
const CERTIFICATION_DATABASE_NAME = /^rorca_[a-z0-9][a-z0-9_]{7,55}_test$/;
const FORBIDDEN_DATABASES = new Set([
  'rorca', 'postgres', 'template0', 'template1', 'rorca_test', 'rorca_cert_test',
]);

interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface IsolatedTestDatabaseState {
  schemaVersion: typeof TEST_DB_STATE_SCHEMA_VERSION;
  invocationId: string;
  ownerPid: number;
  ownerProcessStartIdentity: string;
  ownerInstanceNonce: string;
  root: string;
  leaseFile: string;
  leaseTokenHash: string;
  stateFile: string;
  status: 'allocated' | 'starting' | 'ready' | 'cleaning' | 'cleaned' | 'failed';
  mode?: 'local-cluster' | 'docker-container';
  pgBin?: string;
  dataDirectory?: string;
  socketDirectory?: string;
  containerName?: string;
  containerId?: string;
  adminDatabaseUrl?: string;
  databaseUrl?: string;
  migrationDatabaseUrl?: string;
  canonicalWriterDatabaseUrl?: string;
  database?: string;
  user?: string;
  marker?: string;
  applicationName?: string;
  systemIdentifier?: string;
  serverVersion?: string;
  extensions?: string[];
}

export interface ConnectedTestDatabase {
  database: string;
  user: string;
  owner: string;
  marker: string;
  systemIdentifier: string;
  dataDirectory: string;
  postgresMajor: 16;
  superuser: false;
  serverAddress: string | null;
  serverPort: number | null;
  productionDatabaseExists: boolean;
  productionConnect: boolean;
}

interface ConnectedTruthRow {
  database: string;
  user: string;
  owner: string;
  marker: string | null;
  system_identifier: string;
  data_directory: string;
  server_version: string;
  listen_addresses: string;
  server_address: string | null;
  server_port: number | string | null;
  rolsuper: boolean;
  rolcanlogin: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  production_database_exists: boolean;
  production_connect: boolean;
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function assertPrivateRegularFile(filePath: string, label: string): void {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`[test-db-safety] ${label} must be a regular non-symbolic file`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`[test-db-safety] ${label} must have mode 0600`);
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`[test-db-safety] ${label} has an unexpected owner`);
  }
}

function assertInvocationRoot(root: string, invocationId: string): string {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== temporaryRoot
    || path.basename(resolved) !== `${JEST_INVOCATION_PREFIX}${invocationId}`) {
    throw new Error('[test-db-safety] Invocation root is outside the exact temporary namespace');
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error('[test-db-safety] Invocation root must be a private non-symbolic directory');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('[test-db-safety] Invocation root has an unexpected owner');
  }
  if (fs.realpathSync(resolved) !== resolved) throw new Error('[test-db-safety] Invocation root changed identity');
  return resolved;
}

export function databaseNameFromUrl(databaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('[test-db-safety] Test database URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('[test-db-safety] Test database URL must use postgres:// or postgresql://');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database || database.includes('/')) throw new Error('[test-db-safety] Test database URL must name exactly one database');
  return database;
}

export function assertTestDatabaseName(database: string, source = 'database'): string {
  if (!database.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(`[test-db-safety] Refusing ${source} "${database || '(unknown)'}": name does not end in "${TEST_DATABASE_SUFFIX}"`);
  }
  // Name validation is shared by the exact Jest lease and separately owned
  // Wave certification lanes. This function alone grants no destructive
  // authority: canonical Jest pools must still resolve the live state/lease.
  if (FORBIDDEN_DATABASES.has(database)
    || (!JEST_DATABASE_NAME.test(database) && !CERTIFICATION_DATABASE_NAME.test(database))) {
    throw new Error(`[test-db-safety] Refusing ${source}: database identity is not nonce-scoped to one test invocation`);
  }
  return database;
}

export function assertTestDatabaseUrl(databaseUrl: string, source = 'test database URL'): string {
  return assertTestDatabaseName(databaseNameFromUrl(databaseUrl), source);
}

/** Render a connection receipt without exposing its password. */
export function redactedTestDatabaseUrl(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  if (parsed.password) parsed.password = '[redacted]';
  return parsed.toString();
}

function readExactIsolatedTestDatabaseState(
  invocationId: string,
  statePath: string,
  expectedOwnerPid?: number,
): IsolatedTestDatabaseState {
  if (!/^[a-f0-9]{24}$/.test(invocationId) || !path.isAbsolute(statePath)) {
    throw new Error('[test-db-safety] Jest requires a nonce-scoped invocation owner; direct/fixed database fallback is forbidden');
  }
  const expectedRoot = path.join(fs.realpathSync(os.tmpdir()), `${JEST_INVOCATION_PREFIX}${invocationId}`);
  if (path.resolve(statePath) !== path.join(expectedRoot, 'database-state.json')) {
    throw new Error('[test-db-safety] State file is not bound to the exact Jest invocation root');
  }
  const root = assertInvocationRoot(expectedRoot, invocationId);
  assertPrivateRegularFile(statePath, 'Database state file');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<IsolatedTestDatabaseState>;
  if (state.schemaVersion !== TEST_DB_STATE_SCHEMA_VERSION
    || state.invocationId !== invocationId
    || state.root !== root
    || state.stateFile !== statePath
    || !Number.isSafeInteger(state.ownerPid) || Number(state.ownerPid) <= 0
    || (expectedOwnerPid !== undefined && state.ownerPid !== expectedOwnerPid)
    || typeof state.ownerProcessStartIdentity !== 'string'
    || !/^(?:linux-proc-start:\d+|darwin-ps-lstart:.+|darwin-self:\d+:\d+)$/.test(state.ownerProcessStartIdentity)
    || typeof state.ownerInstanceNonce !== 'string' || !/^[a-f0-9]{64}$/.test(state.ownerInstanceNonce)
    || state.leaseFile !== path.join(root, 'owner.lease')
    || typeof state.leaseTokenHash !== 'string') {
    throw new Error('[test-db-safety] Database state does not match its invocation owner');
  }
  assertPrivateRegularFile(state.leaseFile, 'Invocation lease');
  const lease = JSON.parse(fs.readFileSync(state.leaseFile, 'utf8')) as {
    invocationId?: unknown;
    ownerPid?: unknown;
    ownerProcessStartIdentity?: unknown;
    ownerInstanceNonce?: unknown;
    token?: unknown;
  };
  if (lease.invocationId !== invocationId
    || lease.ownerPid !== state.ownerPid
    || lease.ownerProcessStartIdentity !== state.ownerProcessStartIdentity
    || lease.ownerInstanceNonce !== state.ownerInstanceNonce
    || typeof lease.token !== 'string'
    || sha256(lease.token) !== state.leaseTokenHash) {
    throw new Error('[test-db-safety] Exclusive invocation lease identity is invalid');
  }
  return state as IsolatedTestDatabaseState;
}

export const OWNER_HEARTBEAT_FILENAME = 'owner.heartbeat';
export const OWNER_HEARTBEAT_MAX_AGE_MS = 60_000;

/**
 * Verify the lease owner is alive through its signed heartbeat. The engine
 * (lease owner) rewrites this file every 15s with `{ ts, hash }` where hash
 * binds the exact lease token; only the owner can produce it, and a dead
 * owner stops refreshing it. This is the sandbox-compatible liveness proof:
 * /bin/ps is setuid root on Darwin and cannot exec inside the seatbelt, so
 * process observation is unavailable there.
 */
export function assertFreshOwnerHeartbeat(state: IsolatedTestDatabaseState): void {
  const heartbeatPath = path.join(state.root, OWNER_HEARTBEAT_FILENAME);
  assertPrivateRegularFile(heartbeatPath, 'Owner heartbeat');
  const heartbeat = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')) as {
    ts?: unknown;
    hash?: unknown;
  };
  if (typeof heartbeat.ts !== 'number' || !Number.isSafeInteger(heartbeat.ts)) {
    throw new Error('[test-db-safety] Owner heartbeat has no valid timestamp');
  }
  if (Date.now() - heartbeat.ts > OWNER_HEARTBEAT_MAX_AGE_MS || heartbeat.ts > Date.now() + 5_000) {
    throw new Error('[test-db-safety] Exclusive invocation lease owner heartbeat is stale');
  }
  const lease = JSON.parse(fs.readFileSync(state.leaseFile, 'utf8')) as { token?: unknown };
  if (typeof lease.token !== 'string'
    || typeof heartbeat.hash !== 'string'
    || heartbeat.hash !== sha256(`${lease.token}:${heartbeat.ts}`)) {
    throw new Error('[test-db-safety] Exclusive invocation lease owner heartbeat signature is invalid');
  }
}

export function readIsolatedTestDatabaseState(env: NodeJS.ProcessEnv = process.env): IsolatedTestDatabaseState {
  const invocationId = String(env.RORCA_JEST_INVOCATION_ID ?? '');
  const statePath = String(env.RORCA_JEST_STATE_FILE ?? '');
  const state = readExactIsolatedTestDatabaseState(
    invocationId,
    statePath,
    Number(env.RORCA_JEST_OWNER_PID),
  );
  const observation = observeExactProcessInstance(state.ownerPid, state.ownerProcessStartIdentity);
  if (observation === 'exact') return state;
  if (observation === 'unknown') {
    // Probe unavailable (e.g. /bin/ps cannot exec inside the Darwin seatbelt):
    // fall back to the owner-signed heartbeat liveness proof.
    assertFreshOwnerHeartbeat(state);
    return state;
  }
  throw new Error('[test-db-safety] Exclusive invocation lease owner instance is not alive');
}

export function readStaleIsolatedTestDatabaseState(rootPath: string): IsolatedTestDatabaseState | null {
  const root = path.resolve(rootPath);
  const name = path.basename(root);
  const invocationId = name.startsWith(JEST_INVOCATION_PREFIX)
    ? name.slice(JEST_INVOCATION_PREFIX.length)
    : '';
  const state = readExactIsolatedTestDatabaseState(
    invocationId,
    path.join(root, 'database-state.json'),
  );
  const owner = observeExactProcessInstance(state.ownerPid, state.ownerProcessStartIdentity);
  if (owner === 'exact') return null;
  if (owner !== 'dead' && owner !== 'mismatched') {
    throw new Error('[test-db-safety] Stale invocation owner liveness is not provable');
  }
  return state;
}

/** Resolve only the exact ready URL written under the live invocation lease. */
export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const state = readIsolatedTestDatabaseState(env);
  if (state.status !== 'ready' || !state.databaseUrl || !state.migrationDatabaseUrl
    || !state.canonicalWriterDatabaseUrl || !state.database || !state.user) {
    throw new Error('[test-db-safety] Invocation-owned split-principal test database is not ready');
  }
  const topology: Record<string, string> = {
    runtime: state.databaseUrl,
    migration: state.migrationDatabaseUrl,
    'canonical writer': state.canonicalWriterDatabaseUrl,
  };
  const users = new Set<string>();
  for (const [principal, databaseUrl] of Object.entries(topology)) {
    assertTestDatabaseUrl(databaseUrl, `invocation-owned ${principal} database URL`);
    if (databaseNameFromUrl(databaseUrl) !== state.database) {
      throw new Error('[test-db-safety] Invocation topology targets different databases');
    }
    users.add(decodeURIComponent(new URL(databaseUrl).username));
  }
  if (users.size !== Object.keys(topology).length
    || decodeURIComponent(new URL(state.databaseUrl).username) !== state.user) {
    throw new Error('[test-db-safety] Invocation URLs do not contain three distinct randomized principals');
  }
  const migrationUser = decodeURIComponent(new URL(state.migrationDatabaseUrl).username);
  const writerUser = decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl).username);
  const expectedEnvironment: Record<string, { value: string | undefined; expected: string }> = {
    RORCA_TEST_DATABASE_URL: { value: env.RORCA_TEST_DATABASE_URL, expected: state.databaseUrl },
    DATABASE_URL_TEST: { value: env.DATABASE_URL_TEST, expected: state.databaseUrl },
    DATABASE_URL: { value: env.DATABASE_URL, expected: state.databaseUrl },
    RORCA_MIGRATION_DATABASE_URL: { value: env.RORCA_MIGRATION_DATABASE_URL, expected: state.migrationDatabaseUrl },
    WAVE2_TEST_MIGRATION_DATABASE_URL: { value: env.WAVE2_TEST_MIGRATION_DATABASE_URL, expected: state.migrationDatabaseUrl },
    RORCA_RUNTIME_DATABASE_USER: { value: env.RORCA_RUNTIME_DATABASE_USER, expected: state.user },
    RORCA_CANONICAL_WRITER_DATABASE_URL: {
      value: env.RORCA_CANONICAL_WRITER_DATABASE_URL,
      expected: state.canonicalWriterDatabaseUrl,
    },
    RORCA_CANONICAL_WRITER_DATABASE_USER: {
      value: env.RORCA_CANONICAL_WRITER_DATABASE_USER,
      expected: writerUser,
    },
  };
  for (const [key, { value, expected }] of Object.entries(expectedEnvironment)) {
    if (value && value !== expected) {
      throw new Error(`[test-db-safety] Refusing ${key}: it differs from invocation-owned state`);
    }
  }
  if (migrationUser === state.user || migrationUser === writerUser || writerUser === state.user) {
    throw new Error('[test-db-safety] Invocation database principals are not distinct');
  }
  return state.databaseUrl;
}

/**
 * Compatibility seam for focused Wave lanes: the fresh claim is the live,
 * exact invocation lease itself. The harness already created and marked this
 * private database before any repository migration can run.
 */
export async function claimFreshTestDatabaseInvocation(
  client: Queryable,
  expectedUrl: string,
  invocationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const state = readIsolatedTestDatabaseState(env);
  if (state.status !== 'ready' || state.invocationId !== invocationId
    || state.databaseUrl !== expectedUrl) {
    throw new Error('[test-db-safety] Fresh claim differs from the exact invocation lease');
  }
  await assertConnectedTestDatabase(client, expectedUrl, env);
}

/** Verify server truth and role safety immediately before destructive fixtures. */
export async function assertConnectedTestDatabase(
  client: Queryable,
  expectedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectedTestDatabase> {
  const state = readIsolatedTestDatabaseState(env);
  resolveTestDatabaseUrl(env);
  const exactUrls = new Set([
    state.databaseUrl,
    state.migrationDatabaseUrl,
    state.canonicalWriterDatabaseUrl,
  ].filter((value): value is string => Boolean(value)));
  if (!exactUrls.has(expectedUrl)
    || databaseNameFromUrl(expectedUrl) !== state.database) {
    throw new Error('[test-db-safety] Connected target differs from invocation-owned URL set');
  }
  const expectedUser = decodeURIComponent(new URL(expectedUrl).username);
  const migrationUser = decodeURIComponent(new URL(state.migrationDatabaseUrl!).username);
  const writerUser = decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl!).username);
  const identitySource = expectedUser === writerUser
    ? 'rorca.test_invocation_server_identity()'
    : `(SELECT control.system_identifier::text AS system_identifier,
               current_setting('data_directory') AS data_directory
          FROM pg_control_system() control)`;
  const result = await client.query<ConnectedTruthRow>(`
    SELECT current_database() AS database,
           current_user AS user,
           pg_get_userbyid(database.datdba) AS owner,
           description.description AS marker,
           control.system_identifier AS system_identifier,
           control.data_directory AS data_directory,
           current_setting('server_version') AS server_version,
           current_setting('listen_addresses') AS listen_addresses,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port,
           role.rolsuper, role.rolcanlogin, role.rolcreatedb, role.rolcreaterole,
           role.rolreplication, role.rolbypassrls,
           EXISTS (SELECT 1 FROM pg_database WHERE datname = 'rorca') AS production_database_exists,
           CASE WHEN EXISTS (SELECT 1 FROM pg_database WHERE datname = 'rorca')
                THEN has_database_privilege(current_user, 'rorca', 'CONNECT')
                ELSE FALSE END AS production_connect
      FROM pg_database database
      JOIN pg_roles role ON role.rolname = current_user
      CROSS JOIN ${identitySource} control
      LEFT JOIN pg_shdescription description
        ON description.objoid = database.oid AND description.classoid = 'pg_database'::regclass
     WHERE database.datname = current_database()
  `);
  const row = result.rows[0];
  if (!row) throw new Error('[test-db-safety] Connected server returned no identity row');
  assertTestDatabaseName(row.database, 'connected database');
  const splitPrincipalOwner = row.owner === migrationUser
    && row.user === expectedUser
    && (row.user === state.user || row.user === writerUser);
  if (row.database !== state.database
    || row.user !== expectedUser
    || (row.owner !== expectedUser && !splitPrincipalOwner)) {
    throw new Error('[test-db-safety] Connected database/user/owner differs from invocation identity');
  }
  const connectedDataDirectory = state.mode === 'local-cluster' ? fs.realpathSync(row.data_directory) : row.data_directory;
  const expectedDataDirectory = state.mode === 'local-cluster' ? fs.realpathSync(state.dataDirectory!) : state.dataDirectory;
  if (row.marker !== state.marker || row.system_identifier !== state.systemIdentifier
    || connectedDataDirectory !== expectedDataDirectory) {
    throw new Error('[test-db-safety] Connected cluster marker/system/data-directory differs from invocation identity');
  }
  if (!row.server_version.startsWith('16.')) throw new Error('[test-db-safety] Test server must be PostgreSQL 16');
  if (row.rolsuper || !row.rolcanlogin || row.rolcreatedb || row.rolcreaterole || row.rolreplication || row.rolbypassrls) {
    throw new Error('[test-db-safety] Test role has forbidden elevated attributes');
  }
  if (!row.production_database_exists || row.production_connect) {
    throw new Error('[test-db-safety] Test role must be denied CONNECT to protected database "rorca"');
  }
  if (state.mode === 'local-cluster' && (row.listen_addresses !== '' || row.server_address !== null)) {
    throw new Error('[test-db-safety] Local test cluster unexpectedly accepts TCP connections');
  }
  return {
    database: row.database,
    user: row.user,
    owner: row.owner,
    marker: row.marker,
    systemIdentifier: row.system_identifier,
    dataDirectory: row.data_directory,
    postgresMajor: 16,
    superuser: false,
    serverAddress: row.server_address,
    serverPort: row.server_port == null ? null : Number(row.server_port),
    productionDatabaseExists: row.production_database_exists,
    productionConnect: row.production_connect,
  };
}
