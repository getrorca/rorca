/**
 * OC-014: GitHub Copilot integration routes.
 *
 * Handles OAuth flow to obtain a GitHub token with Copilot scope,
 * stores it encrypted in integration_credentials, and exposes
 * status/disconnect endpoints.
 *
 * Token is used by execution-engine.ts when model is 'github/copilot'.
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { queryOne, execute } from '../db';
import { encryptToken, decryptToken } from './auth';
import type { AuthUser } from './auth';
import { AuthError, NotFoundError, ValidationError } from '../lib/errors';
import { githubRateLimiter } from '../lib/github-rate-limiter';

const router = Router();

// GitHub OAuth config (shared with auth.ts GitHub login flow)
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const COPILOT_CALLBACK_URL = process.env.COPILOT_CALLBACK_URL || 'http://localhost:3030/api/copilot/callback';
// Copilot requires 'copilot' scope in addition to user:email for identity
const COPILOT_SCOPES = 'user:email copilot';

interface IntegrationCredentialRow {
  id: string;
  user_id: string;
  provider: string;
  encrypted_token: string;
  scopes: string;
  provider_username: string | null;
  provider_user_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

// Auth bypass helper (same pattern as vault.ts)
async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  if (req.user) {
    return {
      id: req.user.id,
      email: req.user.email,
      supabaseId: req.user.supabaseId,
      role: req.user.role ?? 'admin',
      plan: req.user.plan,
    };
  }
  const fallback = await queryOne<{ id: string; email: string }>('SELECT id, email FROM users LIMIT 1', []);
  return fallback ? { ...fallback, supabaseId: fallback.id, role: 'admin' } : null;
}

/**
 * @swagger
 * /api/copilot/connect:
 *   get:
 *     tags: [Copilot]
 *     summary: Get GitHub OAuth URL for Copilot connection
 *     operationId: getCopilotConnectUrl
 *     description: Returns a GitHub OAuth authorization URL with Copilot scope. The frontend redirects the user to this URL to initiate the OAuth flow.
 *     responses:
 *       200:
 *         description: OAuth authorization URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url: { type: string }
 *       500:
 *         description: GitHub OAuth not configured
 */
router.get('/connect', (_req: Request, res: Response) => {
  if (!GITHUB_CLIENT_ID) {
    res.status(500).json({ error: 'GitHub OAuth not configured. Set GITHUB_CLIENT_ID env var.' });
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: COPILOT_CALLBACK_URL,
    scope: COPILOT_SCOPES,
    state,
  });

  res.json({
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
  });
});

/**
 * @swagger
 * /api/copilot/callback:
 *   get:
 *     tags: [Copilot]
 *     summary: GitHub OAuth callback for Copilot
 *     operationId: copilotOAuthCallback
 *     description: Handles the GitHub OAuth callback, exchanges the authorization code for an access token, stores it encrypted, and redirects back to the frontend.
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema: { type: string }
 *         description: GitHub OAuth authorization code
 *       - in: query
 *         name: state
 *         schema: { type: string }
 *     responses:
 *       302:
 *         description: Redirects to frontend with success indicator
 *       400:
 *         description: Missing authorization code or token exchange failed
 *       401:
 *         description: No user found
 *       500:
 *         description: GitHub OAuth not configured
 *       502:
 *         description: GitHub API error
 */
