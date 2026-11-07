/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { closePool, query, transaction } from '../../db/index';
import { resolveTestDatabaseUrl } from '../../lib/test-db-safety';

const RUNTIME_DATABASE_URL = resolveTestDatabaseUrl();
const MIGRATION_DATABASE_URL = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!MIGRATION_DATABASE_URL) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');

const RUNTIME_ROLE = decodeURIComponent(new URL(RUNTIME_DATABASE_URL).username);
const suffix = `${Date.now()}_${randomUUID()}`;
const ownerId = `vault_owner_${suffix}`;
const unrelatedId = `vault_unrelated_${suffix}`;
const ownerAuthId = randomUUID();
const unrelatedAuthId = randomUUID();
const vaultKeyId = `vault_${suffix}`;
const ownerPool = new Pool({
  connectionString: MIGRATION_DATABASE_URL,
  max: 1,
  options: '--search_path=rorca,public -c rorca.migration_mode=on',
});

async function setJwtClaims(client: PoolClient, authId: string | null, role: 'anon' | 'authenticated'): Promise<void> {
  await client.query(
    `SELECT set_config('request.jwt.claim.sub', $1, true),
            set_config('request.jwt.claims', $2, true)`,
    [
      authId ?? '',
      JSON.stringify(authId ? { sub: authId, role } : { role: 'anon' }),
    ]
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

describe('api_key_vault RLS policies', () => {
  beforeAll(async () => {
    await ownerPool.query(
      `INSERT INTO users (id, email, display_name, auth_id)
       VALUES
       ($1, $2, 'Vault Owner', $3),
       ($4, $5, 'Unrelated User', $6)`,
      [
        ownerId, `vault.owner.${suffix}@example.com`, ownerAuthId,
        unrelatedId, `vault.unrelated.${suffix}@example.com`, unrelatedAuthId,
      ]
    );
    await ownerPool.query(
      `INSERT INTO api_key_vault (id, user_id, provider, encrypted_key, label)
       VALUES ($1, $2, 'openai-compat', 'iv:tag:cipher', 'Owner key')`,
      [vaultKeyId, ownerId]
    );
  });

  afterAll(async () => {
    try {
      await ownerPool.query('DELETE FROM api_key_vault WHERE id = $1', [vaultKeyId]);
      await ownerPool.query('DELETE FROM users WHERE id IN ($1, $2)', [ownerId, unrelatedId]);
    } finally {
      try {
        await closePool();
      } finally {
        await ownerPool.end();
      }
    }
  });

  test('runtime compatibility does not leak through authenticated or anonymous request roles', async () => {
    const runtimeIdentity = await query<{ current_user: string; session_user: string }>(
      'SELECT current_user, session_user'
    );
    expect(runtimeIdentity).toEqual([{
      current_user: RUNTIME_ROLE,
      session_user: RUNTIME_ROLE,
    }]);
    const runtimeVisible = await query<{ id: string }>(
      'SELECT id FROM api_key_vault WHERE user_id = $1 AND id = $2',
      [ownerId, vaultKeyId]
    );
    expect(runtimeVisible).toEqual([{ id: vaultKeyId }]);

    await transaction(async (client) => {
      await setJwtClaims(client, null, 'anon');
      const anonIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(anonIdentity.rows).toEqual([{
        current_user: 'anon',
        session_user: RUNTIME_ROLE,
      }]);
      await expect(
        client.query('SELECT id FROM api_key_vault WHERE id = $1', [vaultKeyId])
      ).rejects.toThrow(/permission denied/i);
    });

    await transaction(async (client) => {
      await setJwtClaims(client, unrelatedAuthId, 'authenticated');
      const authenticatedIdentity = await client.query<{ current_user: string; session_user: string }>(
        'SELECT current_user, session_user'
      );
      expect(authenticatedIdentity.rows).toEqual([{
        current_user: 'authenticated',
        session_user: RUNTIME_ROLE,
      }]);

      const hidden = await client.query(
        'SELECT id FROM api_key_vault WHERE user_id = $1 AND id = $2',
        [ownerId, vaultKeyId]
      );
      expect(hidden.rows).toHaveLength(0);
    });

    await transaction(async (client) => {
      await setJwtClaims(client, ownerAuthId, 'authenticated');
      const visible = await client.query(
        'SELECT id FROM api_key_vault WHERE user_id = $1 AND id = $2',
        [ownerId, vaultKeyId]
      );
      expect(visible.rows).toEqual([{ id: vaultKeyId }]);
    });

    const policies = await ownerPool.query<PolicyRow>(
      `SELECT policyname, roles, cmd, permissive, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'rorca' AND tablename = 'api_key_vault'
       ORDER BY policyname`
    );
    expect(policies.rows.map(({ policyname }) => policyname)).toEqual([
      'api_key_vault_delete_owner',
      'api_key_vault_insert_owner',
      'api_key_vault_select_owner',
      'api_key_vault_update_owner',
      'provider_vault_runtime_read',
      'provider_vault_writer_mutation',
    ]);
    expect(policies.rows.find((row) => row.policyname === 'provider_vault_runtime_read')).toEqual({
      policyname: 'provider_vault_runtime_read',
      roles: `{${RUNTIME_ROLE}}`,
      cmd: 'SELECT',
      permissive: 'PERMISSIVE',
      qual: `(CURRENT_USER = '${RUNTIME_ROLE}'::name)`,
      with_check: null,
    });
    expect(policies.rows.find((row) => row.policyname === 'wave2_internal_runtime_legacy')).toBeUndefined();
  });
});
