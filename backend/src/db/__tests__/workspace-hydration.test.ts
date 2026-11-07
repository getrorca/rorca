/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type * as WorkspaceHydrationModule from '../workspace-hydration';
import type * as DatabaseModule from '../index';

const originalWorkspaceScope = Object.prototype.hasOwnProperty.call(
  process.env,
  'RORCA_TEST_DATABASE_WORKSPACE_SCOPE',
)
  ? { present: true as const, value: process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE! }
  : { present: false as const };
const workspaceId = `ws-hydration-${randomUUID()}`;
const foreignWorkspaceId = `ws-hydration-foreign-${randomUUID()}`;
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = workspaceId;

const {
  createHydration,
  deleteHydrationsForWorkspace,
  getHydrationById,
  getLatestHydration,
  listHydrations,
  markLatestHydrationStale,
  updateHydration,
} = require('../workspace-hydration') as typeof WorkspaceHydrationModule;
const { closePool } = require('../index') as typeof DatabaseModule;

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 2,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${workspaceId}`,
});

async function cleanupFixtures(): Promise<void> {
  await ownerPool.query('DELETE FROM workspaces WHERE id = ANY($1::text[])', [
    [workspaceId, foreignWorkspaceId],
  ]);
}

beforeEach(async () => {
  await cleanupFixtures();
  await ownerPool.query(
    `INSERT INTO workspaces (id, label, path)
     VALUES ($1, 'Hydration Workspace', $2),
            ($3, 'Foreign Hydration Workspace', $4)`,
    [workspaceId, `/tmp/${workspaceId}`, foreignWorkspaceId, `/tmp/${foreignWorkspaceId}`],
  );
});

afterEach(cleanupFixtures);

afterAll(async () => {
  try {
    await cleanupFixtures();
    await closePool();
    await ownerPool.end();
  } finally {
    if (originalWorkspaceScope.present) {
      process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = originalWorkspaceScope.value;
    } else {
      delete process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE;
    }
  }
});

describe('workspace hydration (US-003) DB helpers', () => {
  it('records the hydration schema columns the contract requires', async () => {
    const { rows } = await ownerPool.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'workspace_hydration'`,
    );
    const columns = new Set(rows.map((r: { column_name: string }) => r.column_name));
    for (const expected of [
      'workspace_id',
      'provider',
      'status',
      'git_sha',
      'graph_path',
      'counts_json',
      'duration_ms',
      'stale_reason',
      'error_json',
      'metadata_json',
      'created_at',
      'updated_at',
    ]) {
      expect(columns.has(expected)).toBe(true);
    }
  });

  it('does not create or touch any pgboss.* tables', async () => {
    const { rows } = await ownerPool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'pgboss' AND table_name = 'workspace_hydration'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('creates a pending hydration with sensible defaults', async () => {
    const created = await createHydration({ workspaceId, gitSha: 'abc123' });

    expect(created.id).toBeGreaterThan(0);
    expect(created.workspaceId).toBe(workspaceId);
    expect(created.provider).toBe('hilo');
    expect(created.status).toBe('pending');
    expect(created.gitSha).toBe('abc123');
    expect(created.counts).toEqual({});
    expect(created.metadata).toEqual({});
    expect(created.errorJson).toBeNull();
    expect(created.durationMs).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);

    const fetched = await getHydrationById(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('updates status, counts, duration, and graph output through the helper API', async () => {
    const created = await createHydration({
      workspaceId,
      status: 'running',
      gitSha: 'sha-running',
      startedAt: new Date(),
    });

    const updated = await updateHydration(created.id, {
      status: 'succeeded',
      graphPath: '/tmp/graph/ws-hydration.json',
      counts: { files: 12, edges: 30, imports: 18 },
      durationMs: 4200,
      finishedAt: new Date(),
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('succeeded');
    expect(updated?.graphPath).toBe('/tmp/graph/ws-hydration.json');
    expect(updated?.counts).toEqual({ files: 12, edges: 30, imports: 18 });
    expect(updated?.durationMs).toBe(4200);
    expect(updated?.finishedAt).toBeInstanceOf(Date);
    // updated_at must advance past created_at on update.
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it('returns the latest hydration and supports status-filtered latest lookups', async () => {
    await createHydration({ workspaceId, status: 'succeeded', gitSha: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    const failed = await createHydration({
      workspaceId,
      status: 'failed',
      gitSha: 'new',
      errorJson: { message: 'hilo exited non-zero', code: 2 },
    });

    const latest = await getLatestHydration(workspaceId);
    expect(latest?.id).toBe(failed.id);
    expect(latest?.status).toBe('failed');
    expect(latest?.errorJson).toEqual({ message: 'hilo exited non-zero', code: 2 });

    const latestSucceeded = await getLatestHydration(workspaceId, 'succeeded');
    expect(latestSucceeded?.gitSha).toBe('old');

    expect(await getLatestHydration(foreignWorkspaceId)).toBeNull();
  });

  it('marks the latest non-stale hydration stale with a reason', async () => {
    await createHydration({ workspaceId, status: 'succeeded', gitSha: 'stale-me' });

    const staled = await markLatestHydrationStale(workspaceId, 'git_sha_changed');
    expect(staled?.status).toBe('stale');
    expect(staled?.staleReason).toBe('git_sha_changed');

    // No non-stale rows remain, so a second call is a no-op.
    expect(await markLatestHydrationStale(workspaceId)).toBeNull();
  });

  it('lists hydration history newest-first with optional status filter and paging', async () => {
    for (const status of ['succeeded', 'failed', 'succeeded'] as const) {
      await createHydration({ workspaceId, status });
      await new Promise((r) => setTimeout(r, 2));
    }

    const all = await listHydrations(workspaceId);
    expect(all).toHaveLength(3);
    // newest first
    expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[2].createdAt.getTime());

    const succeeded = await listHydrations(workspaceId, { status: 'succeeded' });
    expect(succeeded).toHaveLength(2);

    const firstPage = await listHydrations(workspaceId, { limit: 1 });
    expect(firstPage).toHaveLength(1);
  });

  it('cascades hydration rows when explicitly deleted for a workspace', async () => {
    await createHydration({ workspaceId, status: 'succeeded' });
    await createHydration({ workspaceId, status: 'failed' });

    const removed = await deleteHydrationsForWorkspace(workspaceId);
    expect(removed).toBe(2);
    expect(await listHydrations(workspaceId)).toHaveLength(0);
  });

  it('denies cross-workspace hydration reads and writes at the runtime boundary', async () => {
    await ownerPool.query(
      `INSERT INTO workspace_hydration (workspace_id, status, git_sha)
       VALUES ($1, 'succeeded', 'foreign-sha')`,
      [foreignWorkspaceId],
    );

    expect(await getLatestHydration(foreignWorkspaceId)).toBeNull();
    await expect(createHydration({ workspaceId: foreignWorkspaceId }))
      .rejects.toMatchObject({ code: '42501' });
    const foreignRows = await ownerPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM workspace_hydration WHERE workspace_id = $1',
      [foreignWorkspaceId],
    );
    expect(foreignRows.rows[0].count).toBe('1');
  });

  it('rejects an invalid status at the DB CHECK constraint', async () => {
    await expect(
      ownerPool.query(
        `INSERT INTO workspace_hydration (workspace_id, status) VALUES ($1, $2)`,
        [workspaceId, 'not-a-status'],
      ),
    ).rejects.toThrow();
  });
});
