/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** Per-worker binding to the exact global-setup invocation state. */

const { readIsolatedTestDatabaseState, resolveTestDatabaseUrl } = require('./src/lib/test-db-safety');

const state = readIsolatedTestDatabaseState();
const testDatabaseUrl: string = resolveTestDatabaseUrl();
if (!state.migrationDatabaseUrl || !state.canonicalWriterDatabaseUrl || !state.user) {
  throw new Error('[jest-env] Invocation split-principal topology was not provisioned');
}
const parsed = new URL(testDatabaseUrl);
const canonicalWriterUser = decodeURIComponent(new URL(state.canonicalWriterDatabaseUrl).username);

process.env.RORCA_TEST_DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_TEST = testDatabaseUrl;
process.env.DATABASE_URL = testDatabaseUrl;
process.env.RORCA_MIGRATION_DATABASE_URL = state.migrationDatabaseUrl;
process.env.WAVE2_TEST_MIGRATION_DATABASE_URL = state.migrationDatabaseUrl;
process.env.RORCA_RUNTIME_DATABASE_USER = state.user;
process.env.RORCA_CANONICAL_WRITER_DATABASE_URL = state.canonicalWriterDatabaseUrl;
process.env.RORCA_CANONICAL_WRITER_DATABASE_USER = canonicalWriterUser;
process.env.NODE_ENV = 'test';
// Explicit selection is necessary but not sufficient: every real DB entry
// point revalidates this invocation's live lease and exact target before pg.
process.env.RORCA_TEST_DB_CAPABILITY = 'invocation-lease';
process.env.PGHOST = parsed.searchParams.get('host') || parsed.hostname;
process.env.PGPORT = parsed.port || '5432';
process.env.PGUSER = decodeURIComponent(parsed.username);
process.env.PGPASSWORD = decodeURIComponent(parsed.password);
process.env.PGDATABASE = decodeURIComponent(parsed.pathname.slice(1));
process.env.PGAPPNAME = state.applicationName;
process.env.PG_POOL_SIZE = '1';
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = 'workspace:wave-two';
process.env.RORCA_PGBOSS_PREAPPLIED = 'true';
process.env.JEST_SKIP_RUNTIME_MIGRATIONS = 'true';
