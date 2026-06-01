/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * integration-setup.ts — Shared setup for route integration tests
 *
 * Replaces the per-test SQLite tmpDir pattern with a shared Postgres pool.
 * Each test file should:
 *
 *   import { setupIntegrationTest } from '../../__tests__/helpers/integration-setup';
 *   const ctx = setupIntegrationTest();
 *   // ctx.app, ctx.pool available in tests
 *
 * The setup handles:
 *   - Truncating all tables before each test
 *   - Providing a pool for direct queries (seeding, assertions)
 *   - Loading the Express app
 *   - Cleaning up after all tests
 */

import { Pool } from 'pg';
import type { Express } from 'express';
import { getTestPool, truncateAll, closeTestPool } from './pg-test-utils';

interface IntegrationTestContext {
  /** The Express app instance. Available after beforeAll. */
  app: Express;
  /** The Postgres pool for direct queries. Available after beforeAll. */
  pool: Pool;
}

/**
 * Sets up integration test lifecycle hooks.
 * Call at the top level of a test file (not inside describe).
 *
 * Note: This uses a lazy approach — app is loaded on first access via beforeAll,
 * and the pool is shared across all tests in the file. Tables are truncated
 * before each test for isolation.
 */
export function setupIntegrationTest(): IntegrationTestContext {
  const ctx: IntegrationTestContext = {
    app: null as unknown as Express,
    pool: null as unknown as Pool,
  };

  beforeAll(async () => {
    ctx.pool = getTestPool();

    // Dynamic require so that DATABASE_URL (set by jest.env.ts) is picked up
    const serverMod = require('../../server');
    ctx.app = serverMod.default;

    // Wait for DB initialization (pool connect + migrations)
    const { initDb } = require('../../db/index');
    await initDb();
  });

  beforeEach(async () => {
    // Clean slate for each test
    await truncateAll(ctx.pool);

    // Re-seed default admin (many tests need auth)
    await ctx.pool.query(`
      INSERT INTO users (id, email, display_name, role, plan, email_verified_at)
      VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'admin', 'pro', NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  });

  afterAll(async () => {
    // Don't close the shared pool here — jest.teardown handles cleanup.
    // Individual test files shouldn't close the shared pool.
  });

  return ctx;
}
