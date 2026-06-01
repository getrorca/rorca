/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * jest.env.ts — Per-worker environment setup
 *
 * Runs before each test file (setupFiles). Sets DATABASE_URL so the
 * db/index.ts pool connects to the test database.
 *
 * IMPORTANT: We derive the test DB URL from DATABASE_URL by appending _test
 * to the database name. This ensures tests always hit a separate database
 * on the same server, regardless of which port or credentials are configured.
 */

const baseUrl = process.env.DATABASE_URL_TEST
  || (() => {
    // Derive test DB from production DATABASE_URL by appending _test
    const prodUrl = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5433/rorca';
    try {
      const parsed = new URL(prodUrl);
      const dbName = parsed.pathname.slice(1); // strip leading /
      if (!dbName.endsWith('_test')) {
        parsed.pathname = `/${dbName}_test`;
      }
      return parsed.toString();
    } catch {
      return 'postgres://rorca:rorca@localhost:5433/rorca_test';
    }
  })();

process.env.DATABASE_URL = baseUrl;
process.env.NODE_ENV = 'test';

// Limit pool size in tests: each jest.resetModules() + require('../../server') creates a new
// pg Pool. With 54 tests in pipeline.test.ts, PG_POOL_SIZE=1 keeps total connections ~60,
// safely under PostgreSQL's default max_connections=100.
process.env.PG_POOL_SIZE = '1';
process.env.JEST_SKIP_RUNTIME_MIGRATIONS = 'true';
