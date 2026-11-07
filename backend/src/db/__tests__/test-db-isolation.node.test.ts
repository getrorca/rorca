/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { assertIsolatedDatabaseTarget, assertTestDatabaseCapability, isTestDatabaseProcess } from '../test-db-policy';

// This child never loads a real pg implementation. Even a regressed guard can
// only increment counters: it cannot open a socket or touch any database.
const child = String.raw`
const Module = require('node:module');
const originalLoad = Module._load;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
let fixtureRoot;
if (process.env.PROBE_FIXTURE === 'true') {
  const invocationId = crypto.randomBytes(12).toString('hex');
  fixtureRoot = path.join(fs.realpathSync(os.tmpdir()), 'rorca-jest-invocation-' + invocationId);
  fs.mkdirSync(fixtureRoot, { mode: 0o700 });
  const ownerProcessStartIdentity = require('./src/lib/process-instance-identity').requireCurrentProcessStartIdentity();
  const token = crypto.randomBytes(24).toString('hex');
  const ownerInstanceNonce = crypto.randomBytes(32).toString('hex');
  const leaseFile = path.join(fixtureRoot, 'owner.lease');
  const stateFile = path.join(fixtureRoot, 'database-state.json');
  const database = 'rorca_jest_' + invocationId + '_test';
  const url = user => 'postgresql://' + user + '@localhost/' + database + '?host=' + encodeURIComponent(path.join(fixtureRoot, 'socket'));
  const databaseUrl = url('fixture_runtime');
  const migrationDatabaseUrl = url('fixture_owner');
  const canonicalWriterDatabaseUrl = url('fixture_writer');
  fs.writeFileSync(leaseFile, JSON.stringify({ invocationId, ownerPid: process.pid, ownerProcessStartIdentity, ownerInstanceNonce, token }), { mode: 0o600 });
  fs.writeFileSync(stateFile, JSON.stringify({ schemaVersion: 2, invocationId, ownerPid: process.pid, ownerProcessStartIdentity, ownerInstanceNonce,
    root: fixtureRoot, leaseFile, leaseTokenHash: 'sha256:' + crypto.createHash('sha256').update(token).digest('hex'),
    stateFile, status: 'ready', database, user: 'fixture_runtime', databaseUrl, migrationDatabaseUrl, canonicalWriterDatabaseUrl }), { mode: 0o600 });
  Object.assign(process.env, { RORCA_JEST_INVOCATION_ID: invocationId, RORCA_JEST_OWNER_PID: String(process.pid), RORCA_JEST_STATE_FILE: stateFile,
    DATABASE_URL: databaseUrl, RORCA_MIGRATION_DATABASE_URL: migrationDatabaseUrl, RORCA_CANONICAL_WRITER_DATABASE_URL: canonicalWriterDatabaseUrl });
  if (process.env.PROBE_POISON === 'true') process.env.RORCA_MIGRATION_DATABASE_URL = 'postgres://ambient.invalid/' + database;
}
const calls = { pools: 0, connects: 0, queries: 0 };
class Pool {
  constructor(options) { calls.pools++; this.options = options; }
  on() { return this; }
  async connect() { calls.connects++; throw Error('MOCK_CONNECT'); }
  async query() { calls.queries++; throw Error('MOCK_QUERY'); }
  async end() {}
}
Module._load = function(id, parent, main) {
  if (id === 'pg') return { Pool };
  if (id.endsWith('/logger')) return { logger: new Proxy({}, { get: () => () => {} }) };
  if (['/graph-contract', '/governed-contracts', '/governed-prerequisite-gate'].some(s => id.endsWith(s))) return {};
  return originalLoad.apply(this, arguments);
};
(async () => {
  let error;
  try {
    const db = require('./src/db/' + process.env.PROBE_MODULE);
    if (process.env.PROBE_MODULE === 'index') await db.execute('SELECT 1');
    else if (process.env.PROBE_ACTION === 'supplied') await db.runPgMigrations(new Pool({connectionString: process.env.DATABASE_URL}));
    else db.createPoolForConnectionString(process.env.DATABASE_URL);
  } catch (e) { error = e.message; }
  finally { if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
  console.log(JSON.stringify({ calls, error }));
})().catch(() => process.exit(1));
`;
function probe(extra: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, ['-r', 'tsx/cjs', '-e', child], {
    cwd: path.resolve(__dirname, '../../..'),
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
      DATABASE_URL: 'postgres://ambient.invalid/rorca',
      PROBE_MODULE: 'index', ...extra,
    },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('custom Jest configuration with production NODE_ENV cannot reach ambient pg', () => {
  const result = probe({ NODE_ENV: 'production', JEST_WORKER_ID: '1', JEST_SKIP_RUNTIME_MIGRATIONS: 'true' });
  assert.deepEqual(result.calls, { pools: 0, connects: 0, queries: 0 });
  assert.match(result.error, /test-db-isolation/);
});

for (const [name, env] of Object.entries({
  'PG defaults with no URL': { NODE_ENV: 'test', DATABASE_URL: undefined },
  'NODE_ENV test alone': { NODE_ENV: 'test' },
  'migration skip alone': { JEST_SKIP_RUNTIME_MIGRATIONS: 'true' },
  'Jest without NODE_ENV': { JEST_WORKER_ID: '1' },
  'node test runner': { NODE_TEST_CONTEXT: 'child-v8' },
  'unknown capability': { RORCA_TEST_DB_CAPABILITY: 'true' },
  'capability without lease': { RORCA_TEST_DB_CAPABILITY: 'invocation-lease' },
  'lease without explicit capability': { NODE_ENV: 'test', PROBE_FIXTURE: 'true' },
})) {
  test(`${name} cannot grant ambient access`, () => {
    const result = probe(env);
    assert.deepEqual(result.calls, { pools: 0, connects: 0, queries: 0 });
    assert.match(result.error, /test-db-(isolation|safety)/);
  });
}

for (const module of ['index', 'pg-index']) {
  test(`${module}: explicit capability plus verified isolated fixture reaches only instrumented pg`, () => {
    const result = probe({ PROBE_MODULE: module, NODE_ENV: 'test', PROBE_FIXTURE: 'true',
      RORCA_TEST_DB_CAPABILITY: 'invocation-lease', JEST_SKIP_RUNTIME_MIGRATIONS: 'true' });
    assert.equal(result.calls.pools, 1);
    if (module === 'index') {
      assert.equal(result.calls.connects, 1);
      assert.match(result.error, /MOCK_CONNECT/);
    }
    else assert.equal(result.error, undefined);
  });
  test(`${module}: mutated migration endpoint rejects before any pg calls`, () => {
    const result = probe({ PROBE_MODULE: module, NODE_ENV: 'test', PROBE_FIXTURE: 'true', PROBE_POISON: 'true',
      RORCA_TEST_DB_CAPABILITY: 'invocation-lease' });
    assert.deepEqual(result.calls, { pools: 0, connects: 0, queries: 0 });
    assert.match(result.error, /differs from invocation-owned state/);
  });
  test(`${module}: normal production target selection is unchanged (mock transport only)`, () => {
    const result = probe({ PROBE_MODULE: module, NODE_ENV: 'production' });
    assert.equal(result.calls.pools, 1);
    if (module === 'index') assert.match(result.error, /MOCK_CONNECT/);
    else assert.equal(result.error, undefined);
  });
}

test('migration factory rejects a Jest worker without bootstrap', () => {
  const result = probe({ PROBE_MODULE: 'pg-index', NODE_ENV: 'production', JEST_WORKER_ID: '1' });
  assert.deepEqual(result.calls, { pools: 0, connects: 0, queries: 0 });
  assert.match(result.error, /test-db-isolation/);
});

test('migration runner rejects a caller-supplied ambient pool before connect', () => {
  const result = probe({ PROBE_MODULE: 'pg-index', PROBE_ACTION: 'supplied', JEST_WORKER_ID: '1' });
  assert.deepEqual(result.calls, { pools: 1, connects: 0, queries: 0 });
  assert.match(result.error, /test-db-isolation/);
});

test('pure policy denies defaults, suffix-only, same-name/different-host, and query override targets', () => {
  assert.equal(isTestDatabaseProcess({ NODE_ENV: 'production' }), false);
  assert.doesNotThrow(() => assertTestDatabaseCapability({ NODE_ENV: 'production' }));
  assert.throws(() => assertTestDatabaseCapability({ JEST_WORKER_ID: '' }), /test-db-isolation/);
  const isolated = 'postgresql://fixture@localhost/rorca_jest_0123456789abcdef01234567_test?host=%2Ffixture';
  assert.doesNotThrow(() => assertIsolatedDatabaseTarget(isolated, [isolated]));
  for (const target of [undefined, 'postgres://localhost/rorca_test', isolated.replace('localhost', 'ambient.invalid'), `${isolated}&host=ambient.invalid`]) {
    assert.throws(() => assertIsolatedDatabaseTarget(target, [isolated]), /test-db-isolation/);
  }
  assert.throws(() => assertIsolatedDatabaseTarget('postgres://localhost/rorca', ['postgres://localhost/rorca']), /test-db-isolation/);
});
