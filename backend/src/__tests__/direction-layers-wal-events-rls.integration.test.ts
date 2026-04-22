import { Pool, type PoolClient } from 'pg';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const ADMIN_USER = '33333333-3333-3333-3333-333333333333';
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

describe('MU-012 direction_layers and wal_events RLS', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 5 });
    const { runPgMigrations } = await import('../db/pg-index');
    await runPgMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('allows global direction layers to all authenticated users while hiding other workspace layers and wal events', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, role, auth_id)
         VALUES
         ($1, $2, $3, $4, 'user', $5::uuid),
         ($6, $7, $8, $9, 'user', $10::uuid),
         ($11, $12, $13, $14, 'admin', $15::uuid)`,
        [
          'user-rls-1', 'user1-rls@example.com', 'User One', 'hash', USER_ONE,
          'user-rls-2', 'user2-rls@example.com', 'User Two', 'hash', USER_TWO,
          'user-rls-admin', 'admin-rls@example.com', 'Admin User', 'hash', ADMIN_USER,
        ]
      );

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-rls-mu12-1', 'Workspace MU12 User 1', '/tmp/ws-rls-mu12-1',
          'ws-rls-mu12-2', 'Workspace MU12 User 2', '/tmp/ws-rls-mu12-2',
        ]
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES
         ($1, $2::uuid, 'owner'),
         ($3, $4::uuid, 'owner'),
         ($1, $5::uuid, 'admin')`,
        ['ws-rls-mu12-1', USER_ONE, 'ws-rls-mu12-2', USER_TWO, ADMIN_USER]
      );

      await client.query(
        `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
         VALUES
         (NULL, 'global-domain', 1, 'global-l1'),
         (NULL, 'global-domain', 2, 'global-l2'),
         ($1, NULL, 3, 'workspace-one-l3'),
         ($2, 'other-domain', 3, 'workspace-two-l3')`,
        ['ws-rls-mu12-1', 'ws-rls-mu12-2']
      );

      await client.query(
        `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
         VALUES
         ('story_started', $1, 'spec-1', 'US-001', '{}'::jsonb),
         ('story_started', $2, 'spec-2', 'US-002', '{}'::jsonb),
         ('generate', NULL, 'spec-global', NULL, '{}'::jsonb)`,
        ['ws-rls-mu12-1', 'ws-rls-mu12-2']
      );

      await setJwtClaims(client, USER_ONE, 'authenticated');

      const directionResult = await client.query<{ workspace_id: string | null; layer: number; content_yaml: string }>(
        `SELECT workspace_id, layer, content_yaml
         FROM direction_layers
         ORDER BY layer, content_yaml`
      );
      expect(directionResult.rows).toEqual([
        { workspace_id: null, layer: 1, content_yaml: 'global-l1' },
        { workspace_id: null, layer: 2, content_yaml: 'global-l2' },
        { workspace_id: 'ws-rls-mu12-1', layer: 3, content_yaml: 'workspace-one-l3' },
      ]);

      const walResult = await client.query<{ workspace_id: string; spec_id: string }>(
        `SELECT workspace_id, spec_id
         FROM wal_events
         ORDER BY spec_id`
      );
      expect(walResult.rows).toEqual([
        { workspace_id: 'ws-rls-mu12-1', spec_id: 'spec-1' },
      ]);

      await expect(
        client.query(
          `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
           VALUES (NULL, 'global-domain', 1, 'blocked-global-insert')`
        )
      ).rejects.toThrow(/row-level security/i);

      await expect(
        client.query(
          `INSERT INTO wal_events (event_type, workspace_id, spec_id, story_id, payload)
           VALUES ('story_passed', $1, 'spec-2', 'US-002', '{}'::jsonb)`,
          ['ws-rls-mu12-2']
        )
      ).rejects.toThrow(/row-level security/i);

      await setJwtClaims(client, ADMIN_USER, 'authenticated');
      await client.query(
        `INSERT INTO direction_layers (workspace_id, domain, layer, content_yaml)
         VALUES (NULL, 'admin-domain', 1, 'admin-global-insert')`
      );

      const adminGlobalResult = await client.query<{ content_yaml: string }>(
        `SELECT content_yaml
         FROM direction_layers
         WHERE workspace_id IS NULL
         ORDER BY content_yaml`
      );
      expect(adminGlobalResult.rows.map((row) => row.content_yaml)).toEqual([
        'admin-global-insert',
        'global-l1',
        'global-l2',
      ]);

      const directionPolicies = await client.query<{ policyname: string }>(
        `SELECT policyname
         FROM pg_policies
         WHERE schemaname = 'rorca' AND tablename = 'direction_layers'
         ORDER BY policyname`
      );
      expect(directionPolicies.rows.map((row) => row.policyname)).toEqual([
        'direction_layers_delete_workspace_member_or_admin_global',
        'direction_layers_insert_workspace_member_or_admin_global',
        'direction_layers_select_global_or_workspace_member',
        'direction_layers_update_workspace_member_or_admin_global',
      ]);

      const walPolicies = await client.query<{ policyname: string }>(
        `SELECT policyname
         FROM pg_policies
         WHERE schemaname = 'rorca' AND tablename = 'wal_events'
         ORDER BY policyname`
      );
      expect(walPolicies.rows.map((row) => row.policyname)).toEqual([
        'wal_events_insert_workspace_member',
        'wal_events_select_workspace_member',
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
