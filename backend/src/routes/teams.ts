import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import type { AuthUser } from './auth';
import { requireRole } from './auth';
import { validateDirectionYaml } from '../lib/direction-validator';
import { synthesize } from '../lib/direction-stack';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { logger } from '../lib/logger';

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

/**
 * @swagger
 * /api/teams:
 *   get:
 *     tags: [Teams]
 *     summary: List teams the user belongs to
 *     operationId: listTeams
 *     description: Returns a paginated list of teams that the authenticated user is a member of.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *         description: Page number
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer }
 *         description: Items per page
 *     responses:
 *       200:
 *         description: Paginated list of teams
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/Team' }
 *                 total: { type: integer }
 *       500: { description: "Internal server error" }
 *   post:
 *     tags: [Teams]
 *     summary: Create a new team
 *     operationId: createTeam
 *     description: Creates a new team with the given name and slug. The authenticated user becomes the owner and is added as an admin member.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name: { type: string }
 *               slug: { type: string, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }
 *     responses:
 *       201:
 *         description: Team created
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Team' }
 *       400: { description: "Invalid or missing name/slug" }
 *       409: { description: "Slug already taken" }
 *       500: { description: "Internal server error" }
 */
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

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(rows, pagination, { cursorKey: (t) => t.id }));
  } catch (error: unknown) {
    logger.error({ error }, '[Teams] list error');
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
    logger.error({ error }, '[Teams] create error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/invites:
 *   post:
 *     tags: [Teams]
 *     summary: Send a team invitation
 *     operationId: createTeamInvite
 *     description: Sends an email invitation to join the team. Requires admin role. Subject to free-tier pending invite limits.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *               role: { type: string, enum: [admin, editor, viewer], default: editor }
 *     responses:
 *       201:
 *         description: Invite created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 inviteId: { type: string }
 *                 email: { type: string }
 *                 role: { type: string }
 *                 token: { type: string }
 *                 expiresAt: { type: string, format: date-time }
 *                 teamName: { type: string }
 *       400: { description: "Email is required" }
 *       404: { description: "Team not found" }
 *       409: { description: "User is already a member or pending invite exists" }
 *       429: { description: "Free tier pending invite limit reached" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] invite error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/members:
 *   get:
 *     tags: [Teams]
 *     summary: List team members
 *     operationId: listTeamMembers
 *     description: Returns all members of the specified team with their roles and activity timestamps. Requires viewer role.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *     responses:
 *       200:
 *         description: Team members
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 teamId: { type: string }
 *                 teamName: { type: string }
 *                 members: { type: array, items: { type: object } }
 *       404: { description: "Team not found" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] members error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/members/{userId}:
 *   patch:
 *     tags: [Teams]
 *     summary: Update a team member's role
 *     operationId: updateTeamMemberRole
 *     description: Changes the role of an existing team member. Requires admin role.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *         description: User ID of the member to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [admin, editor, viewer] }
 *     responses:
 *       200:
 *         description: Member role updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 teamId: { type: string }
 *                 userId: { type: string }
 *                 role: { type: string }
 *       400: { description: "Invalid role" }
 *       404: { description: "Member not found" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] update member error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/members/{userId}:
 *   delete:
 *     tags: [Teams]
 *     summary: Remove a team member
 *     operationId: removeTeamMember
 *     description: Removes a member from the team. The team owner cannot be removed. Requires admin role.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *         description: User ID of the member to remove
 *     responses:
 *       200:
 *         description: Member removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400: { description: "Cannot remove the team owner" }
 *       404: { description: "Member not found" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] remove member error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/settings:
 *   patch:
 *     tags: [Teams]
 *     summary: Update team settings
 *     operationId: updateTeamSettings
 *     description: Updates team settings such as the team name. Requires admin role.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, description: "New team name" }
 *     responses:
 *       200:
 *         description: Team settings updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 name: { type: string }
 *                 slug: { type: string }
 *       400: { description: "Team name is required" }
 *       404: { description: "Team not found" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] settings error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/direction:
 *   get:
 *     tags: [Teams]
 *     summary: Get team direction layers
 *     operationId: getTeamDirection
 *     description: Fetches team-scoped L1 (engineering principles) and L2 (domain conventions) direction layers.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *     responses:
 *       200:
 *         description: Team direction layers
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 teamId: { type: string }
 *                 teamName: { type: string }
 *                 l1: { type: string, description: "L1 engineering principles YAML" }
 *                 l2: { type: string, description: "L2 domain conventions YAML" }
 *       404: { description: "Team not found" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] get direction error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/direction:
 *   put:
 *     tags: [Teams]
 *     summary: Update team direction layer
 *     operationId: updateTeamDirection
 *     description: Creates or updates a team-scoped L1 or L2 direction layer. YAML content is validated before saving. Requires admin role.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [layer, contentYaml]
 *             properties:
 *               layer: { type: integer, enum: [1, 2], description: "Direction layer (1=engineering, 2=domain)" }
 *               contentYaml: { type: string, description: "YAML content for the direction layer" }
 *     responses:
 *       200:
 *         description: Direction layer updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400: { description: "Invalid layer value or missing contentYaml" }
 *       404: { description: "Team not found" }
 *       422: { description: "Invalid YAML syntax or schema validation failure" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] update direction error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/teams/{id}/direction/preview:
 *   post:
 *     tags: [Teams]
 *     summary: Preview merged direction stack
 *     operationId: previewTeamDirection
 *     description: Synthesizes and previews the merged direction stack output for a team, optionally scoped to a workspace and spec brief. Merges global L1/L2, team L1/L2, and workspace L3 layers.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Team ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workspaceId: { type: string, description: "Optional workspace ID to include L3 layer" }
 *               specBrief: { type: string, description: "Optional spec brief text for L4 context" }
 *     responses:
 *       200:
 *         description: Synthesized direction stack preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 synthesized: { type: string, description: "Merged direction stack content" }
 *       404: { description: "Team not found" }
 *       500: { description: "Internal server error" }
 */
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
    logger.error({ error }, '[Teams] direction preview error');
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
