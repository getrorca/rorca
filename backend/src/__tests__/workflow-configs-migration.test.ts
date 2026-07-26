/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * QRW-002: DB migration — workflow_configs table schema and seed data verification.
 *
 * Connects to the PostgreSQL test database and verifies that migration
 * 20260404000001_workflow_configs.sql was applied correctly:
 *
 *   1. Table exists with correct column types and nullability
 *   2. Three seed rows exist (spec_generation, pipeline_execution, memory_consolidation)
 *   3. CHECK constraint on workflow_id rejects invalid values
 *   4. CHECK constraint on runtime rejects invalid values
 *   5. UNIQUE constraint on workflow_id prevents duplicates
 *   6. updated_at is NOT NULL and set to a recent timestamp
 *   7. id is a valid UUID (gen_random_uuid() default)
 */

import { Pool } from 'pg';

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
// Helper to re-seed if truncation wiped the rows
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSeedRows(): Promise<void> {
  await pool.query(`
    INSERT INTO workflow_configs (workflow_id, runtime, provider)
    VALUES
      ('spec_generation',      'native', 'claude-cli'),
      ('pipeline_execution',   'claude', 'claude-cli'),
      ('memory_consolidation', 'native', 'claude-cli')
    ON CONFLICT (workflow_id) DO NOTHING
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Table structure
// ─────────────────────────────────────────────────────────────────────────────

describe('workflow_configs table structure', () => {
  it('table exists', async () => {
    const { rows } = await pool.query(`
      SELECT COUNT(*) AS cnt
      FROM information_schema.tables
      WHERE table_name = 'workflow_configs'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
    `);
    expect(Number(rows[0].cnt)).toBe(1);
  });

  it('has exactly 6 columns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs'
      ORDER BY ordinal_position
    `);
    expect(rows).toHaveLength(6);
  });

  it('id column is uuid and NOT NULL', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs' AND column_name = 'id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('uuid');
    expect(rows[0].is_nullable).toBe('NO');
    // Default must be gen_random_uuid() or similar UUID generator
    expect(rows[0].column_default).toMatch(/uuid|random/i);
  });

  it('workflow_id column is text and NOT NULL', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs' AND column_name = 'workflow_id'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('runtime column is text and NOT NULL', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs' AND column_name = 'runtime'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('provider column is text and NOT NULL', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs' AND column_name = 'provider'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('model column is text and nullable', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs' AND column_name = 'model'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('text');
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('updated_at column is timestamptz and NOT NULL', async () => {
    const { rows } = await pool.query(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'workflow_configs' AND column_name = 'updated_at'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('timestamp with time zone');
    expect(rows[0].is_nullable).toBe('NO');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Seed rows
// ─────────────────────────────────────────────────────────────────────────────

describe('workflow_configs seed data', () => {
  beforeEach(async () => {
    await ensureSeedRows();
  });

  it('has exactly 3 rows after seeding', async () => {
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM workflow_configs');
    expect(Number(rows[0].cnt)).toBe(3);
  });

  it('spec_generation row exists with correct defaults', async () => {
    const { rows } = await pool.query(
      'SELECT workflow_id, runtime, provider, model FROM workflow_configs WHERE workflow_id = $1',
      ['spec_generation'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workflow_id).toBe('spec_generation');
    expect(rows[0].runtime).toBe('native');
    expect(rows[0].provider).toBe('claude-cli');
    expect(rows[0].model).toBeNull();
  });

  it('pipeline_execution row exists with correct defaults', async () => {
    const { rows } = await pool.query(
      'SELECT workflow_id, runtime, provider, model FROM workflow_configs WHERE workflow_id = $1',
      ['pipeline_execution'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workflow_id).toBe('pipeline_execution');
    expect(rows[0].runtime).toBe('claude');
    expect(rows[0].provider).toBe('claude-cli');
    expect(rows[0].model).toBeNull();
  });

  it('memory_consolidation row exists with correct defaults', async () => {
    const { rows } = await pool.query(
      'SELECT workflow_id, runtime, provider, model FROM workflow_configs WHERE workflow_id = $1',
      ['memory_consolidation'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].workflow_id).toBe('memory_consolidation');
    expect(rows[0].runtime).toBe('native');
    expect(rows[0].provider).toBe('claude-cli');
    expect(rows[0].model).toBeNull();
  });

  it('all 3 workflow_ids are present when queried together', async () => {
    const { rows } = await pool.query(
      'SELECT workflow_id FROM workflow_configs ORDER BY workflow_id',
    );
    const ids = rows.map((r: { workflow_id: string }) => r.workflow_id);
    expect(ids).toEqual(['memory_consolidation', 'pipeline_execution', 'spec_generation']);
  });

  it('updated_at is a valid persisted timestamp on all rows', async () => {
    const { rows } = await pool.query('SELECT updated_at FROM workflow_configs');
    const migrationEpoch = new Date('2026-04-04T00:00:00.000Z').getTime();
    for (const row of rows) {
      const timestamp = new Date(row.updated_at).getTime();
      expect(Number.isFinite(timestamp)).toBe(true);
      expect(timestamp).toBeGreaterThanOrEqual(migrationEpoch);
      expect(timestamp).toBeLessThanOrEqual(Date.now());
    }
  });

  it('id is a valid UUID on all rows', async () => {
    const { rows } = await pool.query('SELECT id FROM workflow_configs');
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of rows) {
      expect(row.id).toMatch(uuidRegex);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CHECK constraint — workflow_id
// ─────────────────────────────────────────────────────────────────────────────

describe('CHECK constraint on workflow_id', () => {
  it('chk_workflow_id constraint exists', async () => {
    const { rows } = await pool.query(`
      SELECT constraint_name, check_clause
      FROM information_schema.check_constraints
      WHERE constraint_name = 'chk_workflow_id'
    `);
    expect(rows).toHaveLength(1);
    // Constraint should reference all 3 valid workflow IDs
    expect(rows[0].check_clause).toContain('spec_generation');
    expect(rows[0].check_clause).toContain('pipeline_execution');
    expect(rows[0].check_clause).toContain('memory_consolidation');
  });

  it('rejects INSERT with unknown workflow_id', async () => {
    await expect(
      pool.query(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider)
         VALUES ($1, $2, $3)`,
        ['unknown_workflow', 'native', 'claude-cli'],
      ),
    ).rejects.toThrow(/chk_workflow_id|check/i);
  });

  it('rejects INSERT with empty string workflow_id', async () => {
    await expect(
      pool.query(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider)
         VALUES ($1, $2, $3)`,
        ['', 'native', 'claude-cli'],
      ),
    ).rejects.toThrow(/chk_workflow_id|check/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHECK constraint — runtime
// ─────────────────────────────────────────────────────────────────────────────

describe('CHECK constraint on runtime', () => {
  it('chk_runtime constraint exists', async () => {
    const { rows } = await pool.query(`
      SELECT constraint_name, check_clause
      FROM information_schema.check_constraints
      WHERE constraint_name = 'chk_runtime'
    `);
    expect(rows).toHaveLength(1);
    // Constraint should reference all 4 valid runtime values
    expect(rows[0].check_clause).toContain('native');
    expect(rows[0].check_clause).toContain('claude');
    expect(rows[0].check_clause).toContain('opencode');
    expect(rows[0].check_clause).toContain('codex');
  });

  it('accepts all 4 valid runtime values', async () => {
    // Use a client for transactional cleanup
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const runtime of ['native', 'claude', 'opencode', 'codex']) {
        // Use a different workflow_id each time to avoid UNIQUE violation
        // Use a temp insert that we'll rollback
        await expect(
          client.query(
            `INSERT INTO workflow_configs (workflow_id, runtime, provider)
             VALUES ($1, $2, $3)
             ON CONFLICT (workflow_id) DO UPDATE SET runtime = $2`,
            ['pipeline_execution', runtime, 'claude-cli'],
          ),
        ).resolves.toBeDefined();
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects INSERT with unknown runtime value', async () => {
    // Use a transaction to not affect other tests
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `INSERT INTO workflow_configs (workflow_id, runtime, provider)
           VALUES ($1, $2, $3)`,
          ['spec_generation', 'invalid_runtime', 'claude-cli'],
        ),
      ).rejects.toThrow(/chk_runtime|check/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects UPDATE setting runtime to invalid value', async () => {
    await ensureSeedRows();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(
        client.query(
          `UPDATE workflow_configs SET runtime = $1 WHERE workflow_id = $2`,
          ['bad_runtime', 'pipeline_execution'],
        ),
      ).rejects.toThrow(/chk_runtime|check/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. UNIQUE constraint on workflow_id
// ─────────────────────────────────────────────────────────────────────────────

describe('UNIQUE constraint on workflow_id', () => {
  it('rejects duplicate workflow_id INSERT', async () => {
    await ensureSeedRows();
    await expect(
      pool.query(
        `INSERT INTO workflow_configs (workflow_id, runtime, provider)
         VALUES ($1, $2, $3)`,
        ['spec_generation', 'native', 'claude-cli'],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it('ON CONFLICT DO NOTHING is idempotent', async () => {
    await ensureSeedRows();

    // Insert the same rows again — should not throw and should not change data
    await expect(
      pool.query(`
        INSERT INTO workflow_configs (workflow_id, runtime, provider)
        VALUES
          ('spec_generation',      'native', 'claude-cli'),
          ('pipeline_execution',   'claude', 'claude-cli'),
          ('memory_consolidation', 'native', 'claude-cli')
        ON CONFLICT (workflow_id) DO NOTHING
      `),
    ).resolves.toBeDefined();

    // Count should still be 3 (or same as before re-seeding)
    const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM workflow_configs');
    expect(Number(rows[0].cnt)).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Primary key and basic DML
// ─────────────────────────────────────────────────────────────────────────────

describe('workflow_configs DML operations', () => {
  beforeEach(async () => {
    await ensureSeedRows();
  });

  it('UPDATE runtime and provider on existing row succeeds', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE workflow_configs
         SET runtime = $1, provider = $2, updated_at = NOW()
         WHERE workflow_id = $3
         RETURNING workflow_id, runtime, provider`,
        ['opencode', 'openrouter', 'pipeline_execution'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].runtime).toBe('opencode');
      expect(rows[0].provider).toBe('openrouter');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('UPDATE model to a non-null string succeeds', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE workflow_configs
         SET model = $1, updated_at = NOW()
         WHERE workflow_id = $2
         RETURNING model`,
        ['openrouter/auto', 'spec_generation'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].model).toBe('openrouter/auto');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('UPDATE model back to NULL is allowed', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // First set a model
      await client.query(
        `UPDATE workflow_configs SET model = $1 WHERE workflow_id = $2`,
        ['some/model', 'pipeline_execution'],
      );
      // Then clear it
      const { rows } = await client.query(
        `UPDATE workflow_configs SET model = NULL WHERE workflow_id = $1
         RETURNING model`,
        ['pipeline_execution'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].model).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
