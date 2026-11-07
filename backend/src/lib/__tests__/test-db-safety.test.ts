/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** DB-free unit tests. Live server truth is in test-db-safety-live.integration.test.ts. */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { requireCurrentProcessStartIdentity } from '../process-instance-identity';
import {
  assertConnectedTestDatabase,
  assertFreshOwnerHeartbeat,
  assertTestDatabaseUrl,
  databaseNameFromUrl,
  OWNER_HEARTBEAT_FILENAME,
  OWNER_HEARTBEAT_MAX_AGE_MS,
  readIsolatedTestDatabaseState,
  resolveTestDatabaseUrl,
  TEST_DB_STATE_SCHEMA_VERSION,
  type IsolatedTestDatabaseState,
} from '../test-db-safety';

let root: string;
let env: NodeJS.ProcessEnv;
let state: IsolatedTestDatabaseState;

function hash(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function connectedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    database: state.database,
    user: state.user,
    owner: decodeURIComponent(new URL(state.migrationDatabaseUrl!).username),
    marker: state.marker,
    system_identifier: state.systemIdentifier,
    data_directory: state.dataDirectory,
    server_version: '16.13',
    listen_addresses: '',
    server_address: null,
    server_port: null,
    rolsuper: false,
    rolcanlogin: true,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    production_database_exists: true,
    production_connect: false,
    ...overrides,
  };
}

