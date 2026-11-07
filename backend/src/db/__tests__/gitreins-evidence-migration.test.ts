/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260713170000_gitreins_evidence.sql';
const migrationPath = path.join(__dirname, '..', 'pg-migrations', migrationFile);

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const migrationPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});
const runtimePool = new Pool({
  connectionString: resolveTestDatabaseUrl(),
  max: 1,
  options: '--search_path=rorca,public',
});

async function rolledBackTransaction<T>(
  pool: Pool,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await action(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('GitReins append-only evidence migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  afterAll(async () => {
    await Promise.all([migrationPool.end(), runtimePool.end()]);
  });

  test('has a unique timestamp prefix and idempotent DDL', () => {
    const migrationDir = path.join(__dirname, '..', 'pg-migrations');
    const files = fs.readdirSync(migrationDir).filter(file => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS gitreins_evidence');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION reject_gitreins_evidence_mutation');
    expect(sql).toContain('CREATE OR REPLACE TRIGGER gitreins_evidence_append_only');
    expect(sql).toContain('CREATE OR REPLACE TRIGGER gitreins_evidence_no_truncate');
  });

  test('enforces append-only storage and constrained contract vocabulary', () => {
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON gitreins_evidence/);
    expect(sql).toMatch(/BEFORE TRUNCATE ON gitreins_evidence/);
    expect(sql).toContain("RAISE EXCEPTION 'gitreins_evidence is append-only");
    expect(sql).toContain("mode IN ('observe', 'enforce')");
    expect(sql).toContain("status IN ('pass', 'fail', 'error')");
    expect(sql).toContain("CHECK (command = 'judge')");
    expect(sql).toContain("CHECK (scope = 'working-tree')");
    expect(sql).not.toMatch(/pgboss\./);
  });

  test('can be applied a second time without replacing evidence rows', async () => {
    await rolledBackTransaction(migrationPool, async (client) => {
      const before = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM gitreins_evidence',
      );
      await client.query(sql);
      const after = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM gitreins_evidence',
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });
  });

  test('migration fixture principal observes append-only update, delete, and truncate gates', async () => {
    await rolledBackTransaction(migrationPool, async (client) => {
      const workspaceId = `gitreins-migration-test-${randomUUID()}`;
      const inserted = await client.query(
        `INSERT INTO gitreins_evidence
         (workspace_id, run_id, story_id, attempt, mode, status, reason_code)
         VALUES ($1, $2, $3, 1, 'observe', 'error', 'missing_binary')`,
        [workspaceId, 999999, 'US-TEST'],
      );
      expect(inserted.rowCount).toBe(1);

      const expectAppendOnly = async (statement: string, params: unknown[] = []): Promise<void> => {
        await client.query('SAVEPOINT expected_gitreins_rejection');
        try {
          await expect(client.query(statement, params)).rejects.toMatchObject({ code: '55000' });
        } finally {
          await client.query('ROLLBACK TO SAVEPOINT expected_gitreins_rejection');
          await client.query('RELEASE SAVEPOINT expected_gitreins_rejection');
        }
      };
      await expectAppendOnly(
        `UPDATE gitreins_evidence SET status = 'pass'
         WHERE workspace_id = $1 AND run_id = $2`,
        [workspaceId, 999999],
      );
      await expectAppendOnly(
        'DELETE FROM gitreins_evidence WHERE workspace_id = $1 AND run_id = $2',
        [workspaceId, 999999],
      );
      await expectAppendOnly('TRUNCATE gitreins_evidence');
    });
  });

  test('ordinary runtime cannot truncate canonical GitReins evidence', async () => {
    await expect(rolledBackTransaction(
      runtimePool,
      (client) => client.query('TRUNCATE rorca.gitreins_evidence'),
    )).rejects.toMatchObject({ code: '42501' });
  });
});
