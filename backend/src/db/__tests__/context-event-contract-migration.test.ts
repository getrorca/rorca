/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';
import { checkDuplicatePrefixes } from '../pg-index';

const migrationFile = '20260705160123_unified_context_event_contract.sql';
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
describe('UCC-007 context event contract migration', () => {
  const sql = fs.readFileSync(migrationPath, 'utf8');

  afterAll(async () => {
    await Promise.all([migrationPool.end(), runtimePool.end()]);
  });

  test('uses a unique timestamp prefix', () => {
    const migrationDir = path.join(__dirname, '..', 'pg-migrations');
    const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(migrationFile).toMatch(/^20260705160123_/);
  });

  test('historical migration SQL remains executable without mutating the shared current schema', async () => {
    const rollback = new Error('rollback historical migration probe');
    await expect(rolledBackTransaction(migrationPool, async (client) => {
      await client.query(sql);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  test('ordinary runtime cannot execute representative migration DDL', async () => {
    const table = `runtime_context_migration_probe_${Date.now()}`;
    await expect(rolledBackTransaction(
      runtimePool,
      (client) => client.query(`CREATE TABLE rorca.${table} (id BIGINT)`),
    )).rejects.toMatchObject({ code: '42501' });
  });

  test('is brownfield/idempotency friendly for existing rows and reruns', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS context_events');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS memory_candidates');
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(20);
    expect(sql).toContain('DEFAULT NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql).toContain('IF NOT EXISTS (');
    expect(sql).toContain('NOT VALID');
  });

  test('constrains only the UCC-007 event/trust vocabularies for future writes', () => {
    for (const eventType of ['agent_cli_session', 'ide_session', 'shell_command', 'editor_activity', 'explicit_memory', 'git_commit', 'ci_pr']) {
      expect(sql).toContain(`'${eventType}'`);
    }
    expect(sql).not.toContain("'cli_command'");
    for (const tier of ['untrusted', 'local', 'verified', 'privileged']) {
      expect(sql).toContain(`'${tier}'`);
    }
    expect(sql).toContain("payload_schema_version = '2026-07-ucc-007.v1'");
  });
});
