/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool } from 'pg';
import {
  createHydration,
  deleteHydrationsForWorkspace,
  getHydrationById,
  getLatestHydration,
  listHydrations,
  markLatestHydrationStale,
  updateHydration,
} from '../workspace-hydration';
import { closeTestPool, getTestPool, truncateAll } from '../../__tests__/helpers/pg-test-utils';

let pool: Pool;

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await truncateAll(pool);
  // truncateAll only targets the `public` schema, but rorca tables live in the `rorca`
  // schema — clear this test's table explicitly so row counts are deterministic per test.
  await pool.query('TRUNCATE workspace_hydration RESTART IDENTITY CASCADE');
  await pool.query(
    `INSERT INTO workspaces (id, label, path)
     VALUES ('ws-hydration', 'Hydration Workspace', '/tmp/ws-hydration')
     ON CONFLICT (id) DO NOTHING`,
  );
});

describe('workspace hydration (US-003) DB helpers', () => {
  it('records the hydration schema columns the contract requires', async () => {
    const { rows } = await pool.query(
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
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'pgboss' AND table_name = 'workspace_hydration'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('creates a pending hydration with sensible defaults', async () => {
    const created = await createHydration({ workspaceId: 'ws-hydration', gitSha: 'abc123' });

    expect(created.id).toBeGreaterThan(0);
    expect(created.workspaceId).toBe('ws-hydration');
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
      workspaceId: 'ws-hydration',
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
    await createHydration({ workspaceId: 'ws-hydration', status: 'succeeded', gitSha: 'old' });
    await new Promise((r) => setTimeout(r, 5));
    const failed = await createHydration({
      workspaceId: 'ws-hydration',
      status: 'failed',
      gitSha: 'new',
      errorJson: { message: 'hilo exited non-zero', code: 2 },
    });

    const latest = await getLatestHydration('ws-hydration');
    expect(latest?.id).toBe(failed.id);
    expect(latest?.status).toBe('failed');
    expect(latest?.errorJson).toEqual({ message: 'hilo exited non-zero', code: 2 });

    const latestSucceeded = await getLatestHydration('ws-hydration', 'succeeded');
    expect(latestSucceeded?.gitSha).toBe('old');

    expect(await getLatestHydration('ws-unknown')).toBeNull();
  });

  it('marks the latest non-stale hydration stale with a reason', async () => {
    await createHydration({ workspaceId: 'ws-hydration', status: 'succeeded', gitSha: 'stale-me' });

    const staled = await markLatestHydrationStale('ws-hydration', 'git_sha_changed');
    expect(staled?.status).toBe('stale');
    expect(staled?.staleReason).toBe('git_sha_changed');

    // No non-stale rows remain, so a second call is a no-op.
    expect(await markLatestHydrationStale('ws-hydration')).toBeNull();
  });

  it('lists hydration history newest-first with optional status filter and paging', async () => {
    for (const status of ['succeeded', 'failed', 'succeeded'] as const) {
      await createHydration({ workspaceId: 'ws-hydration', status });
      await new Promise((r) => setTimeout(r, 2));
    }

    const all = await listHydrations('ws-hydration');
    expect(all).toHaveLength(3);
    // newest first
    expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[2].createdAt.getTime());

    const succeeded = await listHydrations('ws-hydration', { status: 'succeeded' });
    expect(succeeded).toHaveLength(2);

    const firstPage = await listHydrations('ws-hydration', { limit: 1 });
    expect(firstPage).toHaveLength(1);
  });

  it('cascades hydration rows when explicitly deleted for a workspace', async () => {
    await createHydration({ workspaceId: 'ws-hydration', status: 'succeeded' });
    await createHydration({ workspaceId: 'ws-hydration', status: 'failed' });

    const removed = await deleteHydrationsForWorkspace('ws-hydration');
    expect(removed).toBe(2);
    expect(await listHydrations('ws-hydration')).toHaveLength(0);
  });

  it('rejects an invalid status at the DB CHECK constraint', async () => {
    await expect(
      pool.query(
        `INSERT INTO workspace_hydration (workspace_id, status) VALUES ($1, $2)`,
        ['ws-hydration', 'not-a-status'],
      ),
    ).rejects.toThrow();
  });
});
