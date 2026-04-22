import { Pool, type PoolClient } from 'pg';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const ADMIN_USER = '11111111-1111-1111-1111-111111111111';
const MEMBER_USER = '22222222-2222-2222-2222-222222222222';
const OTHER_USER = '33333333-3333-3333-3333-333333333333';

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

  it('authenticated users can read global direction layers but not another workspace L3 layer, and wal_events stay workspace-scoped', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-mu012-a', 'Workspace A', '/tmp/ws-mu012-a',
          'ws-mu012-b', 'Workspace B', '/tmp/ws-mu012-b',
        ]
      );

      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, role, plan, auth_id, email_verified_at)
         VALUES
         ($1, $2, $3, $4, 'admin', 'pro', $5::uuid, NOW()),
         ($6, $7, $8, $9, 'user', 'pro', $10::uuid, NOW()),
         ($11, $12, $13, $14, 'user', 'pro', $15::uuid, NOW())`,
        [
          'user-admin', 'admin-mu012@rorca.local', 'Admin MU012', '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy', ADMIN_USER,
          'user-member', 'member-mu012@rorca.local', 'Member MU012', '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy', MEMBER_USER,
          'user-other', 'other-mu012@rorca.local', 'Other MU012', '$2b$10$BMXqmRMejhhifW5gs6Ju.eI.cxoG/k7iW5sGJ86Nb4WloLowY.qxy', OTHER_USER,
        ]
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES
         ($1, $2::uuid, 'owner'),
         ($1, $3::uuid, 'member'),
         ($4, $5::uuid, 'owner')`,
        ['ws-mu012-a', ADMIN_USER, MEMBER_USER, 'ws-mu012-b', OTHER_USER]
      );

      await client.query(
        `INSERT INTO direction_layers (workspace_id, layer, domain, content_yaml)
         VALUES
         (NULL, 1, '', 'global_l1: visible_to_all_authenticated'),
         (NULL, 2, 'saas', 'global_l2: visible_to_all_authenticated'),
         ('ws-mu012-a', 3, '', 'l3_a: visible_to_workspace_a'),
         ('ws-mu012-b', 3, '', 'l3_b: visible_to_workspace_b')`
      );

      await client.query(
        `INSERT INTO wal_events (event_type, workspace_id, payload)
         VALUES
         ('event-a', 'ws-mu012-a', '{"ok":true}'),
         ('event-b', 'ws-mu012-b', '{"ok":true}')`
      );

      await setJwtClaims(client, MEMBER_USER, 'authenticated');

      const directionRows = await client.query<{ layer: number; workspace_id: string | null; content_yaml: string }>(
        `SELECT layer, workspace_id, content_yaml
         FROM direction_layers
         ORDER BY layer ASC, workspace_id NULLS FIRST, content_yaml ASC`
      );

      expect(directionRows.rows).toEqual([
        { layer: 1, workspace_id: null, content_yaml: 'global_l1: visible_to_all_authenticated' },
        { layer: 2, workspace_id: null, content_yaml: 'global_l2: visible_to_all_authenticated' },
        { layer: 3, workspace_id: 'ws-mu012-a', content_yaml: 'l3_a: visible_to_workspace_a' },
      ]);

      const foreignL3 = await client.query(
        `SELECT 1
         FROM direction_layers
         WHERE workspace_id = 'ws-mu012-b' AND layer = 3`
      );
      expect(foreignL3.rows).toEqual([]);

      const walRows = await client.query<{ event_type: string }>(
        `SELECT event_type
         FROM wal_events
         ORDER BY event_type ASC`
      );
      expect(walRows.rows.map((row) => row.event_type)).toEqual(['event-a']);

      await expect(
        client.query(
          `INSERT INTO wal_events (event_type, workspace_id, payload)
           VALUES ('event-forbidden', 'ws-mu012-b', '{"blocked":true}')`
        )
      ).rejects.toThrow(/row-level security/i);

      await expect(
        client.query(
          `INSERT INTO direction_layers (workspace_id, layer, domain, content_yaml)
           VALUES (NULL, 1, '', 'should_fail_for_non_admin')`
        )
      ).rejects.toThrow(/row-level security/i);

      await setJwtClaims(client, ADMIN_USER, 'authenticated');
      await expect(
        client.query(
          `INSERT INTO direction_layers (workspace_id, layer, domain, content_yaml)
           VALUES (NULL, 1, '', 'allowed_for_admin')`
        )
      ).resolves.not.toThrow();

      const policies = await client.query<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname
         FROM pg_policies
         WHERE schemaname = 'rorca'
           AND tablename IN ('direction_layers', 'wal_events')
         ORDER BY tablename, policyname`
      );

      expect(policies.rows).toEqual([
        { tablename: 'direction_layers', policyname: 'direction_layers_delete_workspace_or_admin_global' },
        { tablename: 'direction_layers', policyname: 'direction_layers_insert_workspace_or_admin_global' },
        { tablename: 'direction_layers', policyname: 'direction_layers_select_global_or_workspace' },
        { tablename: 'direction_layers', policyname: 'direction_layers_update_workspace_or_admin_global' },
        { tablename: 'wal_events', policyname: 'wal_events_insert_workspace_member' },
        { tablename: 'wal_events', policyname: 'wal_events_select_workspace_member' },
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
