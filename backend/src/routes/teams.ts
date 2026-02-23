import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import type { AuthUser } from './auth';
import { requireRole } from './auth';
import { validateDirectionYaml } from '../lib/direction-validator';
import { synthesize } from '../lib/direction-stack';

const router = Router();

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PENDING_INVITES_FREE = 3;
const INVITE_EXPIRY_DAYS = 7;

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

interface TeamMemberRow {
  team_id: string;
  user_id: string;
  role: string;
  invited_at: string;
  accepted_at: string | null;
  last_active_at: string | null;
}

interface TeamInviteRow {
  id: string;
  team_id: string;
  email: string;
  token_hash: string;
  invited_by: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

function getAuthUser(req: Request): AuthUser {
  return (req as Request & { user: AuthUser }).user;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function emitWalEvent(eventType: string, payload: Record<string, unknown>): void {
  const result = db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES (?, '', ?)"
  ).run(eventType, JSON.stringify(payload));
  const walEvent: WalEvent = {
    id: result.lastInsertRowid as number,
    ts: new Date().toISOString(),
    event_type: eventType,
    workspace_id: null,
    spec_id: null,
    story_id: null,
    actor: '',
    payload: JSON.stringify(payload),
  };
  broadcastAll(walEvent);
}

// GET /api/teams — List teams the authenticated user belongs to
router.get('/', (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const rows = db.prepare(`
      SELECT t.id, t.name, t.slug, t.owner_id AS ownerId, t.created_at AS createdAt, tm.role
      FROM teams t
      JOIN team_members tm ON t.id = tm.team_id
      WHERE tm.user_id = ?
      ORDER BY t.name ASC
    `).all(user.id) as Array<{
      id: string;
      name: string;
      slug: string;
      ownerId: string;
      createdAt: string;
      role: string;
    }>;

    res.json(rows);
  } catch (error: unknown) {
    console.error('[Teams] list error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/teams — Create a new team
router.post('/', (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const { name, slug } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Team name is required' });
      return;
    }
    if (!slug || typeof slug !== 'string') {
      res.status(400).json({ error: 'Team slug is required' });
      return;
    }

    const trimmedSlug = slug.trim().toLowerCase();
    if (!SLUG_REGEX.test(trimmedSlug)) {
      res.status(400).json({ error: 'Slug must be lowercase alphanumeric with hyphens (e.g. my-team)' });
      return;
    }

    // Check slug uniqueness
    const existing = db.prepare('SELECT id FROM teams WHERE slug = ?').get(trimmedSlug) as TeamRow | undefined;
    if (existing) {
      res.status(409).json({ error: 'Team slug already taken' });
      return;
    }

    const teamId = crypto.randomUUID();
    const trimmedName = name.trim();

    // Create team
    db.prepare(
      'INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)'
    ).run(teamId, trimmedName, trimmedSlug, user.id);

    // Add owner as admin member
    db.prepare(
      "INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES (?, ?, 'admin', datetime('now'), datetime('now'))"
    ).run(teamId, user.id);

    emitWalEvent('team_created', { teamId, name: trimmedName, slug: trimmedSlug, ownerId: user.id });

    res.status(201).json({
      id: teamId,
      name: trimmedName,
      slug: trimmedSlug,
      ownerId: user.id,
      createdAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    console.error('[Teams] create error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/teams/:id/invites — Send an email invitation (admin only)
router.post('/:id/invites', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const teamId = req.params.id;
    const { email, role } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    const inviteRole = role && ['admin', 'editor', 'viewer'].includes(role) ? role : 'editor';

    // Verify team exists
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    // Check if email is already a member
    const existingMember = db.prepare(
      'SELECT tm.* FROM team_members tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id = ? AND u.email = ?'
    ).get(teamId, trimmedEmail) as TeamMemberRow | undefined;
    if (existingMember) {
      res.status(409).json({ error: 'User is already a team member' });
      return;
    }

    // Check pending invite limit (free tier: max 3)
    const pendingCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM team_invites WHERE team_id = ? AND accepted_at IS NULL AND expires_at > datetime(\'now\')'
    ).get(teamId) as { cnt: number };
    if (pendingCount.cnt >= MAX_PENDING_INVITES_FREE) {
      res.status(429).json({ error: `Free tier limit: maximum ${MAX_PENDING_INVITES_FREE} pending invites at a time` });
      return;
    }

    // Check for existing pending invite to same email
    const existingInvite = db.prepare(
      "SELECT id FROM team_invites WHERE team_id = ? AND email = ? AND accepted_at IS NULL AND expires_at > datetime('now')"
    ).get(teamId, trimmedEmail) as TeamInviteRow | undefined;
    if (existingInvite) {
      res.status(409).json({ error: 'A pending invite already exists for this email' });
      return;
    }

    // Generate signed invite token
    const rawToken = generateInviteToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const inviteId = crypto.randomUUID();

    db.prepare(
      'INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(inviteId, teamId, trimmedEmail, tokenHash, user.id, inviteRole, expiresAt);

    emitWalEvent('team_invite_sent', { teamId, inviteId, email: trimmedEmail, role: inviteRole, invitedBy: user.id });

    res.status(201).json({
      inviteId,
      email: trimmedEmail,
      role: inviteRole,
      token: rawToken,
      expiresAt,
      teamName: team.name,
    });
  } catch (error: unknown) {
    console.error('[Teams] invite error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/teams/:id/members — List team members (any member can view)
router.get('/:id/members', requireRole('viewer'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const members = db.prepare(`
      SELECT
        tm.user_id AS userId,
        u.email,
        u.display_name AS displayName,
        tm.role,
        tm.invited_at AS joinedAt,
        tm.accepted_at AS acceptedAt,
        tm.last_active_at AS lastActiveAt
      FROM team_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = ?
      ORDER BY tm.invited_at ASC
    `).all(teamId) as Array<{
      userId: string;
      email: string;
      displayName: string;
      role: string;
      joinedAt: string;
      acceptedAt: string | null;
      lastActiveAt: string | null;
    }>;

    res.json({ teamId, teamName: team.name, members });
  } catch (error: unknown) {
    console.error('[Teams] members error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /api/teams/:id/members/:userId — Update a member's role (admin only)
router.patch('/:id/members/:userId', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const targetUserId = req.params.userId;
    const { role } = req.body;

    if (!role || !['admin', 'editor', 'viewer'].includes(role)) {
      res.status(400).json({ error: 'Valid role is required (admin, editor, viewer)' });
      return;
    }

    const membership = db.prepare(
      'SELECT * FROM team_members WHERE team_id = ? AND user_id = ?'
    ).get(teamId, targetUserId) as TeamMemberRow | undefined;
    if (!membership) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    db.prepare(
      'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?'
    ).run(role, teamId, targetUserId);

    emitWalEvent('team_member_role_changed', { teamId, userId: targetUserId, oldRole: membership.role, newRole: role });

    res.json({ teamId, userId: targetUserId, role });
  } catch (error: unknown) {
    console.error('[Teams] update member error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// DELETE /api/teams/:id/members/:userId — Remove a member (admin only)
router.delete('/:id/members/:userId', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const targetUserId = req.params.userId;
    const user = getAuthUser(req);

    // Prevent removing yourself if you're the owner
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (team && team.owner_id === targetUserId) {
      res.status(400).json({ error: 'Cannot remove the team owner' });
      return;
    }

    const result = db.prepare(
      'DELETE FROM team_members WHERE team_id = ? AND user_id = ?'
    ).run(teamId, targetUserId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    emitWalEvent('team_member_removed', { teamId, userId: targetUserId, removedBy: user.id });

    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('[Teams] remove member error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PATCH /api/teams/:id/settings — Update team settings (admin only)
router.patch('/:id/settings', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'Team name is required' });
      return;
    }

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const trimmedName = name.trim();
    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(trimmedName, teamId);

    emitWalEvent('team_settings_updated', { teamId, name: trimmedName });

    res.json({ id: teamId, name: trimmedName, slug: team.slug });
  } catch (error: unknown) {
    console.error('[Teams] settings error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// GET /api/teams/:id/direction — Fetch team-scoped L1/L2 direction layers
router.get('/:id/direction', requireRole('viewer'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const l1Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = ? AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    ).get(teamId) as { content_yaml: string } | undefined;

    const l2Row = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = ? AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`
    ).get(teamId) as { content_yaml: string } | undefined;

    res.json({
      teamId,
      teamName: team.name,
      l1: l1Row?.content_yaml ?? '',
      l2: l2Row?.content_yaml ?? '',
    });
  } catch (error: unknown) {
    console.error('[Teams] get direction error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// PUT /api/teams/:id/direction — Create or update team-level L1/L2 direction layers (admin only)
router.put('/:id/direction', requireRole('admin'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const { layer, contentYaml } = req.body;

    if (!layer || ![1, 2].includes(Number(layer))) {
      res.status(400).json({ error: 'layer must be 1 or 2 for team direction' });
      return;
    }

    if (contentYaml === undefined || contentYaml === null) {
      res.status(400).json({ error: 'contentYaml is required' });
      return;
    }

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    const layerNum = Number(layer);

    // Validate YAML
    const validation = validateDirectionYaml(layerNum, contentYaml);
    if (validation.yamlError) {
      res.status(422).json({ error: 'Invalid YAML syntax', yamlError: validation.yamlError });
      return;
    }
    if (!validation.valid) {
      res.status(422).json({ error: 'Direction content failed schema validation', validationErrors: validation.errors });
      return;
    }

    // Upsert team-scoped layer
    db.prepare(`
      INSERT INTO direction_layers (layer, workspace_id, domain, team_id, content_yaml, updated_at)
      VALUES (?, NULL, NULL, ?, ?, datetime('now'))
      ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
      DO UPDATE SET content_yaml = excluded.content_yaml, updated_at = datetime('now')
    `).run(layerNum, teamId, contentYaml);

    emitWalEvent('team_direction_update', { teamId, layer: layerNum });

    res.json({ ok: true });
  } catch (error: unknown) {
    console.error('[Teams] update direction error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// POST /api/teams/:id/direction/preview — Preview merged output for a team workspace
router.post('/:id/direction/preview', requireRole('viewer'), (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const { workspaceId, specBrief } = req.body;

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team not found' });
      return;
    }

    // Fetch global L1
    const globalL1 = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = '' AND COALESCE(team_id,'') = ''`
    ).get() as { content_yaml: string } | undefined;

    // Fetch global L2
    const globalL2 = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = '' AND COALESCE(team_id,'') = ''`
    ).get() as { content_yaml: string } | undefined;

    // Fetch team L1/L2
    const teamL1 = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = ? AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`
    ).get(teamId) as { content_yaml: string } | undefined;

    const teamL2 = db.prepare(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = ? AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`
    ).get(teamId) as { content_yaml: string } | undefined;

    // Fetch workspace L3 if provided
    let l3Content: string | undefined;
    if (workspaceId) {
      const l3Row = db.prepare(
        `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = ? AND COALESCE(domain,'') = '' AND COALESCE(team_id,'') = ''`
      ).get(String(workspaceId)) as { content_yaml: string } | undefined;
      l3Content = l3Row?.content_yaml;
    }

    const synthesized = synthesize({
      l1: globalL1?.content_yaml,
      l2: globalL2?.content_yaml,
      teamL1: teamL1?.content_yaml,
      teamL2: teamL2?.content_yaml,
      l3: l3Content,
      specBrief: specBrief || '(no spec brief)',
    });

    res.json({ synthesized });
  } catch (error: unknown) {
    console.error('[Teams] direction preview error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
