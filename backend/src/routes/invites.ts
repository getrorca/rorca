import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { authRequired, type AuthUser } from './auth';

const router = Router();

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

interface TeamRow {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
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
 * /api/invites/{token}:
 *   get:
 *     tags: [Teams]
 *     summary: Validate an invite token
 *     operationId: validateInviteToken
 *     description: Validates a team invite token and returns the team info, invited email, role, and inviter name. This endpoint is public and does not require authentication.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *         description: Raw invite token
 *     responses:
 *       200:
 *         description: Invite details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 teamId: { type: string }
 *                 teamName: { type: string }
 *                 teamSlug: { type: string }
 *                 email: { type: string }
 *                 role: { type: string }
 *                 invitedBy: { type: string }
 *                 expiresAt: { type: string }
 *       404:
 *         description: Invalid invite token or team no longer exists
 *       410:
 *         description: Invite already accepted or expired
 */
router.get('/:token', (req: Request, res: Response) => {
  try {
    const rawToken = req.params.token as string;
    const tokenHash = hashToken(rawToken);

    const invite = db.prepare(
      'SELECT * FROM team_invites WHERE token_hash = ?'
    ).get(tokenHash) as TeamInviteRow | undefined;

    if (!invite) {
      res.status(404).json({ error: 'Invalid invite token' });
      return;
    }

    if (invite.accepted_at) {
      res.status(410).json({ error: 'Invite has already been accepted' });
      return;
    }

    if (new Date(invite.expires_at) <= new Date()) {
      res.status(410).json({ error: 'Invite has expired' });
      return;
    }

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(invite.team_id) as TeamRow | undefined;
    if (!team) {
      res.status(404).json({ error: 'Team no longer exists' });
      return;
    }

    // Look up inviter display name
    const inviter = db.prepare('SELECT display_name FROM users WHERE id = ?').get(invite.invited_by) as { display_name: string } | undefined;

    res.json({
      teamId: team.id,
      teamName: team.name,
      teamSlug: team.slug,
      email: invite.email,
      role: invite.role,
      invitedBy: inviter?.display_name || 'Unknown',
      expiresAt: invite.expires_at,
    });
  } catch (error: unknown) {
    console.error('[Invites] validate error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

/**
 * @swagger
 * /api/invites/{token}/accept:
 *   post:
 *     tags: [Teams]
 *     summary: Accept a team invite
 *     operationId: acceptInvite
 *     description: Accepts a team invite token and adds the authenticated user as a team member. The user's email must match the invite email.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *         description: Raw invite token
 *     responses:
 *       200:
 *         description: Successfully joined the team
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 teamId: { type: string }
 *                 teamName: { type: string }
 *                 teamSlug: { type: string }
 *                 role: { type: string }
 *                 message: { type: string }
 *       403:
 *         description: Invite was sent to a different email address
 *       404:
 *         description: Invalid invite token
 *       409:
 *         description: Already a member of this team
 *       410:
 *         description: Invite already accepted or expired
 */
router.post('/:token/accept', authRequired, (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthUser }).user;
    const rawToken = req.params.token as string;
    const tokenHash = hashToken(rawToken);

    const invite = db.prepare(
      'SELECT * FROM team_invites WHERE token_hash = ?'
    ).get(tokenHash) as TeamInviteRow | undefined;

    if (!invite) {
      res.status(404).json({ error: 'Invalid invite token' });
      return;
    }

    if (invite.accepted_at) {
      res.status(410).json({ error: 'Invite has already been accepted' });
      return;
    }

    if (new Date(invite.expires_at) <= new Date()) {
      res.status(410).json({ error: 'Invite has expired' });
      return;
    }

    // Verify the authenticated user's email matches the invite
    const userRow = db.prepare('SELECT email FROM users WHERE id = ?').get(user.id) as { email: string } | undefined;
    if (!userRow || userRow.email !== invite.email) {
      res.status(403).json({ error: 'This invite was sent to a different email address' });
      return;
    }

    // Check if already a member
    const existingMember = db.prepare(
      'SELECT * FROM team_members WHERE team_id = ? AND user_id = ?'
    ).get(invite.team_id, user.id);
    if (existingMember) {
      // Mark invite as accepted anyway
      db.prepare(
        "UPDATE team_invites SET accepted_at = datetime('now') WHERE id = ?"
      ).run(invite.id);
      res.status(409).json({ error: 'You are already a member of this team' });
      return;
    }

    // Add user as member and mark invite as accepted
    db.prepare(
      "INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))"
    ).run(invite.team_id, user.id, invite.role);

    db.prepare(
      "UPDATE team_invites SET accepted_at = datetime('now') WHERE id = ?"
    ).run(invite.id);

    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(invite.team_id) as TeamRow;

    emitWalEvent('team_invite_accepted', {
      teamId: invite.team_id,
      userId: user.id,
      email: invite.email,
      role: invite.role,
    });

    res.json({
      teamId: team.id,
      teamName: team.name,
      teamSlug: team.slug,
      role: invite.role,
      message: 'Successfully joined the team',
    });
  } catch (error: unknown) {
    console.error('[Invites] accept error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export default router;
