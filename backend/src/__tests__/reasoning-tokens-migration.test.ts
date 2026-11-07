/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
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

import { randomInt, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'src', 'db', 'pg-migrations');
const MIGRATION_FILENAME = '20260403000000_add_reasoning_tokens.sql';
const MIGRATION_VERSION = 20260403000000;

const runtimeDatabaseUrl = process.env.DATABASE_URL;
const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!runtimeDatabaseUrl || !migrationDatabaseUrl) {
  throw new Error('DATABASE_URL and WAVE2_TEST_MIGRATION_DATABASE_URL are required');
}
const TEST_WORKSPACE_ID = `reasoning-tokens-${randomUUID()}`;
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 2,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${TEST_WORKSPACE_ID}`,
});
const runtimePool = new Pool({
  connectionString: runtimeDatabaseUrl,
  max: 1,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  options: `--search_path=rorca,public -c rorca.workspace_id=${TEST_WORKSPACE_ID}`,
});

async function expectRuntimeOwnerActionDenied(sql: string): Promise<void> {
  const client = await runtimePool.connect();
  try {
    await client.query('BEGIN');
    await expect(client.query(sql)).rejects.toMatchObject({ code: '42501' });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    () => runtimePool.end(),
    () => ownerPool.end(),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'reasoning tokens migration cleanup failed');
  }
});

describe('reasoning_tokens principal boundary', () => {
  it('denies runtime DDL and migration-receipt writes', async () => {
    await expectRuntimeOwnerActionDenied(
      'ALTER TABLE token_usage ADD COLUMN runtime_owner_probe BOOLEAN',
    );
    await expectRuntimeOwnerActionDenied(
      `INSERT INTO public.schema_migrations (version, filename)
       VALUES (20991231999992, 'runtime-owner-probe.sql')`,
    );
  });
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
    const { rows } = await ownerPool.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND table_schema = 'rorca'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
  });

  it('has data_type integer', async () => {
    const { rows } = await ownerPool.query(`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND table_schema = 'rorca'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('integer');
  });

  it('has default value of 0', async () => {
    const { rows } = await ownerPool.query(`
      SELECT column_default
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND table_schema = 'rorca'
        AND column_name = 'reasoning_tokens'
    `);
    expect(rows).toHaveLength(1);
    // PostgreSQL stores the default as '0'
    expect(String(rows[0].column_default)).toBe('0');
  });

  it('is NOT NULL', async () => {
    const { rows } = await ownerPool.query(`
      SELECT is_nullable
      FROM information_schema.columns
      WHERE table_name = 'token_usage'
        AND table_schema = 'rorca'
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
    const { rows } = await ownerPool.query(`
      SELECT version
      FROM public.schema_migrations
      WHERE version = $1
    `, [MIGRATION_VERSION]);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].version)).toBe(MIGRATION_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DML behavior — default, explicit values, NOT NULL constraint
//
// token_usage is workspace-bound and its run_id now references pipeline_runs,
// so both owner-created fixture rows are transaction-local.
// ─────────────────────────────────────────────────────────────────────────────

const TEST_RUN_ID = randomInt(9_000_000_000, 9_999_999_999);

async function ensureTestWorkspace(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'QRW-003 Test Workspace', $2)`,
    [TEST_WORKSPACE_ID, `/tmp/${TEST_WORKSPACE_ID}`],
  );
  await client.query(
    `INSERT INTO pipeline_runs (id, spec_path, workspace_id, status)
     VALUES ($1, $2, $3, 'done')`,
    [TEST_RUN_ID, `forge/specs/approved/${TEST_WORKSPACE_ID}.json`, TEST_WORKSPACE_ID],
  );
}

describe('reasoning_tokens DML behavior', () => {
  it('INSERT without specifying reasoning_tokens uses default 0', async () => {
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await ensureTestWorkspace(client);
      const { rows } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id)
        VALUES ($1, 'test-story', $2)
        RETURNING reasoning_tokens
      `, [TEST_RUN_ID, TEST_WORKSPACE_ID]);
      expect(rows).toHaveLength(1);
      expect(rows[0].reasoning_tokens).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('INSERT with explicit reasoning_tokens=100 stores correctly', async () => {
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await ensureTestWorkspace(client);
      const { rows } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id, reasoning_tokens)
        VALUES ($1, 'test-story', $2, 100)
        RETURNING reasoning_tokens
      `, [TEST_RUN_ID, TEST_WORKSPACE_ID]);
      expect(rows).toHaveLength(1);
      expect(rows[0].reasoning_tokens).toBe(100);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('UPDATE reasoning_tokens on an existing row succeeds', async () => {
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await ensureTestWorkspace(client);
      const { rows: inserted } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id)
        VALUES ($1, 'test-story', $2)
        RETURNING id
      `, [TEST_RUN_ID, TEST_WORKSPACE_ID]);
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
    const client = await ownerPool.connect();
    try {
      await client.query('BEGIN');
      await ensureTestWorkspace(client);
      const { rows: inserted } = await client.query(`
        INSERT INTO token_usage (run_id, story_id, workspace_id)
        VALUES ($1, 'test-story', $2)
        RETURNING id
      `, [TEST_RUN_ID, TEST_WORKSPACE_ID]);
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