beforeEach(() => {
  const invocationId = crypto.randomBytes(12).toString('hex');
  root = path.join(fs.realpathSync(os.tmpdir()), `rorca-jest-invocation-${invocationId}`);
  fs.mkdirSync(root, { mode: 0o700 });
  const token = crypto.randomBytes(24).toString('hex');
  const ownerProcessStartIdentity = requireCurrentProcessStartIdentity();
  const ownerInstanceNonce = crypto.randomBytes(32).toString('hex');
  const leaseFile = path.join(root, 'owner.lease');
  const stateFile = path.join(root, 'database-state.json');
  fs.writeFileSync(leaseFile, `${JSON.stringify({
    invocationId, ownerPid: process.pid, ownerProcessStartIdentity, ownerInstanceNonce, token,
  })}\n`, { mode: 0o600 });
  const dataDirectory = path.join(root, 'pgdata');
  fs.mkdirSync(dataDirectory, { mode: 0o700 });
  const database = `rorca_jest_${invocationId}_test`;
  const user = `rorca_jest_${invocationId}_runner`;
  const marker = `rorca-jest-owned:${invocationId}`;
  const databaseUrl = `postgresql://${user}:secret@localhost:5432/${database}?application_name=rorca-jest%3A${invocationId}&host=${encodeURIComponent(path.join(root, 'socket'))}`;
  const migrationUser = `rorca_jest_${invocationId}_migration`;
  const writerUser = `rorca_jest_${invocationId}_writer`;
  const migrationDatabaseUrl = new URL(databaseUrl);
  migrationDatabaseUrl.username = migrationUser;
  migrationDatabaseUrl.password = 'migration-secret';
  const canonicalWriterDatabaseUrl = new URL(databaseUrl);
  canonicalWriterDatabaseUrl.username = writerUser;
  canonicalWriterDatabaseUrl.password = 'writer-secret';
  state = {
    schemaVersion: TEST_DB_STATE_SCHEMA_VERSION,
    invocationId,
    ownerPid: process.pid,
    ownerProcessStartIdentity,
    ownerInstanceNonce,
    root,
    leaseFile,
    leaseTokenHash: hash(token),
    stateFile,
    status: 'ready',
    mode: 'local-cluster',
    dataDirectory,
    socketDirectory: path.join(root, 'socket'),
    databaseUrl,
    migrationDatabaseUrl: migrationDatabaseUrl.toString(),
    canonicalWriterDatabaseUrl: canonicalWriterDatabaseUrl.toString(),
    database,
    user,
    marker,
    applicationName: `rorca-jest:${invocationId}`,
    systemIdentifier: '7412345678901234567',
    serverVersion: '16.13',
    extensions: ['pgcrypto', 'vector'],
  };
  fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  env = {
    RORCA_JEST_INVOCATION_ID: invocationId,
    RORCA_JEST_OWNER_PID: String(process.pid),
    RORCA_JEST_STATE_FILE: stateFile,
    RORCA_MIGRATION_DATABASE_URL: migrationDatabaseUrl.toString(),
    WAVE2_TEST_MIGRATION_DATABASE_URL: migrationDatabaseUrl.toString(),
    RORCA_RUNTIME_DATABASE_USER: user,
    RORCA_CANONICAL_WRITER_DATABASE_URL: canonicalWriterDatabaseUrl.toString(),
    RORCA_CANONICAL_WRITER_DATABASE_USER: writerUser,
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('accepts only nonce-shaped Jest or certification PostgreSQL test database names', () => {
  expect(databaseNameFromUrl(state.databaseUrl!)).toBe(state.database);
  expect(assertTestDatabaseUrl(state.databaseUrl!)).toBe(state.database);
  expect(assertTestDatabaseUrl('postgres://wave2@localhost/rorca_wave2_a1b2c3d4_fresh_test'))
    .toBe('rorca_wave2_a1b2c3d4_fresh_test');
  expect(() => assertTestDatabaseUrl('postgres://localhost/rorca_test')).toThrow(/not nonce-scoped/);
  expect(() => assertTestDatabaseUrl('postgres://localhost/rorca')).toThrow(/does not end in "_test"/);
  expect(() => assertTestDatabaseUrl('https://localhost/rorca_jest_aaaaaaaaaaaaaaaaaaaaaaaa_test')).toThrow(/must use postgres/);
});

test('never derives test authority from production, fixed, or standalone test URLs', () => {
  expect(() => resolveTestDatabaseUrl({
    DATABASE_URL: 'postgresql://admin:secret@localhost:5432/rorca',
    RORCA_TEST_DATABASE_URL: 'postgresql://fixed:secret@localhost:5432/fixed_test',
  })).toThrow(/nonce-scoped invocation owner/);
});

test('resolves only the exact ready state under a live exclusive lease', () => {
  expect(resolveTestDatabaseUrl(env)).toBe(state.databaseUrl);
  expect(readIsolatedTestDatabaseState(env)).toMatchObject({
    invocationId: state.invocationId,
    ownerPid: process.pid,
    status: 'ready',
  });
  expect(() => resolveTestDatabaseUrl({ ...env, DATABASE_URL_TEST: `${state.databaseUrl}drift` }))
    .toThrow(/differs from invocation-owned state/);
  expect(() => resolveTestDatabaseUrl({ ...env, RORCA_CANONICAL_WRITER_DATABASE_USER: 'writer-drift' }))
    .toThrow(/differs from invocation-owned state/);
});

test('heartbeat proves lease owner liveness when the identity probe is unavailable', () => {
  const lease = JSON.parse(fs.readFileSync(state.leaseFile, 'utf8')) as { token: string };
  const heartbeatPath = path.join(state.root, OWNER_HEARTBEAT_FILENAME);
  const writeHeartbeat = (ts: number) => {
    fs.writeFileSync(heartbeatPath, `${JSON.stringify({
      ts,
      hash: hash(`${lease.token}:${ts}`),
    })}\n`, { mode: 0o600 });
  };
  // Fresh, correctly signed heartbeat passes.
  writeHeartbeat(Date.now());
  expect(() => assertFreshOwnerHeartbeat(state)).not.toThrow();
  // Stale heartbeat is refused.
  writeHeartbeat(Date.now() - OWNER_HEARTBEAT_MAX_AGE_MS - 1_000);
  expect(() => assertFreshOwnerHeartbeat(state)).toThrow(/heartbeat is stale/);
  // Wrong signature is refused.
  writeHeartbeat(Date.now());
  fs.writeFileSync(heartbeatPath, `${JSON.stringify({ ts: Date.now(), hash: hash('wrong') })}\n`, { mode: 0o600 });
  expect(() => assertFreshOwnerHeartbeat(state)).toThrow(/signature is invalid/);
  // Missing heartbeat is refused.
  fs.rmSync(heartbeatPath, { force: true });
  expect(() => assertFreshOwnerHeartbeat(state)).toThrow(/heartbeat/);
});

test('dead lease owner is refused even with a fresh heartbeat', () => {
  const deadPid = 2_147_483_647;
  const deadState = {
    ...state,
    ownerPid: deadPid,
    ownerProcessStartIdentity: 'darwin-ps-lstart:Thu Jan  1 00:00:00 1970',
    leaseTokenHash: hash('dead-token'),
  };
  fs.writeFileSync(state.stateFile, `${JSON.stringify(deadState)}\n`, { mode: 0o600 });
  fs.writeFileSync(state.leaseFile, `${JSON.stringify({
    invocationId: state.invocationId,
    ownerPid: deadPid,
    ownerProcessStartIdentity: 'darwin-ps-lstart:Thu Jan  1 00:00:00 1970',
    ownerInstanceNonce: state.ownerInstanceNonce,
    token: 'dead-token',
  })}\n`, { mode: 0o600 });
  const now = Date.now();
  fs.writeFileSync(path.join(state.root, OWNER_HEARTBEAT_FILENAME), `${JSON.stringify({
    ts: now,
    hash: hash(`dead-token:${now}`),
  })}\n`, { mode: 0o600 });
  expect(() => readIsolatedTestDatabaseState({
    ...env,
    RORCA_JEST_OWNER_PID: String(deadPid),
  })).toThrow(/owner instance is not alive/);
});

test('rejects insecure, mismatched, dead-owner-shaped, and non-ready state', () => {
  fs.chmodSync(root, 0o755);
  expect(() => resolveTestDatabaseUrl(env)).toThrow(/Invocation root must be a private/);
  fs.chmodSync(root, 0o700);

  fs.chmodSync(state.stateFile, 0o644);
  expect(() => resolveTestDatabaseUrl(env)).toThrow(/mode 0600/);
  fs.chmodSync(state.stateFile, 0o600);

  fs.writeFileSync(state.leaseFile, `${JSON.stringify({ invocationId: state.invocationId, ownerPid: process.pid, token: 'wrong' })}\n`, { mode: 0o600 });
  expect(() => resolveTestDatabaseUrl(env)).toThrow(/lease identity is invalid/);

  const lease = {
    invocationId: state.invocationId,
    ownerPid: process.pid,
    ownerProcessStartIdentity: state.ownerProcessStartIdentity,
    ownerInstanceNonce: state.ownerInstanceNonce,
    token: 'replacement',
  };
  fs.writeFileSync(state.leaseFile, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  state.leaseTokenHash = hash(lease.token);
  state.status = 'allocated';
  fs.writeFileSync(state.stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  expect(() => resolveTestDatabaseUrl(env)).toThrow(/not ready/);
});

test('verifies marker, cluster identity, safe role flags, socket-only local mode, and protected CONNECT denial', async () => {
  const matchingClient = { query: jest.fn().mockResolvedValue({ rows: [connectedRow()] }) };
  await expect(assertConnectedTestDatabase(matchingClient, state.databaseUrl!, env)).resolves.toMatchObject({
    database: state.database,
    user: state.user,
    postgresMajor: 16,
    superuser: false,
    productionDatabaseExists: true,
    productionConnect: false,
  });
  await expect(assertConnectedTestDatabase({ query: jest.fn().mockResolvedValue({ rows: [connectedRow({ rolsuper: true })] }) }, state.databaseUrl!, env))
    .rejects.toThrow(/forbidden elevated attributes/);
  await expect(assertConnectedTestDatabase({ query: jest.fn().mockResolvedValue({ rows: [connectedRow({ production_connect: true })] }) }, state.databaseUrl!, env))
    .rejects.toThrow(/denied CONNECT/);
  await expect(assertConnectedTestDatabase({ query: jest.fn().mockResolvedValue({ rows: [connectedRow({ marker: 'other' })] }) }, state.databaseUrl!, env))
    .rejects.toThrow(/cluster marker/);
  await expect(assertConnectedTestDatabase({ query: jest.fn().mockResolvedValue({ rows: [connectedRow({ listen_addresses: 'localhost' })] }) }, state.databaseUrl!, env))
    .rejects.toThrow(/unexpectedly accepts TCP/);

  const migrationUser = decodeURIComponent(new URL(state.migrationDatabaseUrl!).username);
  const writerUser = decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl!).username);
  await expect(assertConnectedTestDatabase({
    query: jest.fn().mockResolvedValue({
      rows: [connectedRow({ user: writerUser, owner: migrationUser })],
    }),
  }, state.canonicalWriterDatabaseUrl!, env)).resolves.toMatchObject({
    user: writerUser,
    owner: migrationUser,
  });
});
