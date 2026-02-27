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
import { db } from '../db';
import { encryptToken, decryptToken } from './auth';
import type { AuthUser } from './auth';

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
function getEffectiveUser(req: Request): AuthUser | null {
  const user = (req as Request & { user: AuthUser }).user;
  if (user) return user;
  return db.prepare('SELECT id, email FROM users LIMIT 1').get() as AuthUser | null;
}

// ─── GET /api/copilot/connect — Redirect to GitHub OAuth for Copilot ─────────

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

// ─── GET /api/copilot/callback — Exchange code for token + store ─────────────

router.get('/callback', async (req: Request, res: Response) => {
  const { code } = req.query;

  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Missing authorization code' });
    return;
  }

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
    res.status(500).json({ error: 'GitHub OAuth not configured' });
    return;
  }

  const user = getEffectiveUser(req);
  if (!user) {
    res.status(401).json({ error: 'No user found' });
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
      res.status(400).json({
        error: tokenData.error_description || tokenData.error || 'Failed to obtain GitHub token',
      });
      return;
    }

    const githubToken = tokenData.access_token;
    const grantedScopes = tokenData.scope || '';

    // Fetch GitHub user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/json',
      },
    });

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

    db.prepare(`
      INSERT INTO integration_credentials (id, user_id, provider, encrypted_token, scopes, provider_username, provider_user_id)
      VALUES (?, ?, 'github_copilot', ?, ?, ?, ?)
      ON CONFLICT(user_id, provider) DO UPDATE SET
        encrypted_token = excluded.encrypted_token,
        scopes = excluded.scopes,
        provider_username = excluded.provider_username,
        provider_user_id = excluded.provider_user_id,
        updated_at = datetime('now')
    `).run(credId, user.id, encryptedToken, grantedScopes, githubUser.login, String(githubUser.id));

    // Emit WAL event
    db.prepare(
      `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('copilot_connected', '', ?)`
    ).run(JSON.stringify({
      userId: user.id,
      githubUsername: githubUser.login,
    }));

    // Redirect back to Settings with success indicator
    res.redirect('http://localhost:5210/?copilot=connected');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `GitHub OAuth exchange failed: ${msg}` });
  }
});

// ─── GET /api/copilot/status — Check connection status ──────────────────────

router.get('/status', (req: Request, res: Response) => {
  const user = getEffectiveUser(req);
  if (!user) {
    res.json({ connected: false });
    return;
  }

  const row = db.prepare(
    'SELECT provider_username, provider_user_id, scopes, created_at, updated_at FROM integration_credentials WHERE user_id = ? AND provider = ?'
  ).get(user.id, 'github_copilot') as Pick<IntegrationCredentialRow, 'provider_username' | 'provider_user_id' | 'scopes' | 'created_at' | 'updated_at'> | undefined;

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

// ─── DELETE /api/copilot/disconnect — Remove token ──────────────────────────

router.delete('/disconnect', (req: Request, res: Response) => {
  const user = getEffectiveUser(req);
  if (!user) {
    res.status(401).json({ error: 'No user found' });
    return;
  }

  const existing = db.prepare(
    'SELECT id, provider_username FROM integration_credentials WHERE user_id = ? AND provider = ?'
  ).get(user.id, 'github_copilot') as Pick<IntegrationCredentialRow, 'id' | 'provider_username'> | undefined;

  if (!existing) {
    res.status(404).json({ error: 'No GitHub Copilot connection found' });
    return;
  }

  db.prepare('DELETE FROM integration_credentials WHERE id = ?').run(existing.id);

  // Emit WAL event
  db.prepare(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('copilot_disconnected', '', ?)`
  ).run(JSON.stringify({
    userId: user.id,
    githubUsername: existing.provider_username,
  }));

  res.json({ disconnected: true });
});

// ─── Exported helper: get decrypted Copilot token for a user ────────────────

export function getCopilotToken(userId: string): string | null {
  const row = db.prepare(
    'SELECT encrypted_token FROM integration_credentials WHERE user_id = ? AND provider = ?'
  ).get(userId, 'github_copilot') as Pick<IntegrationCredentialRow, 'encrypted_token'> | undefined;

  if (!row) return null;

  try {
    return decryptToken(row.encrypted_token);
  } catch {
    return null;
  }
}

export default router;
