import { getPool, queryOne } from '../../db/index';

describe('vault RLS', () => {
  test('workspace B member cannot read workspace A vault key', async () => {
    const ownerAuthId = '11111111-1111-4111-8111-111111111111';
    const memberAuthId = '22222222-2222-4222-8222-222222222222';
    const ownerUserId = 'user-owner';
    const memberUserId = 'user-member';
    const workspaceA = 'ws-a';
    const workspaceB = 'ws-b';

    await getPool().query(`
      INSERT INTO users (id, email, auth_id)
      VALUES ($1, 'owner@example.com', $2), ($3, 'member@example.com', $4)
      ON CONFLICT (id) DO NOTHING
    `, [ownerUserId, ownerAuthId, memberUserId, memberAuthId]);

    await getPool().query(`
      INSERT INTO workspaces (id, label, path)
      VALUES ($1, 'Workspace A', '/tmp/ws-a'), ($2, 'Workspace B', '/tmp/ws-b')
      ON CONFLICT (id) DO NOTHING
    `, [workspaceA, workspaceB]);

    await getPool().query(`
      INSERT INTO workspace_members (workspace_id, user_auth_id, role)
      VALUES ($1, $2, 'owner'), ($3, $4, 'member')
      ON CONFLICT (workspace_id, user_auth_id) DO NOTHING
    `, [workspaceA, ownerAuthId, workspaceB, memberAuthId]);

    await getPool().query(`
      INSERT INTO api_key_vault (id, workspace_id, user_id, provider, encrypted_key, label)
      VALUES ('vault-a', $1, $2, 'anthropic', 'iv:tag:cipher', 'Secret A')
      ON CONFLICT (id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, user_id = EXCLUDED.user_id
    `, [workspaceA, ownerUserId]);

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [memberAuthId]);
      await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
      await client.query('SET LOCAL ROLE authenticated');

      const result = await client.query(
        'SELECT id FROM api_key_vault WHERE workspace_id = $1',
        [workspaceA]
      );

      expect(result.rows).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
