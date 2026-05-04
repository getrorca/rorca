/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import app from '../../server';
import { JWT_SECRET } from '../lib/auth-utils';
import { queryOne, execute } from '../../db/index';

// Helpers

async function createUser(overrides: { email?: string; displayName?: string } = {}) {
  const id = crypto.randomUUID();
  const email = overrides.email || `user-${id.slice(0, 8)}@test.com`;
  const displayName = overrides.displayName || 'Test User';
  const passwordHash = bcrypt.hashSync('password123', 4);
  await execute(`INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`, [id, email, displayName, passwordHash]);
  return { id, email, displayName };
}

function tokenFor(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '15m' });
}

async function createTeam(ownerId: string, overrides: { name?: string; slug?: string } = {}) {
  const id = crypto.randomUUID();
  const name = overrides.name || 'Test Team';
  const slug = overrides.slug || `team-${id.slice(0, 8)}`;
  await execute(`INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)`, [id, name, slug, ownerId]);
  await execute(`INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'admin', NOW(), NOW())`, [id, ownerId]);
  return { id, name, slug };
}

async function addMember(teamId: string, userId: string, role: 'admin' | 'editor' | 'viewer') {
  await execute(`INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, $3, NOW(), NOW())`, [teamId, userId, role]);
}

// Cleanup between tests
afterEach(async () => {
  await execute(`DELETE FROM team_invites`);
  await execute(`DELETE FROM team_members`);
  await execute(`DELETE FROM teams`);
  await execute(`DELETE FROM refresh_tokens`);
  await execute(`DELETE FROM users`);
});

describe('POST /api/teams', () => {
  it('creates a team and makes creator an admin member', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);

    const res = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'My Team', slug: 'my-team' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Team');
    expect(res.body.slug).toBe('my-team');
    expect(res.body.ownerId).toBe(owner.id);

    // Verify owner is admin member
    const member = await queryOne(`SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2`, [res.body.id, owner.id]) as { role: string };
    expect(member.role).toBe('admin');
  });

  it('rejects duplicate slugs', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);
    createTeam(owner.id, { slug: 'taken-slug' });

    const res = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Another Team', slug: 'taken-slug' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/slug already taken/i);
  });

  it('rejects invalid slug format', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);

    const res = await request(app)
      .post('/api/teams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Slug', slug: 'Has Spaces!' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lowercase alphanumeric/i);
  });

  it('without auth token uses local-admin fallback (auth globally bypassed)', async () => {
    // Auth middleware is intentionally bypassed for local single-user mode (see CLAUDE.md).
    // Without a Bearer token, the soft-auth middleware injects LOCAL_ADMIN (id: 'local-admin').
    // Since 'local-admin' is a synthetic user not in the users table, the INSERT fails
    // with a FK constraint violation (owner_id REFERENCES users(id)), resulting in 500.
    const res = await request(app)
      .post('/api/teams')
      .send({ name: 'No Auth', slug: 'no-auth' });

    // NOT 401 — auth is bypassed in local mode; 500 because local-admin isn't a real DB user
    expect(res.status).toBe(500);
  });
});

describe('POST /api/teams/:id/invites', () => {
  it('creates an invite with a valid token', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);
    const team = await createTeam(owner.id);

    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'invitee@example.com', role: 'editor' });

    expect(res.status).toBe(201);
    expect(res.body.email).toBe('invitee@example.com');
    expect(res.body.role).toBe('editor');
    expect(res.body.token).toBeTruthy();
    expect(res.body.teamName).toBe(team.name);
  });

  it('enforces max 3 pending invites on free tier', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);
    const team = await createTeam(owner.id);

    // Create 3 invites
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post(`/api/teams/${team.id}/invites`)
        .set('Authorization', `Bearer ${token}`)
        .send({ email: `user${i}@example.com` });
    }

    // 4th should fail
    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'user3@example.com' });

    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/maximum 3 pending invites/i);
  });

  it('rejects non-admin invites with 403', async () => {
    const owner = await createUser();
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, viewer.id, 'viewer');

    const token = tokenFor(viewer);
    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires admin role/i);
  });

  it('rejects editor invites with 403', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');

    const token = tokenFor(editor);
    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires admin role/i);
  });

  it('rejects duplicate pending invite for same email', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);
    const team = await createTeam(owner.id);

    await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'dup@example.com' });

    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'dup@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending invite already exists/i);
  });
});

