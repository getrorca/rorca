import { Pool, type PoolClient } from 'pg';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const USER_A = '33333333-3333-3333-3333-333333333333';
const USER_B = '44444444-4444-4444-4444-444444444444';

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

  it('prevents cross-workspace vault key reads and exposes only in-scope GitHub connections', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-vault-a', 'Workspace Vault A', '/tmp/ws-vault-a',
          'ws-vault-b', 'Workspace Vault B', '/tmp/ws-vault-b',
        ]
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES
           ($1, $2::uuid, 'owner'),
           ($3, $4::uuid, 'member')`,
        ['ws-vault-a', USER_A, 'ws-vault-b', USER_B]
      );

      await client.query(
        `INSERT INTO vault_keys (id, workspace_id, user_id, provider, encrypted_key, label)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['key-a', 'ws-vault-a', 'legacy-user-a', 'openrouter', 'iv:tag:ciphertext', 'Primary']
      );

      await client.query(
        `INSERT INTO github_connections (id, workspace_id, user_id, github_user_id, encrypted_token, scopes, github_username)
         VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
        [
          'gh-a', 'ws-vault-a', 'legacy-user-a', 'gh-user-a', 'enc-a', 'repo', 'alice',
          'gh-b', 'ws-vault-b', 'legacy-user-b', 'gh-user-b', 'enc-b', 'repo', 'bob',
        ]
      );

      await setJwtClaims(client, USER_B, 'authenticated');

      const vaultRows = await client.query<{ id: string }>('SELECT id FROM vault_keys ORDER BY id');
      expect(vaultRows.rows).toEqual([]);

      const githubRows = await client.query<{ id: string }>('SELECT id FROM github_connections ORDER BY id');
      expect(githubRows.rows.map((row) => row.id)).toEqual(['gh-b']);

      const policies = await client.query<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname
         FROM pg_policies
         WHERE schemaname = 'rorca'
           AND tablename IN ('vault_keys', 'github_connections')
         ORDER BY tablename, policyname`
      );

      expect(policies.rows).toEqual([
        { tablename: 'github_connections', policyname: 'github_connections_delete_workspace_member' },
        { tablename: 'github_connections', policyname: 'github_connections_insert_workspace_member' },
        { tablename: 'github_connections', policyname: 'github_connections_select_workspace_member' },
        { tablename: 'github_connections', policyname: 'github_connections_update_workspace_member' },
        { tablename: 'vault_keys', policyname: 'vault_keys_delete_workspace_admin' },
        { tablename: 'vault_keys', policyname: 'vault_keys_insert_workspace_admin' },
        { tablename: 'vault_keys', policyname: 'vault_keys_select_workspace_member' },
        { tablename: 'vault_keys', policyname: 'vault_keys_update_workspace_admin' },
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
