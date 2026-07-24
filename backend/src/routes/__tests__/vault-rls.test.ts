/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import { closePool, execute, query, transaction } from '../../db/index';

describe('api_key_vault RLS policies', () => {
  afterAll(async () => {
    await closePool();
  });

  test('an authenticated user cannot read another user vault key', async () => {
    const suffix = `${Date.now()}_${randomUUID()}`;
    const ownerId = `vault_owner_${suffix}`;
    const unrelatedId = `vault_unrelated_${suffix}`;
    const ownerAuthId = randomUUID();
    const unrelatedAuthId = randomUUID();
    const vaultKeyId = `vault_${suffix}`;

    await execute(
      `INSERT INTO users (id, email, display_name, auth_id)
       VALUES
       ($1, $2, 'Vault Owner', $3),
       ($4, $5, 'Unrelated User', $6)`,
      [
        ownerId, `vault.owner.${suffix}@example.com`, ownerAuthId,
        unrelatedId, `vault.unrelated.${suffix}@example.com`, unrelatedAuthId,
      ]
    );

    await execute(
      `INSERT INTO api_key_vault (id, user_id, provider, encrypted_key, label)
       VALUES ($1, $2, 'openai-compat', 'iv:tag:cipher', 'Owner key')`,
      [vaultKeyId, ownerId]
    );

    await transaction(async (client) => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [
          unrelatedAuthId,
          JSON.stringify({
            sub: unrelatedAuthId,
            email: `vault.unrelated.${suffix}@example.com`,
            role: 'authenticated',
          }),
        ]
      );

      const hidden = await client.query(
        'SELECT id FROM api_key_vault WHERE user_id = $1 AND id = $2',
        [ownerId, vaultKeyId]
      );
      expect(hidden.rows).toHaveLength(0);
    });

    await transaction(async (client) => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [
          ownerAuthId,
          JSON.stringify({
            sub: ownerAuthId,
            email: `vault.owner.${suffix}@example.com`,
            role: 'authenticated',
          }),
        ]
      );

      const visible = await client.query(
        'SELECT id FROM api_key_vault WHERE user_id = $1 AND id = $2',
        [ownerId, vaultKeyId]
      );
      expect(visible.rows).toEqual([{ id: vaultKeyId }]);
    });

    const policies = await query<{ policyname: string }>(
      `SELECT policyname
       FROM pg_policies
       WHERE schemaname = 'rorca' AND tablename = 'api_key_vault'
       ORDER BY policyname`
    );
    expect(policies.map((row) => row.policyname)).toEqual([
      'api_key_vault_delete_owner',
      'api_key_vault_insert_owner',
      'api_key_vault_select_owner',
      'api_key_vault_update_owner',
    ]);

    await execute('DELETE FROM api_key_vault WHERE id = $1', [vaultKeyId]);
    await execute('DELETE FROM users WHERE id IN ($1, $2)', [ownerId, unrelatedId]);
  });
});
