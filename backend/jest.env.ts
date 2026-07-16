/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Per-worker environment setup. The target is resolved independently from
 * production DATABASE_URL and then pinned for all application DB clients.
 */

const { resolveTestDatabaseUrl } = require('./src/lib/test-db-safety');

const testDatabaseUrl: string = resolveTestDatabaseUrl();
const parsed = new URL(testDatabaseUrl);

// Keep a stable source of truth even if an individual test mutates DATABASE_URL.
process.env.RORCA_TEST_DATABASE_URL = testDatabaseUrl;
process.env.DATABASE_URL_TEST = testDatabaseUrl;
process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
process.env.PGHOST = parsed.hostname;
process.env.PGPORT = parsed.port || '5432';
process.env.PGUSER = decodeURIComponent(parsed.username);
process.env.PGPASSWORD = decodeURIComponent(parsed.password);
process.env.PGDATABASE = decodeURIComponent(parsed.pathname.slice(1));
process.env.PGAPPNAME = 'rorca-jest';

// Each jest.resetModules() can create a new pool; keep per-pool pressure bounded.
process.env.PG_POOL_SIZE = '1';
process.env.JEST_SKIP_RUNTIME_MIGRATIONS = 'true';
