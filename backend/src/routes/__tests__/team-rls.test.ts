import { randomUUID } from 'crypto';
import { execute, transaction, closePool } from '../../db/index';

describe('team RLS policies', () => {
  afterAll(async () => {
    await closePool();
  });

  test('user A cannot see invites sent to user B email', async () => {
    const suffix = Date.now().toString();
    const workspaceId = `ws_rls_${suffix}`;
    const teamId = `team_rls_${suffix}`;
    const ownerId = `owner_${suffix}`;
    const userAId = `user_a_${suffix}`;
    const userBId = `user_b_${suffix}`;
    const ownerAuthId = randomUUID();
    const userAAuthId = randomUUID();
    const userBAuthId = randomUUID();
    const inviteId = `invite_${suffix}`;

    await execute(
      `INSERT INTO users (id, email, display_name, auth_id)
       VALUES ($1, $2, 'Owner', $3), ($4, $5, 'User A', $6), ($7, $8, 'User B', $9)`,
      [ownerId, `owner.${suffix}@example.com`, ownerAuthId, userAId, `usera.${suffix}@example.com`, userAAuthId, userBId, `userb.${suffix}@example.com`, userBAuthId]
    );

    await execute(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, 'RLS Test Workspace', $2)`,
      [workspaceId, `/tmp/${workspaceId}`]
    );

    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
       VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [workspaceId, ownerAuthId, userAAuthId]
    );

    await execute(
      `INSERT INTO teams (id, name, slug, owner_id, workspace_id)
       VALUES ($1, 'RLS Team', $2, $3, $4)`,
      [teamId, `rls-team-${suffix}`, ownerId, workspaceId]
    );

    await execute(
      `INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at)
       VALUES ($1, $2, 'admin', NOW(), NOW()), ($1, $3, 'viewer', NOW(), NOW())`,
      [teamId, ownerId, userAId]
    );

    await execute(
      `INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'editor', NOW() + INTERVAL '7 days')`,
      [inviteId, teamId, `userb.${suffix}@example.com`, `hash_${suffix}`, ownerId]
    );

    await transaction(async (client) => {
      await client.query(`SET LOCAL ROLE authenticated`);
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userAAuthId, JSON.stringify({ sub: userAAuthId, email: `usera.${suffix}@example.com`, role: 'authenticated' })]
      );

      const invisible = await client.query(`SELECT id FROM team_invites WHERE id = $1`, [inviteId]);
      expect(invisible.rows).toHaveLength(0);
    });

    await transaction(async (client) => {
      await client.query(`SET LOCAL ROLE authenticated`);
      await client.query(
        `SELECT set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [userBAuthId, JSON.stringify({ sub: userBAuthId, email: `userb.${suffix}@example.com`, role: 'authenticated' })]
      );

      const visible = await client.query(`SELECT id FROM team_invites WHERE id = $1`, [inviteId]);
      expect(visible.rows).toHaveLength(1);
    });

    await execute(`DELETE FROM team_invites WHERE id = $1`, [inviteId]);
    await execute(`DELETE FROM team_members WHERE team_id = $1`, [teamId]);
    await execute(`DELETE FROM teams WHERE id = $1`, [teamId]);
    await execute(`DELETE FROM workspace_members WHERE workspace_id = $1`, [workspaceId]);
    await execute(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);
    await execute(`DELETE FROM users WHERE id IN ($1, $2, $3)`, [ownerId, userAId, userBId]);
  });
});
