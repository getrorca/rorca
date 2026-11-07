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
const ADMIN_USER = randomUUID();
const USER_ONE = randomUUID();
const USER_TWO = randomUUID();
const ADMIN_ID = `user-rls-admin-${SUFFIX}`;
const USER_ONE_ID = `user-rls-1-${SUFFIX}`;
const USER_TWO_ID = `user-rls-2-${SUFFIX}`;
const WORKSPACE_ONE = `ws-rls-mu12-1-${SUFFIX}`;
const WORKSPACE_TWO = `ws-rls-mu12-2-${SUFFIX}`;
const GLOBAL_L1 = `global-l1-${SUFFIX}`;
const GLOBAL_L2 = `global-l2-${SUFFIX}`;
const WORKSPACE_ONE_L3 = `workspace-one-l3-${SUFFIX}`;
const WORKSPACE_TWO_L3 = `workspace-two-l3-${SUFFIX}`;
const ADMIN_GLOBAL = `admin-global-insert-${SUFFIX}`;
const SPEC_ONE = `spec-1-${SUFFIX}`;
const SPEC_TWO = `spec-2-${SUFFIX}`;
const SPEC_GLOBAL = `spec-global-${SUFFIX}`;

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

function expectPolicies(
  policies: PolicyRow[],
  expectedNames: string[],
): void {
  expect(policies.map(({ policyname, roles }) => ({ policyname, roles }))).toEqual(
    expectedNames.map((policyname) => ({ policyname, roles: '{public}' }))
  );
  expect(policies.find((row) => row.policyname === 'wave2_internal_runtime_legacy')).toEqual({
    policyname: 'wave2_internal_runtime_legacy',
    roles: '{public}',
    cmd: 'ALL',
    permissive: 'PERMISSIVE',
    qual: `(CURRENT_USER = '${RUNTIME_ROLE}'::name)`,
    with_check: `(CURRENT_USER = '${RUNTIME_ROLE}'::name)`,
  });
}

