import { Pool, type PoolClient } from 'pg';

const DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://rorca:rorca@localhost:5432/rorca_test';

const OWNER_AUTH_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_AUTH_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OTHER_AUTH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

let pool: Pool;

async function setJwtClaims(
  client: PoolClient,
  options: { sub: string | null; email?: string; role: 'anon' | 'authenticated' }
): Promise<void> {
  const claims = options.sub
    ? JSON.stringify({ sub: options.sub, email: options.email, role: options.role, aud: 'authenticated' })
    : JSON.stringify({ role: 'anon', aud: 'authenticated' });

  await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claims', claims]);
  await client.query(`SET LOCAL ROLE ${options.role}`);
}

describe('MU-013 teams RLS', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 5 });
    const { runPgMigrations } = await import('../db/pg-index');
    await runPgMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('scopes teams, team_members, and team_invites to the correct authenticated user', async () => {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path = rorca, public');

      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash, auth_id)
         VALUES
           ($1, $2, $3, 'x', $4::uuid),
           ($5, $6, $7, 'x', $8::uuid),
           ($9, $10, $11, 'x', $12::uuid)`,
        [
          'user-owner', 'owner@example.com', 'Owner', OWNER_AUTH_ID,
          'user-member', 'member@example.com', 'Member', MEMBER_AUTH_ID,
          'user-other', 'other@example.com', 'Other', OTHER_AUTH_ID,
        ]
      );

      await client.query(
        `INSERT INTO workspaces (id, label, path)
         VALUES ($1, $2, $3), ($4, $5, $6)`,
        [
          'ws-team-a', 'Workspace Team A', '/tmp/ws-team-a',
          'ws-team-b', 'Workspace Team B', '/tmp/ws-team-b',
        ]
      );

      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
         VALUES
           ($1, $2::uuid, 'owner'),
           ($1, $3::uuid, 'member'),
           ($4, $5::uuid, 'owner')`,
        ['ws-team-a', OWNER_AUTH_ID, MEMBER_AUTH_ID, 'ws-team-b', OTHER_AUTH_ID]
      );

      await client.query(
        `INSERT INTO teams (id, name, slug, owner_id, workspace_id)
         VALUES
           ($1, $2, $3, $4, $5),
           ($6, $7, $8, $9, $10)`,
        [
          'team-a', 'Team A', 'team-a', 'user-owner', 'ws-team-a',
          'team-b', 'Team B', 'team-b', 'user-other', 'ws-team-b',
        ]
      );

      await client.query(
        `INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at)
         VALUES
           ($1, $2, 'admin', NOW(), NOW()),
           ($1, $3, 'viewer', NOW(), NOW()),
           ($4, $5, 'admin', NOW(), NOW())`,
        ['team-a', 'user-owner', 'user-member', 'team-b', 'user-other']
      );

      await client.query(
        `INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at)
         VALUES
           ($1, $2, $3, $4, $5, 'editor', NOW() + INTERVAL '7 days'),
           ($6, $7, $8, $9, $10, 'viewer', NOW() + INTERVAL '7 days')`,
        [
          'invite-a', 'team-a', 'invitee-a@example.com', 'hash-invite-a', 'user-owner',
          'invite-b', 'team-b', 'invitee-b@example.com', 'hash-invite-b', 'user-other',
        ]
      );

      await setJwtClaims(client, { sub: OWNER_AUTH_ID, email: 'owner@example.com', role: 'authenticated' });
      const ownerTeams = await client.query<{ id: string }>('SELECT id FROM teams ORDER BY id');
      expect(ownerTeams.rows.map((row) => row.id)).toEqual(['team-a']);

      const ownerMembers = await client.query<{ user_id: string }>(
        "SELECT user_id FROM team_members WHERE team_id = 'team-a' ORDER BY user_id"
      );
      expect(ownerMembers.rows.map((row) => row.user_id)).toEqual(['user-member', 'user-owner']);

      const ownerInvites = await client.query<{ id: string }>('SELECT id FROM team_invites ORDER BY id');
      expect(ownerInvites.rows.map((row) => row.id)).toEqual(['invite-a']);

      await setJwtClaims(client, { sub: MEMBER_AUTH_ID, email: 'invitee-a@example.com', role: 'authenticated' });
      const memberTeams = await client.query<{ id: string }>('SELECT id FROM teams ORDER BY id');
      expect(memberTeams.rows.map((row) => row.id)).toEqual(['team-a']);

      const memberVisibleInvites = await client.query<{ id: string }>('SELECT id FROM team_invites ORDER BY id');
      expect(memberVisibleInvites.rows.map((row) => row.id)).toEqual(['invite-a']);

      await expect(
        client.query(
          `INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at)
           VALUES ('team-a', 'user-other', 'viewer', NOW(), NOW())`
        )
      ).rejects.toThrow(/row-level security/i);

      await setJwtClaims(client, { sub: OTHER_AUTH_ID, email: 'invitee-b@example.com', role: 'authenticated' });
      const otherInvites = await client.query<{ id: string }>('SELECT id FROM team_invites ORDER BY id');
      expect(otherInvites.rows.map((row) => row.id)).toEqual(['invite-b']);

      await setJwtClaims(client, { sub: MEMBER_AUTH_ID, email: 'invitee-a@example.com', role: 'authenticated' });
      const inviteForOtherUser = await client.query<{ id: string }>(
        "SELECT id FROM team_invites WHERE email = 'invitee-b@example.com'"
      );
      expect(inviteForOtherUser.rows).toEqual([]);

      const policies = await client.query<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname
         FROM pg_policies
         WHERE schemaname = 'rorca'
           AND tablename IN ('teams', 'team_members', 'team_invites')
         ORDER BY tablename, policyname`
      );
      expect(policies.rows).toEqual([
        { tablename: 'team_invites', policyname: 'team_invites_insert_workspace_admin' },
        { tablename: 'team_invites', policyname: 'team_invites_select_creator_or_invitee' },
        { tablename: 'team_members', policyname: 'team_members_insert_workspace_admin' },
        { tablename: 'team_members', policyname: 'team_members_select_same_workspace_member' },
        { tablename: 'teams', policyname: 'teams_select_workspace_member' },
      ]);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});
