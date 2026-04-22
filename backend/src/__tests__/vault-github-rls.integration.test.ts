import { Pool, type PoolClient } from 'pg';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

let pool: Pool;

async function setJwtClaims(client: PoolClient, sub: string | null, role: 'anon' | 'authenticated'): Promise<void> {
  const claims = sub
    ? JSON.stringify({ sub, role, aud: 'authenticated' })
    : JSON.stringify({ role: 'anon', aud: 'authenticated' });

  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
  await client.query(`SET LOCAL ROLE ${role}`);
}

describe('MU-014 vault_keys and github_connections RLS', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 5 });
    const { runPgMigrations } = await import('../db/pg-index');
    await runPgMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('blocks cross-workspace vault key reads and scopes github connections by workspace', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, role, auth_id)
         VALUES
         ($1, $2, $3, $4, 'user', $5::uuid),
         ($6, $7, $8, $9, 'user', $10::uuid)`,
        [
          'user-mu14-a', 'mu14-a@example.com', 'MU14 User A', 'hash', USER_A,
          'user-mu14-b', 'mu14-b@example.com', 'MU14 User B', 'hash', USER_B,
        ]
      );

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-mu14-a', 'Workspace MU14 A', '/tmp/ws-mu14-a',
          'ws-mu14-b', 'Workspace MU14 B', '/tmp/ws-mu14-b',
        ]
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES
         ($1, $2::uuid, 'owner'),
         ($3, $4::uuid, 'member')`,
        ['ws-mu14-a', USER_A, 'ws-mu14-b', USER_B]
      );

      await client.query(
        `INSERT INTO api_key_vault (id, user_id, workspace_id, provider, encrypted_key, label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['vault-a', 'user-mu14-a', 'ws-mu14-a', 'openai', 'deadbeef:cafebabe:0123', 'Workspace A Key']
      );

      await client.query(
        `INSERT INTO github_connections (id, user_id, workspace_id, github_user_id, encrypted_token, scopes, github_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
        [
          'gh-a', 'user-mu14-a', 'ws-mu14-a', 'gh-user-a', 'enc-token-a', 'repo', 'user-a',
          'gh-b', 'user-mu14-b', 'ws-mu14-b', 'gh-user-b', 'enc-token-b', 'repo', 'user-b',
        ]
      );

      await setJwtClaims(client, USER_B, 'authenticated');

      const crossWorkspaceVault = await client.query<{ id: string }>(
        `SELECT id FROM api_key_vault WHERE workspace_id = 'ws-mu14-a'`
      );
      expect(crossWorkspaceVault.rows).toEqual([]);

      const githubVisibleToB = await client.query<{ id: string; workspace_id: string }>(
        `SELECT id, workspace_id FROM github_connections ORDER BY id`
      );
      expect(githubVisibleToB.rows).toEqual([{ id: 'gh-b', workspace_id: 'ws-mu14-b' }]);

      await expect(
        client.query(
          `INSERT INTO api_key_vault (id, user_id, workspace_id, provider, encrypted_key, label)
           VALUES ('vault-b-illegal', 'user-mu14-b', 'ws-mu14-b', 'openai', 'x:y:z', 'Illegal Member Insert')`
        )
      ).rejects.toThrow(/row-level security/i);

      await setJwtClaims(client, USER_A, 'authenticated');

      const ownVault = await client.query<{ id: string; workspace_id: string }>(
        `SELECT id, workspace_id FROM api_key_vault ORDER BY id`
      );
      expect(ownVault.rows).toEqual([{ id: 'vault-a', workspace_id: 'ws-mu14-a' }]);

      const githubVisibleToA = await client.query<{ id: string; workspace_id: string }>(
        `SELECT id, workspace_id FROM github_connections ORDER BY id`
      );
      expect(githubVisibleToA.rows).toEqual([{ id: 'gh-a', workspace_id: 'ws-mu14-a' }]);

      const policies = await client.query<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname
         FROM pg_policies
         WHERE schemaname = 'rorca'
           AND tablename IN ('api_key_vault', 'github_connections')
         ORDER BY tablename, policyname`
      );
      expect(policies.rows).toEqual([
        { tablename: 'api_key_vault', policyname: 'vault_keys_delete_workspace_admin' },
        { tablename: 'api_key_vault', policyname: 'vault_keys_insert_workspace_admin' },
        { tablename: 'api_key_vault', policyname: 'vault_keys_select_workspace_member' },
        { tablename: 'api_key_vault', policyname: 'vault_keys_update_workspace_admin' },
        { tablename: 'github_connections', policyname: 'github_connections_workspace_member_all' },
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