describe('GET /api/invites/:token', () => {
  it('validates a token and returns team info', async () => {
    const owner = await createUser();
    const token = tokenFor(owner);
    const team = await createTeam(owner.id);

    const inviteRes = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'newuser@example.com', role: 'editor' });

    const rawToken = inviteRes.body.token;

    // Validate token (no auth required)
    const res = await request(app).get(`/api/invites/${rawToken}`);

    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(team.id);
    expect(res.body.teamName).toBe(team.name);
    expect(res.body.email).toBe('newuser@example.com');
    expect(res.body.role).toBe('editor');
  });

  it('returns 404 for invalid token', async () => {
    const res = await request(app).get('/api/invites/invalid-token-here');
    expect(res.status).toBe(404);
  });

  it('returns 410 for expired invite', async () => {
    const owner = await createUser();
    const authToken = tokenFor(owner);
    const team = await createTeam(owner.id);

    const inviteRes = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ email: 'expired@example.com' });

    // Manually expire the invite
    await execute(`UPDATE team_invites SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [inviteRes.body.inviteId]);

    const res = await request(app).get(`/api/invites/${inviteRes.body.token}`);
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });
});

describe('POST /api/invites/:token/accept', () => {
  it('accepts invite and adds user to team', async () => {
    const owner = await createUser();
    const invitee = await createUser({ email: 'invitee@example.com' });
    const team = await createTeam(owner.id);

    // Owner creates invite for invitee's email
    const inviteRes = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ email: invitee.email, role: 'editor' });

    const rawToken = inviteRes.body.token;

    // Invitee accepts
    const res = await request(app)
      .post(`/api/invites/${rawToken}/accept`)
      .set('Authorization', `Bearer ${tokenFor(invitee)}`);

    expect(res.status).toBe(200);
    expect(res.body.teamId).toBe(team.id);
    expect(res.body.role).toBe('editor');

    // Verify membership in DB
    const member = await queryOne(`SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, invitee.id]) as { role: string; accepted_at: string };
    expect(member.role).toBe('editor');
    expect(member.accepted_at).toBeTruthy();
  });

  it('rejects accept from wrong email', async () => {
    const owner = await createUser();
    const wrongUser = await createUser({ email: 'wrong@example.com' });
    const team = await createTeam(owner.id);

    const inviteRes = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ email: 'correct@example.com' });

    const res = await request(app)
      .post(`/api/invites/${inviteRes.body.token}/accept`)
      .set('Authorization', `Bearer ${tokenFor(wrongUser)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/different email/i);
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/invites/some-token/accept');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/teams/:id/members', () => {
  it('lists all members with roles and timestamps', async () => {
    const owner = await createUser({ displayName: 'Owner' });
    const member = await createUser({ email: 'member@test.com', displayName: 'Member' });
    const team = await createTeam(owner.id);

    await addMember(team.id, member.id, 'editor');

    const res = await request(app)
      .get(`/api/teams/${team.id}/members`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);

    const ownerMember = res.body.members.find((m: { userId: string }) => m.userId === owner.id);
    expect(ownerMember.role).toBe('admin');
    expect(ownerMember.lastActiveAt).toBeTruthy();

    const editorMember = res.body.members.find((m: { userId: string }) => m.userId === member.id);
    expect(editorMember.role).toBe('editor');
    expect(editorMember.displayName).toBe('Member');
  });

  it('allows viewers to list members', async () => {
    const owner = await createUser();
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, viewer.id, 'viewer');

    const res = await request(app)
      .get(`/api/teams/${team.id}/members`)
      .set('Authorization', `Bearer ${tokenFor(viewer)}`);

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
  });

  it('rejects non-members', async () => {
    const owner = await createUser();
    const outsider = await createUser({ email: 'outsider@test.com' });
    const team = await createTeam(owner.id);

    const res = await request(app)
      .get(`/api/teams/${team.id}/members`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`);

    expect(res.status).toBe(403);
  });
});

// ─── Role-based permission enforcement ───

