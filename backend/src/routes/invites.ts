/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { queryOne, execute } from '../db';
import { broadcastAll, type WalEvent } from '../lib/sse-hub';
import { authRequired, type AuthUser } from '../lib/auth-utils';
import { handleRouteError } from '../lib/async-handler';
import { logger } from '../lib/logger';
import { ConflictError, ForbiddenError, GoneError, NotFoundError, TooManyRequestsError } from '../lib/errors';

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
 * /api/invites/{token}:
 *   get:
 *     tags: [Teams]
 *     summary: Validate an invite token
 *     operationId: validateInviteToken
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Invite validation is part of the paid team-collaboration surface and should stay outside the free CLI contract."
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
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const rawToken = req.params.token as string;
    const tokenHash = hashToken(rawToken);

    const invite = await queryOne<TeamInviteRow>(
      'SELECT * FROM team_invites WHERE token_hash = $1',
      [tokenHash]
    );

    if (!invite) {
      throw new NotFoundError('Invalid invite token');
      return;
    }

    if (invite.accepted_at) {
      throw new GoneError('Invite has already been accepted');
      return;
    }

    if (new Date(invite.expires_at) <= new Date()) {
      throw new GoneError('Invite has expired');
      return;
    }

    const team = await queryOne<TeamRow>(
      'SELECT * FROM teams WHERE id = $1',
      [invite.team_id]
    );
    if (!team) {
      throw new NotFoundError('Team no longer exists');
      return;
    }

    // Look up inviter display name
    const inviter = await queryOne<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = $1',
      [invite.invited_by]
    );

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
    handleRouteError(res, error, '[Invites] validate');
  }
});

/**
 * @swagger
 * /api/invites/{token}/accept:
 *   post:
 *     tags: [Teams]
 *     summary: Accept a team invite
 *     operationId: acceptInvite
 *     x-rorca-tier: paid
 *     x-rorca-capability: teams
 *     x-rorca-rationale: "Accepting team invites is a paid multi-user collaboration action and must not be part of the free CLI surface."
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
router.post('/:token/accept', authRequired, async (req: Request, res: Response) => {
  try {
    const user = (req as Request & { user: AuthUser }).user;
    const rawToken = req.params.token as string;
    const tokenHash = hashToken(rawToken);

    const invite = await queryOne<TeamInviteRow>(
      'SELECT * FROM team_invites WHERE token_hash = $1',
      [tokenHash]
    );

    if (!invite) {
      throw new NotFoundError('Invalid invite token');
      return;
    }

    if (invite.accepted_at) {
      throw new GoneError('Invite has already been accepted');
      return;
    }

    if (new Date(invite.expires_at) <= new Date()) {
      throw new GoneError('Invite has expired');
      return;
    }

    // Verify the authenticated user's email matches the invite
    const userRow = await queryOne<{ email: string }>(
      'SELECT email FROM users WHERE id = $1',
      [user.id]
    );
    if (!userRow || userRow.email !== invite.email) {
      throw new ForbiddenError('This invite was sent to a different email address');
      return;
    }

    // Check if already a member
    const existingMember = await queryOne(
      'SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2',
      [invite.team_id, user.id]
    );
    if (existingMember) {
      // Mark invite as accepted anyway
      await execute(
        "UPDATE team_invites SET accepted_at = NOW() WHERE id = $1",
        [invite.id]
      );
      throw new ConflictError('You are already a member of this team');
      return;
    }

    // Add user as member and mark invite as accepted
    await execute(
      "INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, $3, NOW(), NOW())",
      [invite.team_id, user.id, invite.role]
    );

    await execute(
      "UPDATE team_invites SET accepted_at = NOW() WHERE id = $1",
      [invite.id]
    );

    const team = await queryOne<TeamRow>(
      'SELECT * FROM teams WHERE id = $1',
      [invite.team_id]
    );

    await emitWalEvent('team_invite_accepted', {
      teamId: invite.team_id,
      userId: user.id,
      email: invite.email,
      role: invite.role,
    });

    res.json({
      teamId: team!.id,
      teamName: team!.name,
      teamSlug: team!.slug,
      role: invite.role,
      message: 'Successfully joined the team',
    });
  } catch (error: unknown) {
    handleRouteError(res, error, '[Invites] accept');
  }
});

export default router;
