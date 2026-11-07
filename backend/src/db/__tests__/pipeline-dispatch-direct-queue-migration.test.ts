/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkDuplicatePrefixes, createPoolForConnectionString, runPgMigrations } from '../pg-index';

const migrationDirectory = path.join(__dirname, '..', 'pg-migrations');
const migrationFile = '20260818113000_pipeline_dispatch_direct_queue.sql';
const migrationSql = fs.readFileSync(path.join(migrationDirectory, migrationFile), 'utf8');

describe('pipeline dispatch direct transport queue migration', () => {
  test('uses a unique additive migration and never rewrites publication rows', () => {
    const files = fs.readdirSync(migrationDirectory).filter((file) => file.endsWith('.sql'));
    expect(() => checkDuplicatePrefixes(files)).not.toThrow();
    expect(migrationSql).toContain("CHECK (queue_name IN ('pipeline:run', 'pipeline:run:direct'))");
    expect(migrationSql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/i);
    expect(migrationSql).not.toContain('pgboss');
  });

  test('replays over a populated publication without changing its queue or job identity', async () => {
    const migrationUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
    if (!migrationUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
    const owner = createPoolForConnectionString(migrationUrl);
    const suffix = randomUUID();
    const workspaceId = `dispatch-lane:${suffix}`;
    let runId: string | undefined;
    try {
      await owner.query(
        `INSERT INTO rorca.workspaces (id, label, path) VALUES ($1, 'Dispatch lane migration', $2)`,
        [workspaceId, `/tmp/${workspaceId}`],
      );
      runId = (await owner.query<{ id: string }>(
        `INSERT INTO rorca.pipeline_runs (spec_path, workspace_id, status)
         VALUES ('dispatch-lane.json', $1, 'queued') RETURNING id::text`,
        [workspaceId],
      )).rows[0].id;
      const before = (await owner.query<{ queue_name: string; boss_job_id: string }>(
        `SELECT queue_name, boss_job_id::text FROM rorca.pipeline_dispatch_publications WHERE run_id = $1`,
        [runId],
      )).rows[0];

      await owner.query('DELETE FROM public.schema_migrations WHERE version = $1', [20260818113000]);
      await runPgMigrations(owner);

      const after = (await owner.query<{ queue_name: string; boss_job_id: string }>(
        `SELECT queue_name, boss_job_id::text FROM rorca.pipeline_dispatch_publications WHERE run_id = $1`,
        [runId],
      )).rows[0];
      expect(after).toEqual(before);
      await expect(owner.query(
        `UPDATE rorca.pipeline_dispatch_publications SET queue_name = 'pipeline:run:direct' WHERE run_id = $1`,
        [runId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(owner.query(
        `UPDATE rorca.pipeline_dispatch_publications SET queue_name = 'pipeline:unknown' WHERE run_id = $1`,
        [runId],
      )).rejects.toThrow();
    } finally {
      if (runId) await owner.query('DELETE FROM rorca.pipeline_runs WHERE id = $1', [runId]);
      await owner.query('DELETE FROM rorca.workspaces WHERE id = $1', [workspaceId]);
      await owner.end();
    }
  });
});