router.get('/callback', async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code || typeof code !== 'string') {
    throw new ValidationError('Missing authorization code');
    return;
  }

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    res.status(500).json({ error: 'GitHub OAuth not configured' });
    return;
  }

  const user = await getEffectiveUser(req);
  if (!user) {
    throw new AuthError('No user found');
    return;
  }

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: COPILOT_CALLBACK_URL,
      }),
    });

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (tokenData.error || !tokenData.access_token) {
      throw new ValidationError(tokenData.error_description || tokenData.error || 'Failed to obtain GitHub token');
    }

    const githubToken = tokenData.access_token;
    const grantedScopes = tokenData.scope || '';

    // Fetch GitHub user profile
    const userRes = await githubRateLimiter.execute(() =>
      fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/json',
        },
      }),
    );

    if (!userRes.ok) {
      res.status(502).json({ error: 'Failed to fetch GitHub user profile' });
      return;
    }

    const githubUser = await userRes.json() as {
      id: number;
      login: string;
    };

    // Upsert into integration_credentials
    const credId = crypto.randomUUID();
    const encryptedToken = encryptToken(githubToken);

    await execute(`
      INSERT INTO integration_credentials (id, user_id, provider, encrypted_token, scopes, provider_username, provider_user_id)
      VALUES ($1, $2, 'github_copilot', $3, $4, $5, $6)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        encrypted_token = excluded.encrypted_token,
        scopes = excluded.scopes,
        provider_username = excluded.provider_username,
        provider_user_id = excluded.provider_user_id,
        updated_at = NOW()
    `, [credId, user.id, encryptedToken, grantedScopes, githubUser.login, String(githubUser.id)]);

    // Emit WAL event
    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('copilot_connected', '', $1)`,
      [JSON.stringify({
        userId: user.id,
        githubUsername: githubUser.login,
      })]
    );

    // Redirect back to Settings with success indicator
    res.redirect('http://localhost:5210/?copilot=connected');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `GitHub OAuth exchange failed: ${msg}` });
  }
});

/**
 * @swagger
 * /api/copilot/status:
 *   get:
 *     tags: [Copilot]
 *     summary: Check Copilot connection status
 *     operationId: getCopilotStatus
 *     description: Returns whether a GitHub Copilot connection exists for the current user, including GitHub username, scopes, and connection timestamps.
 *     responses:
 *       200:
 *         description: Connection status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 connected: { type: boolean }
 *                 githubUsername: { type: string }
 *                 githubUserId: { type: string }
 *                 scopes: { type: string }
 *                 connectedAt: { type: string }
 *                 updatedAt: { type: string }
 */
router.get('/status', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) {
    res.json({ connected: false });
    return;
  }

  const row = await queryOne<Pick<IntegrationCredentialRow, 'provider_username' | 'provider_user_id' | 'scopes' | 'created_at' | 'updated_at'>>(
    'SELECT provider_username, provider_user_id, scopes, created_at, updated_at FROM integration_credentials WHERE user_id = $1 AND provider = $2',
    [user.id, 'github_copilot']
  );

  if (!row) {
    res.json({ connected: false });
    return;
  }

  res.json({
    connected: true,
    githubUsername: row.provider_username,
    githubUserId: row.provider_user_id,
    scopes: row.scopes,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
  });
});

/**
 * @swagger
 * /api/copilot/disconnect:
 *   delete:
 *     tags: [Copilot]
 *     summary: Disconnect GitHub Copilot
 *     operationId: disconnectCopilot
 *     description: Removes the stored GitHub Copilot token and disconnects the integration. Emits a WAL event for the disconnection.
 *     responses:
 *       200:
 *         description: Disconnected successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disconnected: { type: boolean }
 *       401:
 *         description: No user found
 *       404:
 *         description: No GitHub Copilot connection found
 */
router.delete('/disconnect', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) {
    throw new AuthError('No user found');
    return;
  }

  const existing = await queryOne<Pick<IntegrationCredentialRow, 'id' | 'provider_username'>>(
    'SELECT id, provider_username FROM integration_credentials WHERE user_id = $1 AND provider = $2',
    [user.id, 'github_copilot']
  );

  if (!existing) {
    throw new NotFoundError('No GitHub Copilot connection found');
    return;
  }

  await execute('DELETE FROM integration_credentials WHERE id = $1', [existing.id]);

  // Emit WAL event
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('copilot_disconnected', '', $1)`,
    [JSON.stringify({
      userId: user.id,
      githubUsername: existing.provider_username,
    })]
  );

  res.json({ disconnected: true });
});

// ─── Exported helper: get decrypted Copilot token for a user ────────────────

export async function getCopilotToken(userId: string): Promise<string | null> {
  const row = await queryOne<Pick<IntegrationCredentialRow, 'encrypted_token'>>(
    'SELECT encrypted_token FROM integration_credentials WHERE user_id = $1 AND provider = $2',
    [userId, 'github_copilot']
  );

  if (!row) return null;

  try {
    return decryptToken(row.encrypted_token);
  } catch {
    return null;
  }
}

export default router;
