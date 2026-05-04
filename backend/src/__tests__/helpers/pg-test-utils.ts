/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pg-test-utils.ts — PostgreSQL test utilities
 *
 * Provides per-test transaction isolation and standard test fixtures.
 *
 * Usage in tests:
 *   import { getTestPool, withTestTransaction, seedTestData, truncateAll } from '../helpers/pg-test-utils';
 *
 *   let pool: Pool;
 *   beforeAll(() => { pool = getTestPool(); });
 *   afterAll(() => pool.end());
 *
 *   // Wrap each test in a rolled-back transaction:
 *   withTestTransaction(pool, async (client) => {
 *     await seedTestData(client);
 *     // ... test code ...
 *   });
 */

import { Pool, PoolClient } from 'pg';

const TEST_DB_URL = process.env.DATABASE_URL_TEST
  || process.env.DATABASE_URL
  || 'postgres://rorca:rorca@localhost:5432/rorca_test';

let _sharedPool: Pool | null = null;

/**
 * Get a shared pool for the test DB. Reuses the same pool across tests in a file.
 */
export function getTestPool(): Pool {
  if (!_sharedPool) {
    _sharedPool = new Pool({
      connectionString: TEST_DB_URL,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return _sharedPool;
}

/**
 * Close the shared pool. Call in afterAll().
 */
export async function closeTestPool(): Promise<void> {
  if (_sharedPool) {
    await _sharedPool.end();
    _sharedPool = null;
  }
}

/**
 * Run a test function inside a transaction that is rolled back after completion.
 * Ensures test isolation without the cost of full schema recreation.
 */
export async function withTestTransaction(
  pool: Pool,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Create a savepoint so nested transaction calls don't break
    await client.query('SAVEPOINT test_start');
    await fn(client);
  } finally {
    // Always roll back — this is the isolation mechanism
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Truncate all user tables (except schema_migrations).
 * Useful for beforeEach in integration tests that need clean state.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  const { rows } = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename != 'schema_migrations'
    ORDER BY tablename
  `);
  if (rows.length > 0) {
    const tableNames = rows.map((r: { tablename: string }) => `"${r.tablename}"`).join(', ');
    await pool.query(`TRUNCATE ${tableNames} CASCADE`);
  }
}

/**
 * Seed a standard set of test fixtures.
 * Inserts deterministic data used across multiple test files.
 *
 * @param client - A PoolClient (typically from withTestTransaction)
 */
export async function seedTestData(client: PoolClient): Promise<void> {
  // ── Workspaces (2) ────────────────────────────────────────────
  await client.query(`
    INSERT INTO workspaces (id, label, path)
    VALUES
      ('ws-test-1', 'Test Workspace 1', '/tmp/test-ws-1'),
      ('ws-test-2', 'Test Workspace 2', '/tmp/test-ws-2')
    ON CONFLICT (id) DO NOTHING
  `);

  // ── Users (default admin) ─────────────────────────────────────
  await client.query(`
    INSERT INTO users (id, email, display_name, role, plan, email_verified_at)
    VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'admin', 'pro', NOW())
    ON CONFLICT (id) DO NOTHING
  `);

  // ── Direction layers (L1-L3) ──────────────────────────────────
  await client.query(`
    INSERT INTO direction_layers (workspace_id, layer, content_yaml, updated_at)
    VALUES
      ('ws-test-1', 1, 'engineering: Follow DRY principle', NOW()),
      ('ws-test-1', 2, 'domain: SaaS patterns', NOW()),
      ('ws-test-1', 3, 'project: React + Express stack', NOW())
    ON CONFLICT DO NOTHING
  `);

  // ── Pipeline runs (3) ─────────────────────────────────────────
  await client.query(`
    INSERT INTO pipeline_runs (spec_path, workspace_id, status, started_at)
    VALUES
      ('forge/specs/approved/auth-system.json', 'ws-test-1', 'done', NOW() - INTERVAL '2 hours'),
      ('forge/specs/approved/dashboard.json', 'ws-test-1', 'done', NOW() - INTERVAL '1 hour'),
      ('forge/specs/approved/active-spec.json', 'ws-test-1', 'running', NOW())
  `);

  // ── Story results (10) ────────────────────────────────────────
  // Get the run IDs we just inserted
  const { rows: runs } = await client.query(
    "SELECT id FROM pipeline_runs WHERE workspace_id = 'ws-test-1' ORDER BY started_at ASC"
  );

  if (runs.length >= 2) {
    const run1 = runs[0].id;
    const run2 = runs[1].id;

    await client.query(`
      INSERT INTO story_results (run_id, story_id, status, started_at, finished_at)
      VALUES
        ($1, 'US-001', 'pass', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour 50 minutes'),
        ($1, 'US-002', 'pass', NOW() - INTERVAL '1 hour 50 minutes', NOW() - INTERVAL '1 hour 40 minutes'),
        ($1, 'US-003', 'fail', NOW() - INTERVAL '1 hour 40 minutes', NOW() - INTERVAL '1 hour 30 minutes'),
        ($1, 'US-004', 'pass', NOW() - INTERVAL '1 hour 30 minutes', NOW() - INTERVAL '1 hour 20 minutes'),
        ($1, 'US-005', 'skip', NOW() - INTERVAL '1 hour 20 minutes', NOW() - INTERVAL '1 hour 10 minutes'),
        ($2, 'US-001', 'pass', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '50 minutes'),
        ($2, 'US-002', 'pass', NOW() - INTERVAL '50 minutes', NOW() - INTERVAL '40 minutes'),
        ($2, 'US-003', 'pass', NOW() - INTERVAL '40 minutes', NOW() - INTERVAL '30 minutes'),
        ($2, 'US-004', 'fail', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '20 minutes'),
        ($2, 'US-005', 'pass', NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '10 minutes')
    `, [run1, run2]);
  }

  // ── WAL events (5) ────────────────────────────────────────────
  await client.query(`
    INSERT INTO wal_events (event_type, workspace_id, spec_id, payload, actor)
    VALUES
      ('generate', 'ws-test-1', 'auth-system', '{"provider":"claude-cli","model":"claude-sonnet-4-5-20250929","storyCount":5}', 'ralph'),
      ('spec_approved', 'ws-test-1', 'auth-system', '{"workspaceId":"ws-test-1"}', 'user'),
      ('run_started', 'ws-test-1', 'auth-system', '{"runId":1}', 'ralph'),
      ('story_passed', 'ws-test-1', 'auth-system', '{"storyId":"US-001"}', 'ralph'),
      ('run_finished', 'ws-test-1', 'auth-system', '{"runId":1,"passCount":4,"failCount":1}', 'ralph')
  `);
}
