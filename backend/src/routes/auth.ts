import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import { queryOne } from '../db/index';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { supabaseAdmin } from '../lib/supabase';

const router = Router();

/**
 * @swagger
 * /api/auth/csrf-token:
 *   get:
 *     tags: [Auth]
 *     summary: Get a CSRF token
 *     operationId: getCsrfToken
 *     description: Generates a CSRF token, stores it in an HttpOnly cookie, and returns the same token for double-submit validation.
 *     security: []
 *     responses:
 *       200:
 *         description: CSRF token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [token]
 *               properties:
 *                 token:
 *                   type: string
 */
router.get('/csrf-token', (_req: Request, res: Response) => {
  const token = generateCsrfToken();
  setCsrfCookie(res, token);
  res.json({ token });
});

/** Synthetic session for local single-user mode (no real auth required) */
export const LOCAL_ADMIN = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'admin@rorca.local',
  supabaseId: '00000000-0000-0000-0000-000000000001',
  displayName: 'Admin',
  role: 'admin' as const,
  plan: 'pro' as const,
  githubConnected: false,
  emailVerified: true,
};

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  github_id: string | null;
  email_verified_at: string | null;
  plan?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  supabaseId: string;
  role: string;
  plan?: string;
}

const SUPABASE_AUTH_ENABLED = Boolean(process.env.SUPABASE_URL?.trim());

const ENCRYPTION_SECRET = process.env.VAULT_KEY || process.env.JWT_SECRET || 'rorca-dev-secret-change-in-production';
const ENCRYPTION_KEY = crypto.createHash('sha256').update(ENCRYPTION_SECRET).digest();
const ENCRYPTION_ALGO = 'aes-256-gcm' as const;

export function encryptToken(plainText: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptToken(cipherText: string): string {
  const [ivHex, authTagHex, encryptedHex] = cipherText.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Invalid encrypted token format');
  }

  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGO,
    ENCRYPTION_KEY,
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     operationId: getCurrentUser
 *     description: Returns the current user from Supabase JWT, or the local fallback user when auth bypass is active.
 *     responses:
 *       200:
 *         description: Current user info
 */
router.get('/me', async (req: Request, res: Response) => {
  const authReq = req as Request & { user?: AuthUser };
  const fallbackUser = authReq.user?.id
    ? undefined
    : await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  const userId = authReq.user?.id ?? fallbackUser?.id;

  if (!userId) {
    if (process.env.AUTH_REQUIRED !== 'true') {
      res.json({ user: LOCAL_ADMIN });
      return;
    }
    res.status(401).json({ error: 'No user configured' });
    return;
  }

  const user = await queryOne<UserRow>(
    'SELECT id, email, display_name, github_id, email_verified_at, plan FROM users WHERE id = $1',
    [userId]
  );

  if (!user) {
    res.status(401).json({ error: 'User not found' });
    return;
  }

  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      githubConnected: !!user.github_id,
      emailVerified: !!user.email_verified_at,
      plan: user.plan || 'free',
    },
  });
});

export const INTERNAL_SERVICE_TOKEN = `rorca-internal-${process.pid}`;

export async function authRequired(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.headers['x-rorca-internal'] === INTERNAL_SERVICE_TOKEN) {
    req.user = {
      id: '00000000-0000-0000-0000-000000000000',
      email: 'scheduler@rorca.internal',
      supabaseId: '00000000-0000-0000-0000-000000000000',
      role: 'admin',
    };
    next();
    return;
  }

  if (!SUPABASE_AUTH_ENABLED) {
    req.user = LOCAL_ADMIN;
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    const user = data.user;
    if (error || !user?.id || !user.email) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      supabaseId: user.id,
      role: 'admin',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export const requireAuth = authRequired;

export type TeamRole = 'admin' | 'editor' | 'viewer';

const ROLE_HIERARCHY: Record<TeamRole, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

export function requireRole(minRole: TeamRole) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const teamId =
      req.params.teamId ||
      req.params.id ||
      (req.query.teamId as string) ||
      req.body?.teamId;

    if (!teamId) {
      res.status(400).json({ error: 'Team ID is required' });
      return;
    }

    if (user.id === 'system') {
      next();
      return;
    }

    const membership = await queryOne<{ role: string }>(
      'SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2',
      [teamId, user.id]
    );

    if (!membership) {
      res.status(403).json({ error: 'You are not a member of this team' });
      return;
    }

    const userLevel = ROLE_HIERARCHY[membership.role as TeamRole];
    const requiredLevel = ROLE_HIERARCHY[minRole];

    if (userLevel === undefined || userLevel < requiredLevel) {
      res.status(403).json({ error: `Insufficient permissions: requires ${minRole} role` });
      return;
    }

    (req as Request & { user: AuthUser; teamRole: TeamRole }).teamRole = membership.role as TeamRole;
    next();
  };
}

export default router;
