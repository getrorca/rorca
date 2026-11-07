/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const migrationPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 2,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});
const runtimePool = new Pool({
  connectionString: resolveTestDatabaseUrl(),
  max: 1,
  options: '--search_path=rorca,public',
});
let workspaceId = '';

afterAll(async () => {
  await Promise.all([migrationPool.end(), runtimePool.end()]);
});

beforeEach(() => {
  workspaceId = randomUUID();
});

afterEach(async () => {
  await migrationPool.query('DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)', [workspaceId]);
  await migrationPool.query('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
  await migrationPool.query('DELETE FROM direction_layers WHERE workspace_id = $1', [workspaceId]);
  await migrationPool.query('DELETE FROM wal_events WHERE workspace_id = $1', [workspaceId]);
  await migrationPool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

  // prepareLiteSkippedMigrationsForReplay intentionally removes all skip
  // receipts. Restore canonical receipts through the migration runner so this
  // suite cannot poison a later isolated certification batch.
  const { runPgMigrations } = await import('../pg-index');
  await runPgMigrations(migrationPool);
});

test('SELECT 1 succeeds through the migration fixture principal', async () => {
  const { rows } = await migrationPool.query('SELECT 1 AS result');
  expect(rows[0].result).toBe(1);
});

test('all core tables exist in pg_tables', async () => {
  const { rows } = await migrationPool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'rorca'
      AND tablename != 'schema_migrations'
    ORDER BY tablename
  `);
  const names = rows.map(r => r.tablename).sort();

  // Verify key tables exist (subset check — new migrations may add more)
  const expectedTables = [
    'agent_hooks',
    'agent_profiles',
    'budget_config',
    'direction_layers',
    'pipeline_runs',
    'pipeline_schedules',
    'rate_limits',
    'spec_versions',
    'story_comments',
    'story_commits',
    'story_results',
    'teams',
    'templates',
    'token_usage',
    'users',
    'wal_events',
    'workspace_context',
    'workspace_env_vars',
    'workspaces',
  ];

  for (const table of expectedTables) {
    expect(names).toContain(table);
  }
});

test('ordinary runtime cannot perform DDL or mutate migration receipts or canonical evidence', async () => {
  const client = await runtimePool.connect();
  const statements = [
    `CREATE TABLE rorca.runtime_db_probe_${Date.now()} (id BIGINT)`,
    `INSERT INTO public.schema_migrations(version, filename)
     VALUES (99999999999997, 'runtime-must-not-write.sql')`,
    'INSERT INTO rorca.runtime_events DEFAULT VALUES',
  ];
  try {
    for (const statement of statements) {
      await client.query('BEGIN');
      try {
        await expect(client.query(statement)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await client.query('ROLLBACK');
      }
    }
  } finally {
    client.release();
  }
});

test('migration fixture principal can INSERT and SELECT fixture-owned rows from core tables', async () => {
  const storyId = `US-${randomUUID()}`;
  const eventType = `test-${randomUUID()}`;

  await migrationPool.query('INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
  [workspaceId, 'Test', `/tmp/${workspaceId}`],);
  const { rows: wsRows } = await migrationPool.query('SELECT * FROM workspaces WHERE id = $1',
  [workspaceId],);
  expect(wsRows).toHaveLength(1);
  expect(wsRows[0].label).toBe('Test');

  await migrationPool.query('INSERT INTO direction_layers (workspace_id, layer, content_yaml) VALUES ($1, 1, $2)',
  [workspaceId, 'key: val'],);
  const { rows: dlRows } = await migrationPool.query('SELECT * FROM direction_layers WHERE workspace_id = $1',
  [workspaceId],);
  expect(dlRows).toHaveLength(1);
  expect(dlRows[0].content_yaml).toBe('key: val');

  const { rows: prRows } = await migrationPool.query(`INSERT INTO pipeline_runs (spec_path, workspace_id, status)
   VALUES ($1, $2, 'running')
   RETURNING *`,
  ['spec.yaml', workspaceId],);
  expect(prRows).toHaveLength(1);
  expect(prRows[0].status).toBe('running');

  const runId = prRows[0].id;
  await migrationPool.query("INSERT INTO story_results (run_id, story_id, status) VALUES ($1, $2, 'pass')",
  [runId, storyId],);
  const { rows: srRows } = await migrationPool.query('SELECT * FROM story_results WHERE run_id = $1 AND story_id = $2',
  [runId, storyId],);
  expect(srRows).toHaveLength(1);
  expect(srRows[0].status).toBe('pass');

  await migrationPool.query(`INSERT INTO wal_events (event_type, workspace_id, payload)
   VALUES ($1, $2, $3::jsonb)`,
  [eventType, workspaceId, JSON.stringify({ a: 1 })],);
  const { rows: weRows } = await migrationPool.query('SELECT * FROM wal_events WHERE workspace_id = $1 AND event_type = $2',
  [workspaceId, eventType],);
  expect(weRows).toHaveLength(1);
  expect(weRows[0].workspace_id).toBe(workspaceId);
});

test('schema_migrations has applied versions', async () => {
  const { rows } = await migrationPool.query('SELECT version, filename FROM schema_migrations ORDER BY version ASC');
  expect(rows.length).toBeGreaterThan(0);
  expect(Number(rows[0].version)).toBe(1);
  expect(rows[0].filename).toContain('001');
});

test('schema_migrations tracks lite-skipped migrations explicitly', async () => {
  const { rows } = await migrationPool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'schema_migrations'
      AND column_name = 'skipped_in_lite_mode'
  `);
  expect(rows).toHaveLength(1);
});

test('running migrations again is idempotent', async () => {
  // Import and re-run — should not throw
  const { runPgMigrations } = require('../pg-index');
  await expect(runPgMigrations(migrationPool)).resolves.not.toThrow();
});

test('prepareLiteSkippedMigrationsForReplay waits for the canonical migration session lock', async () => {
  const version = 99999999999998;
  await migrationPool.query(`INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode)
   VALUES ($1, '050_knowledge_graph.sql [skipped: extension unavailable]', TRUE)
   ON CONFLICT (version) DO UPDATE SET skipped_in_lite_mode=TRUE`, [version],);
  const lockClient = await migrationPool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [8_244_250_520_000]);
  let completed = false;
  const { prepareLiteSkippedMigrationsForReplay } = require('../pg-index');
  const replay = prepareLiteSkippedMigrationsForReplay(migrationPool).then((versions: number[]) => {
    completed = true;
    return versions;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(completed).toBe(false);
  await lockClient.query('SELECT pg_advisory_unlock($1)', [8_244_250_520_000]);
  lockClient.release();
  await expect(replay).resolves.toContain(version);
});

test('prepareLiteSkippedMigrationsForReplay removes lite-skipped rows so they can be replayed', async () => {
  const version = 99999999999999;
  await migrationPool.query(`INSERT INTO schema_migrations (version, filename, skipped_in_lite_mode)
   VALUES ($1, $2, TRUE)
   ON CONFLICT (version) DO UPDATE
     SET filename = EXCLUDED.filename,
         skipped_in_lite_mode = EXCLUDED.skipped_in_lite_mode`,
  [version, '050_knowledge_graph.sql [skipped: extension unavailable]']);

  const { prepareLiteSkippedMigrationsForReplay } = require('../pg-index');
  const versions = await prepareLiteSkippedMigrationsForReplay(migrationPool);
  expect(versions).toContain(version);

  const { rows } = await migrationPool.query('SELECT version FROM schema_migrations WHERE version = $1',
  [version]);
  expect(rows).toHaveLength(0);
});