describe('requireRole middleware', () => {
  it('returns 403 for non-team-members', async () => {
    const owner = await createUser();
    const outsider = await createUser({ email: 'outsider@test.com' });
    const team = await createTeam(owner.id);

    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(outsider)}`)
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You are not a member of this team');
  });

  it('viewers cannot send invites (requires admin)', async () => {
    const owner = await createUser();
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, viewer.id, 'viewer');

    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(viewer)}`)
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions: requires admin role');
  });

  it('editors cannot send invites (requires admin)', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');

    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(editor)}`)
      .send({ email: 'someone@example.com' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions: requires admin role');
  });

  it('admins can send invites', async () => {
    const owner = await createUser();
    const team = await createTeam(owner.id);

    const res = await request(app)
      .post(`/api/teams/${team.id}/invites`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ email: 'someone@example.com', role: 'editor' });

    expect(res.status).toBe(201);
  });

  it('role hierarchy: viewer < editor < admin', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');
    await addMember(team.id, viewer.id, 'viewer');

    // Viewer can read members (requires viewer)
    const viewRes = await request(app)
      .get(`/api/teams/${team.id}/members`)
      .set('Authorization', `Bearer ${tokenFor(viewer)}`);
    expect(viewRes.status).toBe(200);

    // Viewer cannot update settings (requires admin)
    const settingsRes = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(viewer)}`)
      .send({ name: 'Hacked' });
    expect(settingsRes.status).toBe(403);
    expect(settingsRes.body.error).toBe('Insufficient permissions: requires admin role');

    // Editor cannot update settings (requires admin)
    const editorSettingsRes = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(editor)}`)
      .send({ name: 'Hacked' });
    expect(editorSettingsRes.status).toBe(403);

    // Admin can update settings
    const adminSettingsRes = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ name: 'Updated Name' });
    expect(adminSettingsRes.status).toBe(200);
    expect(adminSettingsRes.body.name).toBe('Updated Name');
  });
});

describe('PATCH /api/teams/:id/members/:userId', () => {
  it('admin can change member role', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${editor.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ role: 'viewer' });

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('viewer');

    const member = await queryOne(`SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, editor.id]) as { role: string };
    expect(member.role).toBe('viewer');
  });

  it('editor cannot change member roles', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');
    await addMember(team.id, viewer.id, 'viewer');

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${viewer.id}`)
      .set('Authorization', `Bearer ${tokenFor(editor)}`)
      .send({ role: 'editor' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions: requires admin role');
  });

  it('rejects invalid role', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/${editor.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ role: 'superadmin' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid role/i);
  });

  it('returns 404 for non-existent member', async () => {
    const owner = await createUser();
    const team = await createTeam(owner.id);

    const res = await request(app)
      .patch(`/api/teams/${team.id}/members/non-existent-id`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ role: 'editor' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/teams/:id/members/:userId', () => {
  it('admin can remove a member', async () => {
    const owner = await createUser();
    const member = await createUser({ email: 'member@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, member.id, 'editor');

    const res = await request(app)
      .delete(`/api/teams/${team.id}/members/${member.id}`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const remaining = await queryOne(`SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2`, [team.id, member.id]);
    expect(remaining).toBeUndefined();
  });

  it('cannot remove the team owner', async () => {
    const owner = await createUser();
    const admin2 = await createUser({ email: 'admin2@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, admin2.id, 'admin');

    const res = await request(app)
      .delete(`/api/teams/${team.id}/members/${owner.id}`)
      .set('Authorization', `Bearer ${tokenFor(admin2)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot remove the team owner/i);
  });

  it('editor cannot remove members', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');
    await addMember(team.id, viewer.id, 'viewer');

    const res = await request(app)
      .delete(`/api/teams/${team.id}/members/${viewer.id}`)
      .set('Authorization', `Bearer ${tokenFor(editor)}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions: requires admin role');
  });
});

describe('PATCH /api/teams/:id/settings', () => {
  it('admin can update team name', async () => {
    const owner = await createUser();
    const team = await createTeam(owner.id);

    const res = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.slug).toBe(team.slug);
  });

  it('viewer cannot update team settings', async () => {
    const owner = await createUser();
    const viewer = await createUser({ email: 'viewer@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, viewer.id, 'viewer');

    const res = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(viewer)}`)
      .send({ name: 'Hacked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions: requires admin role');
  });

  it('editor cannot update team settings', async () => {
    const owner = await createUser();
    const editor = await createUser({ email: 'editor@test.com' });
    const team = await createTeam(owner.id);

    await addMember(team.id, editor.id, 'editor');

    const res = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(editor)}`)
      .send({ name: 'Hacked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Insufficient permissions: requires admin role');
  });

  it('rejects empty name', async () => {
    const owner = await createUser();
    const team = await createTeam(owner.id);

    const res = await request(app)
      .patch(`/api/teams/${team.id}/settings`)
      .set('Authorization', `Bearer ${tokenFor(owner)}`)
      .send({ name: '' });

    expect(res.status).toBe(400);
  });
});
