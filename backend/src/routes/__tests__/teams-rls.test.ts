import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { execute, queryOne } from '../../db/index';

async function createUser(params: { email: string; authId: string }) {
  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id) VALUES ($1, $2, $3, $4, $5)`,
    [id, params.email, params.email.split('@')[0], 'hash', params.authId]
  );
  return { id, ...params };
}

async function createWorkspace() {
  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [id, 'RLS Workspace', `/tmp/${id}`]
  );
  return { id };
}

async function createTeam(ownerId: string) {
  const id = crypto.randomUUID();
  await execute(
    `INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`,
    [id, 'RLS Team', `rls-team-${id.slice(0, 8)}`, ownerId]
  );
  return { id };
}

async function asAuthenticatedUser<T>(
  authId: string,
  email: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();

  try {
    await client.query('SET search_path TO rorca, public');
    await client.query(`SET ROLE authenticated`);
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`,
      [authId, JSON.stringify({ sub: authId, email })]
    );
    return await fn(client);
  } finally {
    try {
      await client.query('RESET ROLE');
    } catch {
      // ignore cleanup failures
    }
    client.release();
    await pool.end();
  }
}

describe('team RLS policies', () => {
  it('prevents user A from seeing invites sent to user B email', async () => {
    const owner = await createUser({ email: 'owner@example.com', authId: crypto.randomUUID() });
    const inviteeA = await createUser({ email: 'alpha@example.com', authId: crypto.randomUUID() });
    const inviteeB = await createUser({ email: 'bravo@example.com', authId: crypto.randomUUID() });

    const workspace = await createWorkspace();
    const team = await createTeam(owner.id);

    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role) VALUES ($1, $2, 'owner')`,
      [workspace.id, owner.authId]
    );
    await execute(
      `INSERT INTO workspace_access (workspace_id, team_id, permission) VALUES ($1, $2, 'admin')`,
      [workspace.id, team.id]
    );
    await execute(
      `INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'admin', NOW(), NOW())`,
      [team.id, owner.id]
    );

    const inviteId = crypto.randomUUID();
    await execute(
      `INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')`,
      [inviteId, team.id, inviteeB.email, crypto.randomBytes(16).toString('hex'), owner.id, 'editor']
    );

    const ownerVisible = await asAuthenticatedUser(owner.authId, owner.email, async (client) => {
      const res = await client.query<{ count: string }>('SELECT COUNT(*)::int::text AS count FROM team_invites WHERE id = $1', [inviteId]);
      return Number(res.rows[0]?.count ?? '0');
    });

    const inviteeBVisible = await asAuthenticatedUser(inviteeB.authId, inviteeB.email, async (client) => {
      const res = await client.query<{ count: string }>('SELECT COUNT(*)::int::text AS count FROM team_invites WHERE id = $1', [inviteId]);
      return Number(res.rows[0]?.count ?? '0');
    });

    const inviteeAVisible = await asAuthenticatedUser(inviteeA.authId, inviteeA.email, async (client) => {
      const res = await client.query<{ count: string }>('SELECT COUNT(*)::int::text AS count FROM team_invites WHERE id = $1', [inviteId]);
      return Number(res.rows[0]?.count ?? '0');
    });

    expect(ownerVisible).toBe(1);
    expect(inviteeBVisible).toBe(1);
    expect(inviteeAVisible).toBe(0);
  });

  it('allows only workspace admin or owner to insert team members and invites', async () => {
    const owner = await createUser({ email: 'owner2@example.com', authId: crypto.randomUUID() });
    const editor = await createUser({ email: 'editor@example.com', authId: crypto.randomUUID() });
    const target = await createUser({ email: 'target@example.com', authId: crypto.randomUUID() });

    const workspace = await createWorkspace();
    const team = await createTeam(owner.id);

    await execute(
      `INSERT INTO workspace_members (workspace_id, user_auth_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'member')`,
      [workspace.id, owner.authId, editor.authId]
    );
    await execute(
      `INSERT INTO workspace_access (workspace_id, team_id, permission) VALUES ($1, $2, 'admin')`,
      [workspace.id, team.id]
    );
    await execute(
      `INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'admin', NOW(), NOW())`,
      [team.id, owner.id]
    );

    const insertedByOwner = await asAuthenticatedUser(owner.authId, owner.email, async (client) => {
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'viewer', NOW(), NOW())`,
        [team.id, target.id]
      );
      await client.query(
        `INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')`,
        [crypto.randomUUID(), team.id, 'newperson@example.com', crypto.randomBytes(16).toString('hex'), owner.id, 'editor']
      );
      return true;
    });

    expect(insertedByOwner).toBe(true);

    await expect(
      asAuthenticatedUser(editor.authId, editor.email, async (client) => {
        await client.query(
          `INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')`,
          [crypto.randomUUID(), team.id, 'blocked@example.com', crypto.randomBytes(16).toString('hex'), editor.id, 'editor']
        );
      })
    ).rejects.toThrow(/row-level security|permission denied/i);

    const member = await queryOne<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [team.id, target.id]
    );
    expect(member?.role).toBe('viewer');
  });
});
