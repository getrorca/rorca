/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { resolveTestDatabaseUrl } from '../lib/test-db-safety';

const RUNTIME_DATABASE_URL = resolveTestDatabaseUrl();
const MIGRATION_DATABASE_URL = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!MIGRATION_DATABASE_URL) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');

const RUNTIME_ROLE = decodeURIComponent(new URL(RUNTIME_DATABASE_URL).username);
const SUFFIX = randomUUID();
const WORKSPACE_ONE = `ws-rls-user-1-${SUFFIX}`;
const WORKSPACE_TWO = `ws-rls-user-2-${SUFFIX}`;
const USER_ONE = randomUUID();
const USER_TWO = randomUUID();

let runtimePool: Pool;
let ownerPool: Pool;

async function setJwtClaims(client: PoolClient, sub: string | null, role: 'anon' | 'authenticated'): Promise<void> {
  const claims = sub
    ? JSON.stringify({ sub, role, aud: 'authenticated' })
    : JSON.stringify({ role: 'anon', aud: 'authenticated' });

  await client.query(
    'SELECT set_config($1, $2, true), set_config($3, $4, true)',
    ['request.jwt.claims', claims, 'request.jwt.claim.sub', sub ?? '']
  );
  await client.query(`SET LOCAL ROLE ${role}`);
}

type PolicyRow = {
  policyname: string;
  roles: string;
  cmd: string;
  permissive: string;
  qual: string | null;
  with_check: string | null;
};

describe('MU-010 workspaces RLS', () => {
  beforeAll(async () => {
    runtimePool = new Pool({
      connectionString: RUNTIME_DATABASE_URL,
      max: 5,
      options: '--search_path=rorca,public',
    });
    ownerPool = new Pool({
      connectionString: MIGRATION_DATABASE_URL,
      max: 1,
      options: '--search_path=rorca,public -c rorca.migration_mode=on',
    });

    await ownerPool.query(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        WORKSPACE_ONE, 'Workspace User 1', `/tmp/${WORKSPACE_ONE}`,
        WORKSPACE_TWO, 'Workspace User 2', `/tmp/${WORKSPACE_TWO}`,
      ]
    );
    await ownerPool.query(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2::uuid, 'owner'), ($3, $4::uuid, 'member')`,
      [WORKSPACE_ONE, USER_ONE, WORKSPACE_TWO, USER_TWO]
    );
  });

  afterAll(async () => {
    try {
      await ownerPool.query(
        'DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)',
        [WORKSPACE_ONE, WORKSPACE_TWO]
      );
      await ownerPool.query(
        'DELETE FROM workspaces WHERE id IN ($1, $2)',
        [WORKSPACE_ONE, WORKSPACE_TWO]
      );
    } finally {
      await runtimePool.end();
      await ownerPool.end();
    }
  });

  it('keeps runtime compatibility on the runtime identity without leaking it through request roles', async () => {
    const client = await runtimePool.connect();

    try {
      await client.query('BEGIN');

      const runtimeIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(runtimeIdentity.rows).toEqual([{
        current_user: RUNTIME_ROLE,
        session_user: RUNTIME_ROLE,
      }]);

      const runtimeResult = await client.query<{ id: string }>(
        'SELECT id FROM workspaces WHERE id IN ($1, $2) ORDER BY id',
        [WORKSPACE_ONE, WORKSPACE_TWO]
      );
      expect(runtimeResult.rows.map((row) => row.id)).toEqual([WORKSPACE_ONE, WORKSPACE_TWO].sort());

      await client.query('SAVEPOINT anonymous_read');
      await setJwtClaims(client, null, 'anon');
      const anonIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(anonIdentity.rows).toEqual([{
        current_user: 'anon',
        session_user: RUNTIME_ROLE,
      }]);
      await expect(
        client.query<{ id: string }>('SELECT id FROM rorca.workspaces ORDER BY id')
      ).rejects.toThrow(/permission denied/i);
      await client.query('ROLLBACK TO SAVEPOINT anonymous_read');

      await setJwtClaims(client, USER_ONE, 'authenticated');
      const authenticatedIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(authenticatedIdentity.rows).toEqual([{
        current_user: 'authenticated',
        session_user: RUNTIME_ROLE,
      }]);

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
      expect(userOneResult.rows.map((row) => row.id)).toEqual([WORKSPACE_ONE]);

      await setJwtClaims(client, USER_TWO, 'authenticated');
      const userTwoResult = await client.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
      expect(userTwoResult.rows.map((row) => row.id)).toEqual([WORKSPACE_TWO]);

      const policies = await client.query<PolicyRow>(
        `SELECT policyname, roles, cmd, permissive, qual, with_check
         FROM pg_policies
         WHERE schemaname = 'rorca' AND tablename = 'workspaces'
         ORDER BY policyname`
      );
      expect(policies.rows.map(({ policyname, roles }) => ({ policyname, roles }))).toEqual([
        { policyname: 'wave2_internal_runtime_legacy', roles: '{public}' },
        { policyname: 'workspace_delete_owner', roles: '{public}' },
        { policyname: 'workspace_insert_authenticated', roles: '{public}' },
        { policyname: 'workspace_select_own', roles: '{public}' },
        { policyname: 'workspace_update_admin', roles: '{public}' },
      ]);
      expect(policies.rows.find((row) => row.policyname === 'wave2_internal_runtime_legacy')).toEqual({
        policyname: 'wave2_internal_runtime_legacy',
        roles: '{public}',
        cmd: 'ALL',
        permissive: 'PERMISSIVE',
        qual: `(CURRENT_USER = '${RUNTIME_ROLE}'::name)`,
        with_check: `(CURRENT_USER = '${RUNTIME_ROLE}'::name)`,
      });

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
