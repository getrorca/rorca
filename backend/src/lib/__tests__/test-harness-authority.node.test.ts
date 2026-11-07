/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveTestDatabaseUrl } from '../test-db-safety';

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('fixed or ambient test targets have no authority without an invocation lease', () => {
  assert.throws(
    () => resolveTestDatabaseUrl({
      RORCA_TEST_DATABASE_URL: 'postgresql://fixed:secret@localhost:5432/fixed_test',
      DATABASE_URL: 'postgresql://admin:secret@localhost:5432/rorca',
    }),
    /nonce-scoped invocation owner/,
  );
});

test('Jest command is wrapped by the nonce-owning parent and setup provisions fresh state', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const wrapper = fs.readFileSync(path.join(backendRoot, 'scripts/run-isolated-jest.ts'), 'utf8');
  const setup = fs.readFileSync(path.join(backendRoot, 'jest.setup.ts'), 'utf8');
  const teardown = fs.readFileSync(path.join(backendRoot, 'jest.teardown.ts'), 'utf8');
  assert.equal(pkg.scripts.test, 'tsx scripts/run-isolated-jest.ts');
  assert.match(wrapper, /crypto\.randomBytes\(12\)/);
  assert.match(wrapper, /cleanupIsolatedTestDatabase\(childEnv\)/);
  assert.match(wrapper, /delete childEnv\[key\]/);
  assert.match(setup, /provisionIsolatedTestDatabase\(\)/);
  assert.match(teardown, /cleanupIsolatedTestDatabase\(\)/);
});

test('hosted-auth emulation grants only the request-role sequences it actually uses', () => {
  const setup = fs.readFileSync(path.join(backendRoot, 'jest.setup.ts'), 'utf8');
  assert.doesNotMatch(setup, /GRANT\s+[^;]*ON\s+ALL\s+SEQUENCES/i);
  assert.match(setup, /GRANT USAGE, SELECT ON SEQUENCE\s+rorca\.direction_layers_id_seq,\s+rorca\.wal_events_id_seq\s+TO authenticated/);
  assert.doesNotMatch(setup, /workspace_hydration_id_seq/);
});

test('wrapper bounds TERM/KILL child shutdown and preserves provisioned recovery state on failure', () => {
  const wrapper = fs.readFileSync(path.join(backendRoot, 'scripts/run-isolated-jest.ts'), 'utf8');
  assert.match(wrapper, /new WorkerRunResourceOwner\(\{ runId: 1, termTimeoutMs: 5_000, killTimeoutMs: 5_000 \}\)/);
  assert.match(wrapper, /childOwner\.dispose\(\)\.then\(resolveSignalShutdown, rejectSignalShutdown\)/);
  assert.match(wrapper, /if \(childQuiescent\)/);
  assert.match(wrapper, /current\.status === 'allocated'/);
  assert.match(wrapper, /!current\.containerId && !current\.dataDirectory/);
  assert.match(wrapper, /recoverStaleIsolatedTestDatabases/);
  assert.doesNotMatch(wrapper, /child\.kill\(signal\)/);
});

test('harness owns exact local-cluster or labeled-container cleanup, never broad database/container cleanup', () => {
  const harness = fs.readFileSync(path.join(backendRoot, 'src/lib/test-db-harness.ts'), 'utf8');
  assert.match(harness, /listen_addresses = ''/);
  assert.match(harness, /--auth-host=reject/);
  assert.match(harness, /com\.rorca\.jest-invocation/);
  assert.match(harness, /REVOKE CONNECT ON DATABASE rorca FROM PUBLIC/);
  assert.match(harness, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/);
  assert.doesNotMatch(harness, /docker\s+(?:system|container)\s+prune/);
  assert.doesNotMatch(harness, /\['build', '--tag'/);
  assert.doesNotMatch(harness, /DROP DATABASE IF EXISTS rorca\b/);
  assert.doesNotMatch(harness, /rmSync\((?:os\.tmpdir\(\)|['"]\/tmp['"])/);
  assert.match(harness, /pg_ctl stop returned success but the exact invocation postmaster remains active/);
  assert.match(harness, /Docker remove returned success but the exact invocation container remains present/);
  assert.match(harness, /readStaleIsolatedTestDatabaseState/);
});

test('canonical Jest stays truly in-band and lets historical idle clients retire before server teardown', () => {
  const config = fs.readFileSync(path.join(backendRoot, 'jest.config.ts'), 'utf8');
  const db = fs.readFileSync(path.join(backendRoot, 'src/db/index.ts'), 'utf8');
  const teardown = fs.readFileSync(path.join(backendRoot, 'jest.teardown.ts'), 'utf8');
  assert.match(config, /maxWorkers:\s*1/);
  assert.doesNotMatch(config, /^\s*workerIdleMemoryLimit:/m);
  assert.match(db, /idleTimeoutMillis: process\.env\.NODE_ENV === 'test' \? 250 : 30_000/);
  assert.match(teardown, /setTimeout\(resolve, 500\)/);
});

test('shared harness never performs global table cleanup around test cases or suites', () => {
  const source = fs.readFileSync(path.join(backendRoot, 'jest.pool-cleanup.ts'), 'utf8');
  assert.match(source, /\bbeforeAll\s*\(/);
  assert.match(source, /\bafterAll\s*\(/);
  assert.doesNotMatch(source, /\bbeforeEach\s*\(/);
  assert.doesNotMatch(source, /\bafterEach\s*\(/);
  assert.doesNotMatch(source, /\bTRUNCATE\b/i);
  assert.doesNotMatch(source, /\bDELETE\s+FROM\b/i);
});
