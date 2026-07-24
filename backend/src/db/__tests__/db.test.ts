/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { getTestPool, closeTestPool } from '../../__tests__/helpers/pg-test-utils';

let pool: Pool;
let workspaceId = '';

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(() => {
  workspaceId = randomUUID();
});

afterEach(async () => {
  await pool.query('DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)', [workspaceId]);
  await pool.query('DELETE FROM pipeline_runs WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM direction_layers WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM wal_events WHERE workspace_id = $1', [workspaceId]);
  await pool.query('DELETE FROM workspaces WHERE id = $1', [workspaceId]);

  // prepareLiteSkippedMigrationsForReplay intentionally removes all skip
  // receipts. Restore canonical receipts through the migration runner so this
  // suite cannot poison a later isolated certification batch.
  const { runPgMigrations } = await import('../pg-index');
  await runPgMigrations(pool);
});

test('SELECT 1 succeeds (pool is connected)', async () => {
  const { rows } = await pool.query('SELECT 1 AS result');
  expect(rows[0].result).toBe(1);
});

test('all core tables exist in pg_tables', async () => {
  const { rows } = await pool.query(`
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

test('can INSERT and SELECT fixture-owned rows from core tables', async () => {
  const storyId = `US-${randomUUID()}`;
  const eventType = `test-${randomUUID()}`;

  await pool.query(
    'INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)',
    [workspaceId, 'Test', `/tmp/${workspaceId}`],
  );
  const { rows: wsRows } = await pool.query(
    'SELECT * FROM workspaces WHERE id = $1',
    [workspaceId],
  );
  expect(wsRows).toHaveLength(1);
  expect(wsRows[0].label).toBe('Test');

  await pool.query(
    'INSERT INTO direction_layers (workspace_id, layer, content_yaml) VALUES ($1, 1, $2)',
    [workspaceId, 'key: val'],
  );
  const { rows: dlRows } = await pool.query(
    'SELECT * FROM direction_layers WHERE workspace_id = $1',
    [workspaceId],
  );
  expect(dlRows).toHaveLength(1);
  expect(dlRows[0].content_yaml).toBe('key: val');

  const { rows: prRows } = await pool.query(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status)
     VALUES ($1, $2, 'running')
     RETURNING *`,
    ['spec.yaml', workspaceId],
  );
  expect(prRows).toHaveLength(1);
  expect(prRows[0].status).toBe('running');

  const runId = prRows[0].id;
  await pool.query(
    "INSERT INTO story_results (run_id, story_id, status) VALUES ($1, $2, 'pass')",
    [runId, storyId],
  );
  const { rows: srRows } = await pool.query(
    'SELECT * FROM story_results WHERE run_id = $1 AND story_id = $2',
    [runId, storyId],
  );
  expect(srRows).toHaveLength(1);
  expect(srRows[0].status).toBe('pass');

  await pool.query(
    `INSERT INTO wal_events (event_type, workspace_id, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [eventType, workspaceId, JSON.stringify({ a: 1 })],
  );
  const { rows: weRows } = await pool.query(
    'SELECT * FROM wal_events WHERE workspace_id = $1 AND event_type = $2',
    [workspaceId, eventType],
  );
  expect(weRows).toHaveLength(1);
  expect(weRows[0].workspace_id).toBe(workspaceId);
});

test('schema_migrations has applied versions', async () => {
  const { rows } = await pool.query(
    'SELECT version, filename FROM schema_migrations ORDER BY version ASC'
  );
  expect(rows.length).toBeGreaterThan(0);
  expect(Number(rows[0].version)).toBe(1);
  expect(rows[0].filename).toContain('001');
});

test('schema_migrations tracks lite-skipped migrations explicitly', async () => {
  const { rows } = await pool.query(`
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
  await expect(runPgMigrations(pool)).resolves.not.toThrow();
});

test('prepareLiteSkippedMigrationsForReplay waits for the canonical migration session lock', async () => {
  const version = 99999999999998;
  await pool.query(
    `INSERT INTO public.schema_migrations (version, filename, skipped_in_lite_mode)
     VALUES ($1, '050_knowledge_graph.sql [skipped: extension unavailable]', TRUE)
     ON CONFLICT (version) DO UPDATE SET skipped_in_lite_mode=TRUE`, [version],
  );
  const lockClient = await pool.connect();
  await lockClient.query('SELECT pg_advisory_lock($1)', [8_244_250_520_000]);
  let completed = false;
  const { prepareLiteSkippedMigrationsForReplay } = require('../pg-index');
  const replay = prepareLiteSkippedMigrationsForReplay(pool).then((versions: number[]) => {
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
  await pool.query(
    `INSERT INTO schema_migrations (version, filename, skipped_in_lite_mode)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (version) DO UPDATE
       SET filename = EXCLUDED.filename,
           skipped_in_lite_mode = EXCLUDED.skipped_in_lite_mode`,
    [version, '050_knowledge_graph.sql [skipped: extension unavailable]']
  );

  const { prepareLiteSkippedMigrationsForReplay } = require('../pg-index');
  const versions = await prepareLiteSkippedMigrationsForReplay(pool);
  expect(versions).toContain(version);

  const { rows } = await pool.query(
    'SELECT version FROM schema_migrations WHERE version = $1',
    [version]
  );
  expect(rows).toHaveLength(0);
});
