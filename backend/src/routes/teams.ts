import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, queryOne, execute } from '../db/index';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import type { AuthUser } from '../lib/auth-utils';
import { requireRole, requireWorkspaceAdmin } from '../lib/auth-utils';
import { validateDirectionYaml } from '../lib/direction-validator';
import { synthesize } from '../lib/direction-stack';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { logger } from '../lib/logger';
import { sendTeamInviteEmail } from '../lib/email';
import { ConflictError, NotFoundError, TooManyRequestsError, UnprocessableError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

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

async function emitWalEvent(eventType: string, payload: Record<string, unknown>): Promise<void> {
  const result = await queryOne<{ id: number }>(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ($1, '', $2) RETURNING id",
    [eventType, JSON.stringify(payload)]
  );
  const walEvent: WalEvent = {
    id: result?.id ?? 0,
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
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Team listing is part of the multi-user collaboration surface and belongs behind the paid plan boundary."
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
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Creating teams is a paid collaboration feature and must not be reachable from the free CLI contract."
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
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
    const rows = await query<{
      id: string;
      name: string;
      slug: string;
      ownerId: string;
      createdAt: string;
      role: string;
      workspaceId: string;
    }>(`
      SELECT t.id, t.name, t.slug, t.owner_id AS "ownerId", t.created_at AS "createdAt", tm.role, t.workspace_id AS "workspaceId"
      FROM teams t
      JOIN team_members tm ON t.id = tm.team_id
      WHERE tm.user_id = $1
        AND ($2 = '' OR t.workspace_id = $2)
      ORDER BY t.name ASC
    `, [user.id, workspaceId]);

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(rows, pagination, { cursorKey: (t) => t.id }));
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] list');
  }
});

