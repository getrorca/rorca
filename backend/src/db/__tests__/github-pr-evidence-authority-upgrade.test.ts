/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';

const migrations = path.join(process.cwd(), 'src/db/pg-migrations');
const parent090 = fs.readFileSync(path.join(migrations, '20260720090000_github_check_projection_authority.sql'), 'utf8');
const forward = fs.readFileSync(path.join(migrations, '20260720130000_github_pr_evidence_authority_upgrade.sql'), 'utf8');

test('post-parent PR evidence authority is only carried by the unique forward migration', () => {
  expect(parent090).not.toContain('ALTER TABLE github_pr_delivery_evidence');
  expect(parent090).not.toContain('enforce_github_pr_evidence_authority_immutability');
  expect(forward).toContain('ALTER TABLE github_pr_delivery_evidence');
  expect(forward).toContain('DROP CONSTRAINT IF EXISTS github_check_projection_repository_authority_ck');
  expect(forward).toContain('GITHUB_CHECK_RUN_LEGACY_AUTHORITY_UNFROZEN');
});

test('090000-recorded old schema upgrades, backfills, fences mutation, and reruns idempotently', async () => {
  const pool = new Pool({ connectionString: resolveTestDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  const schema = `upgrade_${randomUUID().replaceAll('-', '')}`;
  const bindingId = randomUUID();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`
      CREATE TABLE schema_migrations (
        version BIGINT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        filename TEXT NOT NULL, skipped_in_lite_mode BOOLEAN NOT NULL DEFAULT FALSE
      );
      INSERT INTO schema_migrations(version, filename) VALUES
        (20260720090000, '20260720090000_github_check_projection_authority.sql');
      CREATE TABLE github_app_workspace_bindings (id UUID PRIMARY KEY);
      CREATE TABLE pipeline_run_release_intents (
        run_id BIGINT, workspace_id TEXT, authorized_sha TEXT,
        repository_owner TEXT, repository_name TEXT, repository_authority_source TEXT,
        repository_binding_id UUID, repository_installation_id BIGINT, repository_id BIGINT
      );
      CREATE TABLE github_check_run_projections (
        repository_owner TEXT, repository_name TEXT, repository_authority_source TEXT,
        repository_binding_id UUID, repository_installation_id BIGINT, repository_id BIGINT,
        projection_status TEXT, last_error_code TEXT
      );
      ALTER TABLE github_check_run_projections
        ADD CONSTRAINT github_check_projection_repository_authority_ck CHECK (
          repository_owner IS NULL OR repository_name IS NOT NULL
        ) NOT VALID;
      CREATE TABLE github_pr_delivery_evidence (
        run_id BIGINT, workspace_id TEXT, head_sha TEXT, repo_owner TEXT, repo_name TEXT
      );
    `);
    await client.query('INSERT INTO github_app_workspace_bindings(id) VALUES ($1)', [bindingId]);
    await client.query(`INSERT INTO pipeline_run_release_intents VALUES
      (7, 'ws-upgrade', $1, 'getrorca', 'rorca', 'github-app-installation', $2, 1234, 5678)`, ['a'.repeat(40), bindingId]);
    await client.query(`INSERT INTO github_pr_delivery_evidence(run_id, workspace_id, head_sha, repo_owner, repo_name)
      VALUES (7, 'ws-upgrade', $1, 'getrorca', 'rorca')`, ['a'.repeat(40)]);

    expect((await client.query('SELECT filename FROM schema_migrations WHERE version = 20260720090000')).rowCount).toBe(1);
    await client.query(forward);
    await client.query(forward);

    const columns = await client.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'github_pr_delivery_evidence'
      AND column_name LIKE 'repository_%' ORDER BY column_name`, [schema]);
    expect(columns.rows.map(row => row.column_name)).toEqual([
      'repository_authority_source', 'repository_binding_id', 'repository_id', 'repository_installation_id',
    ]);
    const evidence = await client.query('SELECT * FROM github_pr_delivery_evidence WHERE run_id = 7');
    expect(evidence.rows[0]).toEqual(expect.objectContaining({
      repository_authority_source: 'github-app-installation',
      repository_binding_id: bindingId,
      repository_installation_id: '1234',
      repository_id: '5678',
    }));
    await expect(client.query(`UPDATE github_pr_delivery_evidence SET repository_id = 9999 WHERE run_id = 7`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(client.query(`INSERT INTO github_check_run_projections(projection_status, last_error_code)
      VALUES ('pending', NULL)`)).rejects.toMatchObject({ code: '23514' });
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
    await pool.end();
  }
});
