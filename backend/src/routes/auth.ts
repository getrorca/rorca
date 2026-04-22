import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import Stripe from 'stripe';
import { query, queryOne, execute } from '../db/index';
import { logger } from '../lib/logger';
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf';
import { supabaseAdmin } from '../lib/supabase';
import { decryptToken, encryptToken } from '../lib/token-crypto';

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
  github_login: string | null;
  role: string;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  supabaseId: string;
  role: string;
  plan?: string;
}

const SUPABASE_AUTH_ENABLED = Boolean(process.env.SUPABASE_URL?.trim());
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface GitHubConnectionRow {
  id: string;
  user_id: string;
  github_user_id: string;
  encrypted_token: string;
  scopes: string;
  github_username: string | null;
  created_at: string;
  updated_at: string;
}

interface GitHubTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     operationId: getCurrentUser
 *     description: Returns the current user from the Supabase-authenticated request, or the local fallback user when auth is bypassed.
 *     responses:
 *       200: { description: "Current user" }
 *       401: { description: "Not authenticated" }
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

  const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'display_name' | 'github_id' | 'email_verified_at'> & { plan?: string }>(
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

/**
 * @swagger
 * /api/auth/me:
 *   patch:
 *     tags: [Auth]
 *     summary: Update current user profile
 *     operationId: updateCurrentUser
 *     description: Updates the authenticated user's display name.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               displayName: { type: string }
 *     responses:
 *       200: { description: "Profile updated" }
 *       400: { description: "Validation error" }
 *       401: { description: "Not authenticated" }
 */
router.patch('/me', async (req: Request, res: Response) => {
  const authReq = req as Request & { user?: AuthUser };
  const fallbackUser = authReq.user?.id
    ? undefined
    : await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  const userId = authReq.user?.id ?? fallbackUser?.id;

  if (!userId) {
    res.status(401).json({ error: 'No user configured' });
    return;
  }

  const { displayName } = req.body;

  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    res.status(400).json({ error: 'displayName must be a non-empty string' });
    return;
  }

  await execute('UPDATE users SET display_name = $1, updated_at = NOW() WHERE id = $2', [displayName.trim(), userId]);

  const user = await queryOne<Pick<UserRow, 'id' | 'email' | 'display_name' | 'github_id' | 'email_verified_at'> & { plan?: string }>(
    'SELECT id, email, display_name, github_id, email_verified_at, plan FROM users WHERE id = $1',
    [userId]
  );

  res.json({
    ok: true,
    user: user ? {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      githubConnected: !!user.github_id,
      emailVerified: !!user.email_verified_at,
      plan: user.plan || 'free',
    } : undefined,
  });
});

router.delete('/account', authRequired, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await queryOne<Pick<UserRow, 'id' | 'email'>>('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('account_deleted', '', $1)",
    [JSON.stringify({ userId: user.id, email: user.email, deletedAt: new Date().toISOString() })]
  );

  await execute('DELETE FROM users WHERE id = $1', [user.id]);
  logger.info(`[auth] Account deleted: ${user.email} (id: ${user.id}). All data permanently removed.`);

  res.json({ message: 'Your account and all associated data have been permanently deleted.' });
});

async function githubApiFetch<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

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

    const userLevel = ROLE_HIERARCHY[membership.role as TeamRole] ?? -1;
    const requiredLevel = ROLE_HIERARCHY[minRole];

    if (userLevel < requiredLevel) {
      res.status(403).json({ error: `This action requires ${minRole} role or higher` });
      return;
    }

    next();
  };
}

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const GITHUB_OAUTH_ENABLED = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const GITHUB_WEB_ENABLED = String(process.env.GITHUB_WEB_ENABLED || '').trim() === '1';

router.get('/github/enabled', (_req: Request, res: Response) => {
  res.json({ enabled: GITHUB_WEB_ENABLED && GITHUB_OAUTH_ENABLED });
});

router.get('/github/start', authRequired, async (_req: Request, res: Response) => {
  if (!GITHUB_OAUTH_ENABLED || !GITHUB_WEB_ENABLED) {
    res.status(404).json({ error: 'GitHub OAuth not enabled' });
    return;
  }

  const redirectUri = process.env.GITHUB_REDIRECT_URI || 'http://localhost:3030/api/auth/github/callback';
  const scope = 'repo read:user user:email';
  const url = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

router.get('/github/callback', authRequired, async (req: Request, res: Response) => {
  if (!GITHUB_OAUTH_ENABLED || !GITHUB_WEB_ENABLED) {
    res.status(404).json({ error: 'GitHub OAuth not enabled' });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  if (!code) {
    res.status(400).json({ error: 'Missing code' });
    return;
  }

  const redirectUri = process.env.GITHUB_REDIRECT_URI || 'http://localhost:3030/api/auth/github/callback';
  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResp.ok) {
    res.status(502).json({ error: 'Failed to exchange GitHub OAuth code' });
    return;
  }

  const tokenJson = await tokenResp.json() as GitHubTokenResponse & { error?: string; error_description?: string };
  if (!tokenJson.access_token) {
    res.status(400).json({ error: tokenJson.error_description || tokenJson.error || 'Missing access token' });
    return;
  }

  const ghUser = await githubApiFetch<GitHubUser>('https://api.github.com/user', tokenJson.access_token);
  let email = ghUser.email;
  if (!email) {
    const emails = await githubApiFetch<GitHubEmail[]>('https://api.github.com/user/emails', tokenJson.access_token);
    const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0];
    email = primary?.email || null;
  }

  const encrypted = encryptToken(tokenJson.access_token);
  const existing = await queryOne<GitHubConnectionRow>('SELECT id FROM github_connections WHERE user_id = $1', [userId]);
  if (existing) {
    await execute(
      `UPDATE github_connections
       SET github_user_id = $1, encrypted_token = $2, scopes = $3, github_username = $4, updated_at = NOW()
       WHERE id = $5`,
      [String(ghUser.id), encrypted, tokenJson.scope || '', ghUser.login, existing.id]
    );
  } else {
    await execute(
      `INSERT INTO github_connections (id, user_id, github_user_id, encrypted_token, scopes, github_username)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), userId, String(ghUser.id), encrypted, tokenJson.scope || '', ghUser.login]
    );
  }

  await execute('UPDATE users SET github_id = $1, github_login = $2, updated_at = NOW() WHERE id = $3', [String(ghUser.id), ghUser.login, userId]);

  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_connected', '', $1)",
    [JSON.stringify({ userId, githubLogin: ghUser.login, githubEmail: email })]
  );

  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5210';
  res.redirect(`${frontendUrl}/settings/github?connected=1`);
});

router.post('/github/disconnect', authRequired, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  await execute('DELETE FROM github_connections WHERE user_id = $1', [userId]);
  await execute('UPDATE users SET github_id = NULL, github_login = NULL, updated_at = NOW() WHERE id = $1', [userId]);
  await execute(
    "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_disconnected', '', $1)",
    [JSON.stringify({ userId })]
  );

  res.json({ ok: true });
});

router.get('/github/status', authRequired, async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const conn = await queryOne<Pick<GitHubConnectionRow, 'github_username' | 'scopes'>>(
    'SELECT github_username, scopes FROM github_connections WHERE user_id = $1',
    [userId]
  );

  res.json({
    connected: !!conn,
    githubUsername: conn?.github_username || null,
    scopes: conn?.scopes || '',
  });
});

export { decryptToken, encryptToken };
export default router;
