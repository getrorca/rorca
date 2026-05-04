/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-003: DB migration — reasoning_tokens column exists in token_usage table.
 *
 * Verifies that migration 20260403000000_add_reasoning_tokens.sql was applied
 * correctly to the token_usage table:
 *
 *   1. The migration file exists with the correct timestamp prefix format
 *   2. reasoning_tokens column exists in token_usage with type integer
 *   3. Column has a default value of 0
 *   4. Column is NOT NULL
 *   5. Migration is tracked in schema_migrations table
 *   6. DML behavior: default is 0, explicit value stored correctly, NOT NULL enforced
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// Derive test DB URL the same way jest.setup.ts and jest.env.ts do
function getTestDbUrl(): string {
  if (process.env.DATABASE_URL_TEST) return process.env.DATABASE_URL_TEST;
  const base = process.env.DATABASE_URL || 'postgres://rorca:rorca@localhost:5433/rorca';
  try {
    const parsed = new URL(base);
    const dbName = parsed.pathname.slice(1);
    if (!dbName.endsWith('_test')) {
      parsed.pathname = `/${dbName}_test`;
    }
    return parsed.toString();
  } catch {
    return 'postgres://rorca:rorca@localhost:5433/rorca_test';
  }
}

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'pg-migrations');
const MIGRATION_FILENAME = '20260403000000_add_reasoning_tokens.sql';
const MIGRATION_VERSION = 20260403000000;

let pool: Pool;

beforeAll(() => {
  pool = new Pool({
    connectionString: getTestDbUrl(),
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
});

afterAll(async () => {
  await pool.end();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Migration file exists
// ─────────────────────────────────────────────────────────────────────────────

describe('migration file', () => {
  it('exists in pg-migrations directory with timestamp prefix format', () => {
    const migrationPath = path.join(MIGRATIONS_DIR, MIGRATION_FILENAME);
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('contains ALTER TABLE token_usage ADD COLUMN reasoning_tokens', () => {
    const migrationPath = path.join(MIGRATIONS_DIR, MIGRATION_FILENAME);
    const content = fs.readFileSync(migrationPath, 'utf-8');
    expect(content).toMatch(/ALTER TABLE token_usage/i);
    expect(content).toMatch(/ADD COLUMN.*reasoning_tokens/i);
    expect(content).toMatch(/INTEGER/i);
    expect(content).toMatch(/DEFAULT 0/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Column schema — type, default, nullability
// ─────────────────────────────────────────────────────────────────────────────

describe('reasoning_tokens column schema', () => {
  it('column exists in token_usage table', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
  });

  it('has data_type integer', async () => {
    const { rows } = await pool.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('integer');
  });

  it('has default value of 0', async () => {
    const { rows } = await pool.query(`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
    // PostgreSQL stores the default as '0'
    expect(String(rows[0].column_default)).toBe('0');
  });

  it('is NOT NULL', async () => {
    const { rows } = await pool.query(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe('NO');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Migration tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('schema_migrations tracking', () => {
  it('migration version is recorded in schema_migrations', async () => {
    const { rows } = await pool.query(`
      SELECT version
      FROM schema_migrations
      WHERE version = $1
    `, [MIGRATION_VERSION]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].version)).toBe(MIGRATION_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DML behavior — default, explicit values, NOT NULL constraint
//
// token_usage actual schema (from migration 022):
//   id           SERIAL PRIMARY KEY
//   run_id       BIGINT NOT NULL  (no FK — any bigint is valid)
//   story_id     TEXT NOT NULL
//   workspace_id TEXT NOT NULL REFERENCES workspaces(id)
//   user_id      TEXT (nullable)
//   model        TEXT NOT NULL DEFAULT 'unknown'
//   input_tokens  INTEGER NOT NULL DEFAULT 0
//   output_tokens INTEGER NOT NULL DEFAULT 0
//   cost_usd     REAL NOT NULL DEFAULT 0
//   recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
//   reasoning_tokens INTEGER NOT NULL DEFAULT 0
//
// workspace_id has a FK to workspaces(id), so we must insert a workspace first.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_WORKSPACE_ID = 'qrw003-test-workspace';

// Inserts a workspace and a pipeline_run for use as FK targets in token_usage
async function ensureTestFixtures(client: import('pg').PoolClient): Promise<bigint> {
  await client.query(`
    INSERT INTO workspaces (id, label, path)
    VALUES ($1, 'QRW-003 Test Workspace', '/tmp/qrw003-test')
    ON CONFLICT (id) DO NOTHING
  `, [TEST_WORKSPACE_ID]);

  const { rows } = await client.query(`
    INSERT INTO pipeline_runs (spec_path, workspace_id, status)
    VALUES ('forge/specs/approved/qrw003-test.json', $1, 'done')
    RETURNING id
  `, [TEST_WORKSPACE_ID]);
  return rows[0].id as bigint;
}

describe('reasoning_tokens DML behavior', () => {
  it('INSERT without specifying reasoning_tokens uses default 0', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const runId = await ensureTestFixtures(client);
      const { rows } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id)
        VALUES ($1, 'test-story', $2)
        RETURNING reasoning_tokens
      `, [runId, TEST_WORKSPACE_ID]);
      expect(rows).toHaveLength(1);
      expect(rows[0].reasoning_tokens).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('INSERT with explicit reasoning_tokens=100 stores correctly', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const runId = await ensureTestFixtures(client);
      const { rows } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id, reasoning_tokens)
        VALUES ($1, 'test-story', $2, 100)
        RETURNING reasoning_tokens
      `, [runId, TEST_WORKSPACE_ID]);
      expect(rows).toHaveLength(1);
      expect(rows[0].reasoning_tokens).toBe(100);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('UPDATE reasoning_tokens on an existing row succeeds', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const runId = await ensureTestFixtures(client);
      const { rows: inserted } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id)
        VALUES ($1, 'test-story', $2)
        RETURNING id
      `, [runId, TEST_WORKSPACE_ID]);
      const { rows } = await client.query(
        'UPDATE token_usage SET reasoning_tokens = 42 WHERE id = $1 RETURNING reasoning_tokens',
        [inserted[0].id],
      );
      expect(rows[0].reasoning_tokens).toBe(42);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('reasoning_tokens cannot be set to NULL (NOT NULL constraint)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const runId = await ensureTestFixtures(client);
      const { rows: inserted } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id)
        VALUES ($1, 'test-story', $2)
        RETURNING id
      `, [runId, TEST_WORKSPACE_ID]);
      await expect(
        client.query(
          'UPDATE token_usage SET reasoning_tokens = NULL WHERE id = $1',
          [inserted[0].id],
        ),
      ).rejects.toThrow(/null value|not-null|violates not-null/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
