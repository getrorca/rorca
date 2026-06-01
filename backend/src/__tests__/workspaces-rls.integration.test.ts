/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Pool, type PoolClient } from 'pg';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const USER_ONE = '11111111-1111-1111-1111-111111111111';
const USER_TWO = '22222222-2222-2222-2222-222222222222';

let pool: Pool;

async function setJwtClaims(client: PoolClient, sub: string | null, role: 'anon' | 'authenticated'): Promise<void> {
  const claims = sub
    ? JSON.stringify({ sub, role, aud: 'authenticated' })
    : JSON.stringify({ role: 'anon', aud: 'authenticated' });

  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
  await client.query(`SET LOCAL ROLE ${role}`);
}

describe('MU-010 workspaces RLS', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 5 });
    const { runPgMigrations } = await import('../db/pg-index');
    await runPgMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('anon sees zero rows, authenticated user sees only own workspaces, service context sees all rows', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-rls-user-1', 'Workspace User 1', '/tmp/ws-rls-user-1',
          'ws-rls-user-2', 'Workspace User 2', '/tmp/ws-rls-user-2',
        ]
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'member')`,
        ['ws-rls-user-1', USER_ONE, 'ws-rls-user-2', USER_TWO]
      );

      await setJwtClaims(client, null, 'anon');
      const anonResult = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      expect(anonResult.rows).toEqual([]);

      await setJwtClaims(client, USER_ONE, 'authenticated');
      const grantsResult = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type
         FROM information_schema.role_table_grants
         WHERE table_schema = 'rorca'
           AND table_name = 'workspaces'
           AND grantee = 'authenticated'
         ORDER BY privilege_type`
      );
      expect(grantsResult.rows.map((row) => row.privilege_type)).toEqual([
        'DELETE',
        'INSERT',
        'SELECT',
        'UPDATE',
      ]);

      const userOneResult = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      expect(userOneResult.rows.map((row) => row.id)).toEqual(['ws-rls-user-1']);

      await setJwtClaims(client, USER_TWO, 'authenticated');
      const userTwoResult = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      expect(userTwoResult.rows.map((row) => row.id)).toEqual(['ws-rls-user-2']);

      await client.query('RESET role');
      await client.query("SELECT set_config('request.jwt.claims', '', true)");
      const serviceResult = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      expect(serviceResult.rows.map((row) => row.id)).toEqual(['ws-rls-user-1', 'ws-rls-user-2']);

      const policies = await client.query<{ policyname: string }>(
        `SELECT policyname
         FROM pg_policies
         WHERE schemaname = 'rorca' AND tablename = 'workspaces'
         ORDER BY policyname`
      );
      expect(policies.rows.map((row) => row.policyname)).toEqual([
        'workspace_delete_owner',
        'workspace_insert_authenticated',
        'workspace_select_own',
        'workspace_update_admin',
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
