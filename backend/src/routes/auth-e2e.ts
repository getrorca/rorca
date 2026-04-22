import { Router } from 'express';
import crypto from 'node:crypto';
import { execute, queryOne } from '../db/index';
import { ValidationError } from '../lib/errors';

const router = Router();

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

router.post('/seed-invite', async (req, res, next) => {
  try {
    const { email, teamName } = req.body ?? {};
    if (!email || typeof email !== 'string') {
      throw new ValidationError('email is required');
    }

    const owner = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email = $1',
      ['admin@rorca.local'],
    );
    if (!owner) {
      throw new ValidationError('default owner missing');
    }

    const teamId = crypto.randomUUID();
    const slug = `team-${teamId.slice(0, 8)}`;
    const rawToken = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const resolvedTeamName = typeof teamName === 'string' && teamName.trim()
      ? teamName.trim()
      : 'Auth E2E Workspace';

    await execute(
      'INSERT INTO teams (id, name, slug, owner_id) VALUES ($1, $2, $3, $4)',
      [teamId, resolvedTeamName, slug, owner.id],
    );
    await execute(
      "INSERT INTO team_members (team_id, user_id, role, accepted_at, last_active_at) VALUES ($1, $2, 'admin', NOW(), NOW())",
      [teamId, owner.id],
    );
    await execute(
      "INSERT INTO team_invites (id, team_id, email, token_hash, invited_by, role, expires_at) VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '7 days')",
      [inviteId, teamId, email, hashToken(rawToken), owner.id, 'editor'],
    );

    res.json({ token: rawToken, teamId, teamName: resolvedTeamName, slug });
  } catch (error) {
    next(error);
  }
});

export default router;