/**
 * @swagger
 * /api/teams:
 *   post:
 *     tags: [Teams]
 *     summary: Create a new team
 *     operationId: createTeam
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Creating teams is a paid collaboration feature and must not be reachable from the free CLI contract."
 *     description: >
 *       Creates a new team and assigns the authenticated user as its owner with admin role.
 *       The slug must be unique across all teams and must be lowercase alphanumeric with hyphens only.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, slug]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Human-readable team name
 *                 example: Rorca Core
 *               slug:
 *                 type: string
 *                 description: URL-safe unique identifier (lowercase alphanumeric and hyphens)
 *                 example: rorca-core
 *     responses:
 *       201:
 *         description: Team created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 name: { type: string, example: Rorca Core }
 *                 slug: { type: string, example: rorca-core }
 *                 ownerId: { type: string }
 *                 createdAt: { type: string, format: date-time }
 *       400:
 *         description: Missing name or invalid slug format
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Team slug already taken
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /api/teams — Create a new team
router.post('/', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const { name, slug, workspaceId } = req.body;

    if (!workspaceId || typeof workspaceId !== 'string' || !workspaceId.trim()) {
      throw new ValidationError('Workspace ID is required');
    }

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('Team name is required');
      return;
    }
    if (!slug || typeof slug !== 'string') {
      throw new ValidationError('Team slug is required');
      return;
    }

    const trimmedSlug = slug.trim().toLowerCase();
    if (!SLUG_REGEX.test(trimmedSlug)) {
      throw new ValidationError('Slug must be lowercase alphanumeric with hyphens (e.g. my-team)');
      return;
    }

    // Check slug uniqueness
    const existing = await queryOne<TeamRow>('SELECT id FROM teams WHERE slug = $1', [trimmedSlug]);
    if (existing) {
      throw new ConflictError('Team slug already taken');
      return;
    }

    const teamId = crypto.randomUUID();
    const trimmedName = name.trim();

    const trimmedWorkspaceId = workspaceId.trim();

    // Create team
    await execute(
      'INSERT INTO teams (id, name, slug, owner_id, workspace_id) VALUES ($1, $2, $3, $4, $5)',
      [teamId, trimmedName, trimmedSlug, user.id, trimmedWorkspaceId]
    );

    await execute(
      `INSERT INTO workspace_access (workspace_id, team_id, permission)
       VALUES ($1, $2, 'admin')
       ON CONFLICT (workspace_id, team_id) DO NOTHING`,
      [trimmedWorkspaceId, teamId]
    );

    // Add owner as admin member
    await execute(
      "INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'admin', NOW(), NOW())",
      [teamId, user.id]
    );

    await emitWalEvent('team_created', { teamId, workspaceId: trimmedWorkspaceId, name: trimmedName, slug: trimmedSlug, ownerId: user.id });

    res.status(201).json({
      id: teamId,
      name: trimmedName,
      slug: trimmedSlug,
      ownerId: user.id,
      workspaceId: trimmedWorkspaceId,
      createdAt: new Date().toISOString(),
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] create');
  }
});

/**
 * @swagger
 * /api/teams/{id}/invites:
 *   post:
 *     tags: [Teams]
 *     summary: Send a team invitation
 *     operationId: createTeamInvite
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Issuing team invites is a multi-user collaboration action and belongs behind the paid plan boundary."
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
router.post('/:id/invites', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = getAuthUser(req);
    const teamId = req.params.id;
    const { email, role } = req.body;

    if (!email || typeof email !== 'string') {
      throw new ValidationError('Email is required');
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    const inviteRole = role && ['admin', 'editor', 'viewer'].includes(role) ? role : 'editor';

    // Verify team exists
    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (!team) {
      throw new NotFoundError('Team not found');
      return;
    }

    // Check if email is already a member
    const existingMember = await queryOne<TeamMemberRow>(
      'SELECT tm.* FROM team_members tm JOIN users u ON tm.user_id = u.id WHERE tm.team_id = $1 AND u.email = $2',
      [teamId, trimmedEmail]
    );
    if (existingMember) {
      throw new ConflictError('User is already a team member');
      return;
    }

    // Check pending invite limit (free tier: max 3)
    const pendingCount = await queryOne<{ cnt: number }>(
      'SELECT COUNT(*)::int AS cnt FROM team_invites WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > NOW()',
      [teamId]
    );
    if (pendingCount && Number(pendingCount.cnt) >= MAX_PENDING_INVITES_FREE) {
      throw new TooManyRequestsError(`Free tier limit: maximum ${MAX_PENDING_INVITES_FREE} pending invites at a time`);
      return;
    }

    // Check for existing pending invite to same email
    const existingInvite = await queryOne<TeamInviteRow>(
      'SELECT id FROM team_invites WHERE team_id = $1 AND email = $2 AND accepted_at IS NULL AND expires_at > NOW()',
      [teamId, trimmedEmail]
    );
    if (existingInvite) {
      throw new ConflictError('A pending invite already exists for this email');
      return;
    }

    // Generate signed invite token
    const rawToken = generateInviteToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const inviteId = crypto.randomUUID();

    await execute(
      'INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [inviteId, teamId, trimmedEmail, tokenHash, user.id, inviteRole, expiresAt]
    );

    const inviteUrl = `${process.env.RORCA_BASE_URL || 'http://localhost:5210'}/invites/${rawToken}`;
    let emailSent = false;
    let emailError: string | null = null;

    try {
      await sendTeamInviteEmail(trimmedEmail, user.email || 'A teammate', team.name, inviteUrl);
      emailSent = true;
    } catch (error) {
      emailError = error instanceof Error ? error.message : 'Failed to send invite email';
      logger.warn({ err: error, teamId, inviteId, email: trimmedEmail }, '[Teams] invite email send failed');
    }

    await emitWalEvent('team_invite_sent', { teamId, inviteId, email: trimmedEmail, role: inviteRole, invitedBy: user.id, emailSent });

    res.status(201).json({
      inviteId,
      email: trimmedEmail,
      role: inviteRole,
      token: rawToken,
      inviteUrl,
      emailSent,
      emailError,
      expiresAt,
      teamName: team.name,
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] invite');
  }
});

/**
 * @swagger
 * /api/teams/{id}/members:
 *   get:
 *     tags: [Teams]
 *     summary: List team members
 *     operationId: listTeamMembers
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Team membership is part of the paid collaboration surface and should never be exposed through the free CLI contract."
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
router.get('/:id/members', requireRole('viewer'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;

    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (!team) {
      throw new NotFoundError('Team not found');
      return;
    }

    const members = await query<{
      userId: string;
      email: string;
      displayName: string;
      role: string;
      joinedAt: string;
      acceptedAt: string | null;
      lastActiveAt: string | null;
    }>(`
      SELECT
        tm.user_id AS "userId",
        u.email,
        u.display_name AS "displayName",
        tm.role,
        tm.invited_at AS "joinedAt",
        tm.accepted_at AS "acceptedAt",
        tm.last_active_at AS "lastActiveAt"
      FROM team_members tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.team_id = $1
      ORDER BY tm.invited_at ASC
    `, [teamId]);

    res.json({ teamId, teamName: team.name, members });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] members');
  }
});

/**
 * @swagger
 * /api/teams/{id}/members/{userId}:
 *   patch:
 *     tags: [Teams]
 *     summary: Update a team member's role
 *     operationId: updateTeamMemberRole
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Managing team member roles is a paid RBAC capability and must stay outside the free contract."
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
router.patch('/:id/members/:userId', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const targetUserId = req.params.userId;
    const { role } = req.body;

    if (!role || !['admin', 'editor', 'viewer'].includes(role)) {
      throw new ValidationError('Valid role is required (admin, editor, viewer)');
      return;
    }

    const membership = await queryOne<TeamMemberRow>(
      'SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, targetUserId]
    );
    if (!membership) {
      throw new NotFoundError('Member not found');
      return;
    }

    await execute(
      'UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3',
      [role, teamId, targetUserId]
    );

    await emitWalEvent('team_member_role_changed', { teamId, userId: targetUserId, oldRole: membership.role, newRole: role });

    res.json({ teamId, userId: targetUserId, role });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] update member');
  }
});

/**
 * @swagger
 * /api/teams/{id}/members/{userId}:
 *   delete:
 *     tags: [Teams]
 *     summary: Remove a team member
 *     operationId: removeTeamMember
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Removing team members is part of the paid RBAC surface and should not be MCP-exposed to free users."
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
router.delete('/:id/members/:userId', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const targetUserId = req.params.userId;
    const user = getAuthUser(req);

    // Prevent removing yourself if you're the owner
    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (team && team.owner_id === targetUserId) {
      throw new ValidationError('Cannot remove the team owner');
      return;
    }

    const result = await execute(
      'DELETE FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, targetUserId]
    );

    if (result.rowCount === 0) {
      throw new NotFoundError('Member not found');
      return;
    }

    await emitWalEvent('team_member_removed', { teamId, userId: targetUserId, removedBy: user.id });

    res.json({ ok: true });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] remove member');
  }
});

/**
 * @swagger
 * /api/teams/{id}/settings:
 *   patch:
 *     tags: [Teams]
 *     summary: Update team settings
 *     operationId: updateTeamSettings
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Team settings are multi-user collaboration controls and belong behind the paid plan boundary."
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
router.patch('/:id/settings', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ValidationError('Team name is required');
      return;
    }

    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (!team) {
      throw new NotFoundError('Team not found');
      return;
    }

    const trimmedName = name.trim();
    await execute('UPDATE teams SET name = $1 WHERE id = $2', [trimmedName, teamId]);

    await emitWalEvent('team_settings_updated', { teamId, name: trimmedName });

    res.json({ id: teamId, name: trimmedName, slug: team.slug });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] settings');
  }
});

/**
 * @swagger
 * /api/teams/{id}/direction:
 *   get:
 *     tags: [Teams]
 *     summary: Get team direction layers
 *     operationId: getTeamDirection
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Team-scoped direction is a collaboration feature and should only be available on paid plans."
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
router.get('/:id/direction', requireRole('viewer'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;

    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (!team) {
      throw new NotFoundError('Team not found');
      return;
    }

    const l1Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`,
      [teamId]
    );

    const l2Row = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id, '') = '' AND COALESCE(domain, '') = ''`,
      [teamId]
    );

    res.json({
      teamId,
      teamName: team.name,
      l1: l1Row?.content_yaml ?? '',
      l2: l2Row?.content_yaml ?? '',
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] get direction');
  }
});

/**
 * @swagger
 * /api/teams/{id}/direction:
 *   put:
 *     tags: [Teams]
 *     summary: Update team direction layer
 *     operationId: updateTeamDirection
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Updating team-scoped direction mutates paid collaboration state and should not be in the free contract."
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
router.put('/:id/direction', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const { layer, contentYaml } = req.body;

    if (!layer || ![1, 2].includes(Number(layer))) {
      throw new ValidationError('layer must be 1 or 2 for team direction');
      return;
    }

    if (contentYaml === undefined || contentYaml === null) {
      throw new ValidationError('contentYaml is required');
      return;
    }

    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (!team) {
      throw new NotFoundError('Team not found');
      return;
    }

    const layerNum = Number(layer);

    // Validate YAML
    const validation = validateDirectionYaml(layerNum, contentYaml);
    if (validation.yamlError) {
      throw new UnprocessableError('Invalid YAML syntax');
      return;
    }
    if (!validation.valid) {
      throw new UnprocessableError('Direction content failed schema validation');
      return;
    }

    // Upsert team-scoped layer
    await execute(`
      INSERT INTO direction_layers (layer, workspace_id, domain, team_id, content_yaml, updated_at)
      VALUES ($1, NULL, NULL, $2, $3, NOW())
      ON CONFLICT (layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''))
      DO UPDATE SET content_yaml = EXCLUDED.content_yaml, updated_at = NOW()
    `, [layerNum, teamId, contentYaml]);

    await emitWalEvent('team_direction_update', { teamId, layer: layerNum });

    res.json({ ok: true });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Teams] update direction');
  }
});

/**
 * @swagger
 * /api/teams/{id}/direction/preview:
 *   post:
 *     tags: [Teams]
 *     summary: Preview merged direction stack
 *     operationId: previewTeamDirection
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Team direction preview relies on team-scoped collaboration state and belongs behind the paid plan boundary."
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
router.post('/:id/direction/preview', requireRole('viewer'), async (req: Request, res: Response) => {
  try {
    const teamId = req.params.id;
    const { workspaceId, specBrief } = req.body;

    const team = await queryOne<TeamRow>('SELECT * FROM teams WHERE id = $1', [teamId]);
    if (!team) {
      throw new NotFoundError('Team not found');
      return;
    }

    // Fetch global L1
    const globalL1 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = '' AND COALESCE(team_id,'') = ''`
    );

    // Fetch global L2
    const globalL2 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = '' AND COALESCE(team_id,'') = ''`
    );

    // Fetch team L1/L2
    const teamL1 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 1 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
      [teamId]
    );

    const teamL2 = await queryOne<{ content_yaml: string }>(
      `SELECT content_yaml FROM direction_layers WHERE layer = 2 AND team_id = $1 AND COALESCE(workspace_id,'') = '' AND COALESCE(domain,'') = ''`,
      [teamId]
    );

    // Fetch workspace L3 if provided
    let l3Content: string | undefined;
    if (workspaceId) {
      const l3Row = await queryOne<{ content_yaml: string }>(
        `SELECT content_yaml FROM direction_layers WHERE layer = 3 AND workspace_id = $1 AND COALESCE(domain,'') = '' AND COALESCE(team_id,'') = ''`,
        [String(workspaceId)]
      );
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
    handleRouteError(res, error, '[Teams] direction preview');
  }
});

export default router;