describe('MU-012 direction_layers and wal_events RLS', () => {
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
      `INSERT INTO users (id, email, display_name, password_hash, role, auth_id)
       VALUES
       ($1, $2, $3, $4, 'user', $5::uuid),
       ($6, $7, $8, $9, 'user', $10::uuid),
       ($11, $12, $13, $14, 'admin', $15::uuid)`,
      [
        USER_ONE_ID, `user1-rls-${SUFFIX}@example.com`, 'User One', 'hash', USER_ONE,
        USER_TWO_ID, `user2-rls-${SUFFIX}@example.com`, 'User Two', 'hash', USER_TWO,
        ADMIN_ID, `admin-rls-${SUFFIX}@example.com`, 'Admin User', 'hash', ADMIN_USER,
      ]
    );
    await ownerPool.query(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        WORKSPACE_ONE, 'Workspace MU12 User 1', `/tmp/${WORKSPACE_ONE}`,
        WORKSPACE_TWO, 'Workspace MU12 User 2', `/tmp/${WORKSPACE_TWO}`,
      ]
    );
    await ownerPool.query(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES
       ($1, $2::uuid, 'owner'),
       ($3, $4::uuid, 'owner'),
       ($1, $5::uuid, 'admin')`,
      [WORKSPACE_ONE, USER_ONE, WORKSPACE_TWO, USER_TWO, ADMIN_USER]
    );
    await ownerPool.query(
      `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
       VALUES
       (NULL, $1, 1, $2),
       (NULL, $1, 2, $3),
       ($4, NULL, 3, $5),
       ($6, $7, 3, $8)`,
      [
        `global-domain-${SUFFIX}`, GLOBAL_L1, GLOBAL_L2,
        WORKSPACE_ONE, WORKSPACE_ONE_L3,
        WORKSPACE_TWO, `other-domain-${SUFFIX}`, WORKSPACE_TWO_L3,
      ]
    );
    await ownerPool.query(
      `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
       VALUES
       ('story_started', $1, $2, 'US-001', '{}'::jsonb),
       ('story_started', $3, $4, 'US-002', '{}'::jsonb),
       ('generate', NULL, $5, NULL, '{}'::jsonb)`,
      [WORKSPACE_ONE, SPEC_ONE, WORKSPACE_TWO, SPEC_TWO, SPEC_GLOBAL]
    );
  });

  afterAll(async () => {
    try {
      await ownerPool.query(
        'DELETE FROM wal_events WHERE spec_id IN ($1, $2, $3)',
        [SPEC_ONE, SPEC_TWO, SPEC_GLOBAL]
      );
      await ownerPool.query(
        'DELETE FROM direction_layers WHERE content_yaml IN ($1, $2, $3, $4, $5)',
        [GLOBAL_L1, GLOBAL_L2, WORKSPACE_ONE_L3, WORKSPACE_TWO_L3, ADMIN_GLOBAL]
      );
      await ownerPool.query(
        'DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)',
        [WORKSPACE_ONE, WORKSPACE_TWO]
      );
      await ownerPool.query(
        'DELETE FROM workspaces WHERE id IN ($1, $2)',
        [WORKSPACE_ONE, WORKSPACE_TWO]
      );
      await ownerPool.query(
        'DELETE FROM users WHERE id IN ($1, $2, $3)',
        [USER_ONE_ID, USER_TWO_ID, ADMIN_ID]
      );
    } finally {
      await runtimePool.end();
      await ownerPool.end();
    }
  });

  it('keeps runtime compatibility on the runtime identity while enforcing authenticated workspace boundaries', async () => {
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

      const runtimeDirectionResult = await client.query<{ content_yaml: string }>(
        `SELECT content_yaml
         FROM direction_layers
         WHERE content_yaml IN ($1, $2, $3, $4)
         ORDER BY content_yaml`,
        [GLOBAL_L1, GLOBAL_L2, WORKSPACE_ONE_L3, WORKSPACE_TWO_L3]
      );
      expect(runtimeDirectionResult.rows.map((row) => row.content_yaml)).toEqual(
        [GLOBAL_L1, GLOBAL_L2, WORKSPACE_ONE_L3, WORKSPACE_TWO_L3].sort()
      );
      const runtimeWalResult = await client.query<{ spec_id: string }>(
        `SELECT spec_id
         FROM wal_events
         WHERE spec_id IN ($1, $2, $3)
         ORDER BY spec_id`,
        [SPEC_ONE, SPEC_TWO, SPEC_GLOBAL]
      );
      expect(runtimeWalResult.rows.map((row) => row.spec_id)).toEqual(
        [SPEC_ONE, SPEC_TWO, SPEC_GLOBAL].sort()
      );

      await client.query('SAVEPOINT anonymous_read');
      await setJwtClaims(client, null, 'anon');
      const anonIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(anonIdentity.rows).toEqual([{
        current_user: 'anon',
        session_user: RUNTIME_ROLE,
      }]);
      await expect(client.query('SELECT id FROM direction_layers')).rejects.toThrow(/permission denied/i);
      await client.query('ROLLBACK TO SAVEPOINT anonymous_read');

      await setJwtClaims(client, USER_ONE, 'authenticated');
      const authenticatedIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(authenticatedIdentity.rows).toEqual([{
        current_user: 'authenticated',
        session_user: RUNTIME_ROLE,
      }]);

      const directionResult = await client.query<{ workspace_id: string | null; layer: number; content_yaml: string }>(
        `SELECT workspace_id, layer, content_yaml
         FROM direction_layers
         WHERE content_yaml IN ($1, $2, $3, $4)
         ORDER BY layer, content_yaml`,
        [GLOBAL_L1, GLOBAL_L2, WORKSPACE_ONE_L3, WORKSPACE_TWO_L3]
      );
      expect(directionResult.rows).toEqual([
        { workspace_id: null, layer: 1, content_yaml: GLOBAL_L1 },
        { workspace_id: null, layer: 2, content_yaml: GLOBAL_L2 },
        { workspace_id: WORKSPACE_ONE, layer: 3, content_yaml: WORKSPACE_ONE_L3 },
      ]);

      const walResult = await client.query<{ workspace_id: string; spec_id: string }>(
        `SELECT workspace_id, spec_id
         FROM wal_events
         WHERE spec_id IN ($1, $2, $3)
         ORDER BY spec_id`,
        [SPEC_ONE, SPEC_TWO, SPEC_GLOBAL]
      );
      expect(walResult.rows).toEqual([
        { workspace_id: WORKSPACE_ONE, spec_id: SPEC_ONE },
      ]);

      await client.query('SAVEPOINT denied_global_insert');
      await expect(
        client.query(
          `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
           VALUES (NULL, $1, 1, $2)`,
          [`blocked-global-${SUFFIX}`, `blocked-global-insert-${SUFFIX}`]
        )
      ).rejects.toThrow(/row-level security/i);
      await client.query('ROLLBACK TO SAVEPOINT denied_global_insert');

      await client.query('SAVEPOINT denied_foreign_wal_insert');
      await expect(
        client.query(
          `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
           VALUES ('story_passed', $1, $2, 'US-002', '{}'::jsonb)`,
          [WORKSPACE_TWO, SPEC_TWO]
        )
      ).rejects.toThrow(/row-level security/i);
      await client.query('ROLLBACK TO SAVEPOINT denied_foreign_wal_insert');

      await setJwtClaims(client, ADMIN_USER, 'authenticated');
      await client.query(
        `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
         VALUES (NULL, $1, 1, $2)`,
        [`admin-domain-${SUFFIX}`, ADMIN_GLOBAL]
      );

      const adminGlobalResult = await client.query<{ content_yaml: string }>(
        `SELECT content_yaml
         FROM direction_layers
         WHERE content_yaml IN ($1, $2, $3)
         ORDER BY content_yaml`,
        [ADMIN_GLOBAL, GLOBAL_L1, GLOBAL_L2]
      );
      expect(adminGlobalResult.rows.map((row) => row.content_yaml)).toEqual([
        ADMIN_GLOBAL,
        GLOBAL_L1,
        GLOBAL_L2,
      ].sort());

      const directionPolicies = await client.query<PolicyRow>(
        `SELECT policyname, roles, cmd, permissive, qual, with_check
         FROM pg_policies
         WHERE schemaname = 'rorca' AND tablename = 'direction_layers'
         ORDER BY policyname`
      );
      expectPolicies(directionPolicies.rows, [
        'direction_layers_delete_workspace_member_or_admin_global',
        'direction_layers_insert_workspace_member_or_admin_global',
        'direction_layers_select_global_or_workspace_member',
        'direction_layers_update_workspace_member_or_admin_global',
        'wave2_internal_runtime_legacy',
      ]);

      const walPolicies = await client.query<PolicyRow>(
        `SELECT policyname, roles, cmd, permissive, qual, with_check
         FROM pg_policies
         WHERE schemaname = 'rorca' AND tablename = 'wal_events'
         ORDER BY policyname`
      );
      expectPolicies(walPolicies.rows, [
        'wal_events_insert_workspace_member',
        'wal_events_select_workspace_member',
        'wave2_internal_runtime_legacy',
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
