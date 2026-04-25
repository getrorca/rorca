import { randomUUID } from 'crypto';
import { closePool, execute, transaction } from '../../db/index';

describe('api_key_vault RLS policies', () => {
  afterAll(async () => {
    await closePool();
  });

  test('workspace B member cannot read workspace A vault key', async () => {
    const suffix = Date.now().toString();
    const workspaceA = `ws_vault_a_${suffix}`;
    const workspaceB = `ws_vault_b_${suffix}`;
    const ownerAId = `owner_a_${suffix}`;
    const ownerBId = `owner_b_${suffix}`;
    const memberBId = `member_b_${suffix}`;
    const ownerAAuthId = randomUUID();
    const ownerBAuthId = randomUUID();
    const memberBAuthId = randomUUID();
    const vaultKeyId = `vault_${suffix}`;

    await execute(
      `INSERT INTO users (id, email, display_name, auth_id)
       VALUES
       ($1, $2, 'Owner A', $3),
       ($4, $5, 'Owner B', $6),
       ($7, $8, 'Member B', $9)`,
      [
        ownerAId, `owner.a.${suffix}@example.com`, ownerAAuthId,
        ownerBId, `owner.b.${suffix}@example.com`, ownerBAuthId,
        memberBId, `member.b.${suffix}@example.com`, memberBAuthId,
      ]
    );

    await execute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'Vault A', $2), ($3, 'Vault B', $4)`,
      [workspaceA, `/tmp/${workspaceA}`, workspaceB, `/tmp/${workspaceB}`]
    );

    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES
       ($1, $2, 'owner'),
       ($3, $4, 'owner'),
       ($3, $5, 'member')`,
      [workspaceA, ownerAAuthId, workspaceB, ownerBAuthId, memberBAuthId]
    );

    await execute(
      `INSERT INTO api_key_vault (id, workspace_id, user_id, provider, encrypted_key, label)
       VALUES ($1, $2, $3, 'openai-compat', 'iv:tag:cipher', 'Workspace A key')`,
      [vaultKeyId, workspaceA, ownerAId]
    );

    await transaction(async (client) => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [
          memberBAuthId,
          JSON.stringify({ sub: memberBAuthId, email: `member.b.${suffix}@example.com`, role: 'authenticated' }),
        ]
      );

      const hidden = await client.query(
        'SELECT id FROM api_key_vault WHERE workspace_id = $1 AND id = $2',
        [workspaceA, vaultKeyId]
      );
      expect(hidden.rows).toHaveLength(0);
    });

    await transaction(async (client) => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [
          ownerAAuthId,
          JSON.stringify({ sub: ownerAAuthId, email: `owner.a.${suffix}@example.com`, role: 'authenticated' }),
        ]
      );

      const visible = await client.query(
        'SELECT id FROM api_key_vault WHERE workspace_id = $1 AND id = $2',
        [workspaceA, vaultKeyId]
      );
      expect(visible.rows).toHaveLength(1);
    });

    await execute('DELETE FROM api_key_vault WHERE id = $1', [vaultKeyId]);
    await execute('DELETE FROM workspace_members WHERE workspace_id IN ($1, $2)', [workspaceA, workspaceB]);
    await execute('DELETE FROM workspaces WHERE id IN ($1, $2)', [workspaceA, workspaceB]);
    await execute('DELETE FROM users WHERE id IN ($1, $2, $3)', [ownerAId, ownerBId, memberBId]);
  });
});
