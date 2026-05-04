/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import { queryOne, execute, transaction } from '../db/index';
import { encryptToken, decryptToken } from '../lib/auth-utils';
import { logger } from '../lib/logger';
import { AuthError, ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { githubRateLimiter } from '../lib/github-rate-limiter';
import { insertAuditEntry } from './integration-audit-log';
import { requireWorkspaceAdmin, requireWorkspaceMember } from '../lib/auth-utils';

const router = Router({ mergeParams: true });

router.use(requireWorkspaceMember());

interface GithubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  webhook_id: number | null;
  encrypted_webhook_secret: string;
  last_webhook_at: string | null;
  created_at: string;
  auto_pr_enabled: number;
  auto_pr_target_branch: string;
  auto_pr_reviewers: string;
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim() || null;
}

async function withUserClient(req: Request) {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    throw new AuthError('Missing bearer token');
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new AuthError('Supabase anon client is not configured');
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

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

// ─── GET /api/workspaces/:id/github — Connection status ──────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/github:
 *   get:
 *     tags: [GitHub]
 *     summary: Get GitHub connection status for a workspace
 *     operationId: getWorkspaceGithubStatus
 *     description: Returns the current GitHub webhook connection status for the specified workspace, including repository details and auto-PR configuration if connected.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: "Connection status returned successfully. Returns `{ connected: false }` if no GitHub connection exists, or full connection details if connected."
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Internal server error
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const row = await queryOne<GithubWebhookRow>(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = $1 LIMIT 1',
      [workspaceId]
    );

    if (!row) {
      res.json({ connected: false });
      return;
    }

    res.json({
      connected: true,
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      webhookId: row.webhook_id,
      lastWebhookAt: row.last_webhook_at,
      connectedAt: row.created_at,
      autoPr: {
        enabled: !!row.auto_pr_enabled,
        targetBranch: row.auto_pr_target_branch || 'main',
        reviewers: (() => { try { return JSON.parse(row.auto_pr_reviewers || '[]'); } catch { return []; } })() as string[],
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Status');
  }
});

// ─── POST /api/workspaces/:id/github/connect — Create webhook + store ────────

/**
 * @swagger
 * /api/workspaces/{id}/github/connect:
 *   post:
 *     tags: [GitHub]
 *     summary: Connect a GitHub repository to a workspace
 *     operationId: connectWorkspaceGithub
 *     description: Creates a webhook on the specified GitHub repository and stores the connection details. Requires a valid GitHub personal access token with webhook permissions.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [repoOwner, repoName, githubToken]
 *             properties:
 *               repoOwner:
 *                 type: string
 *                 description: GitHub repository owner (user or organization)
 *               repoName:
 *                 type: string
 *                 description: GitHub repository name
 *               githubToken:
 *                 type: string
 *                 description: GitHub personal access token with repo and admin:repo_hook scopes
 *     responses:
 *       201:
 *         description: GitHub connection created successfully
 *       400:
 *         description: Missing required fields (repoOwner, repoName, or githubToken)
 *       404:
 *         description: Workspace not found or GitHub repository not found
 *       409:
 *         description: GitHub already connected for this workspace
 *       500:
 *         description: Internal server error
 *       502:
 *         description: GitHub API error during webhook creation
 */
router.post('/connect', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const userClient = await withUserClient(req);
    const { repoOwner, repoName, githubToken } = req.body;

    if (!repoOwner || !repoName || !githubToken) {
      throw new ValidationError('Missing required fields: repoOwner, repoName, githubToken');
    }

    const { data: existingRows, error: existingError } = await userClient
      .from('workspace_github_webhooks')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .limit(1);

    if (existingError) {
      throw new AuthError(existingError.message);
    }

    const existing = existingRows?.[0] as Pick<GithubWebhookRow, 'workspace_id'> | undefined;
    if (existing) {
      throw new ConflictError('GitHub already connected for this workspace. Disconnect first.');
    }

    // Generate webhook secret — graceful degradation if crypto fails
    let webhookSecret: string | null = null;
    try {
      webhookSecret = randomBytes(32).toString('hex');
    } catch (cryptoErr) {
      logger.error({ err: cryptoErr }, '[GitHub] Failed to generate webhook secret');
    }

    // Determine the webhook URL — use RORCA_BASE_URL env or fall back to localhost
    const baseUrl = process.env.RORCA_BASE_URL || 'http://localhost:3030';
    const webhookUrl = `${baseUrl}/api/webhooks/github`;

    let webhookId: number | null = null;
    let webhookError: string | null = null;
    let manualSetupUrl: string | null = null;

    // Only attempt webhook creation if we have a secret
    if (webhookSecret) {
      try {
        // 5-second timeout on GitHub API call
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const ghRes = await githubRateLimiter.execute(() =>
          fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/hooks`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            body: JSON.stringify({
              name: 'web',
              active: true,
              events: ['push', 'pull_request', 'issues', 'check_run'],
              config: {
                url: webhookUrl,
                content_type: 'json',
                secret: webhookSecret,
                insecure_ssl: '0',
              },
            }),
            signal: controller.signal,
          }),
        );
        clearTimeout(timeoutId);

        if (ghRes.ok) {
          const ghData = await ghRes.json() as { id: number };
          webhookId = ghData.id;
        } else if (ghRes.status === 403 || ghRes.status === 404) {
          // Graceful degradation — save connection without webhook
          manualSetupUrl = `https://github.com/${repoOwner}/${repoName}/settings/hooks`;
          webhookError = 'Rorca needs admin access to register webhooks';
          logger.warn({ status: ghRes.status, repoOwner, repoName }, '[GitHub] Webhook creation failed — insufficient permissions');
        } else {
          const ghBody = await ghRes.text();
          logger.error({ status: ghRes.status, body: ghBody }, '[GitHub] Webhook creation failed');
          webhookError = `GitHub API error (${ghRes.status}): ${ghBody}`;
        }
      } catch (fetchErr: any) {
        if (fetchErr.name === 'AbortError') {
          webhookError = 'Webhook registration timed out (>5s). Connection saved without webhook.';
          logger.warn({ repoOwner, repoName }, '[GitHub] Webhook creation timed out');
        } else {
          webhookError = `Webhook registration failed: ${fetchErr.message}`;
          logger.error({ err: fetchErr }, '[GitHub] Webhook creation error');
        }
      }
    } else {
      webhookError = 'Failed to generate webhook secret — connection saved without webhook';
    }

    // Store connection (always — even without webhook)
    const { error: insertError } = await userClient
      .from('workspace_github_webhooks')
      .insert({
        workspace_id: workspaceId,
        repo_owner: repoOwner,
        repo_name: repoName,
        webhook_id: webhookId,
        encrypted_webhook_secret: webhookSecret ? encryptToken(webhookSecret) : '',
      });

    if (insertError) {
      throw new AuthError(insertError.message);
    }

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_connected', $1, $2)",
      [workspaceId, JSON.stringify({ repoOwner, repoName, webhookId, webhookError: webhookError || undefined })]
    );

    insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'integration_connected',
      actorType: 'user',
      actorId: (req as any).user?.id ?? null,
      details: { repoOwner, repoName, webhookId, webhookError: webhookError || undefined },
    });

    // Return 201 with degraded status if webhook failed
    res.status(201).json({
      connected: true,
      repoOwner,
      repoName,
      webhookId,
      ...(webhookError ? { error: webhookError } : {}),
      ...(manualSetupUrl ? { manualSetupUrl } : {}),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Connect');
  }
});

// ─── POST /api/workspaces/:id/github/disconnect — Remove webhook + clear ─────

/**
 * @swagger
 * /api/workspaces/{id}/github/disconnect:
 *   post:
 *     tags: [GitHub]
 *     summary: Disconnect a GitHub repository from a workspace
 *     operationId: disconnectWorkspaceGithub
 *     description: Deletes the webhook from the GitHub repository and removes the connection record from the database. If the webhook was already deleted on GitHub's side, the local connection is still cleaned up.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [githubToken]
 *             properties:
 *               githubToken:
 *                 type: string
 *                 description: GitHub personal access token with permissions to delete the webhook
 *     responses:
 *       200:
 *         description: GitHub connection removed successfully
 *       400:
 *         description: Missing required field (githubToken)
 *       404:
 *         description: No GitHub connection found for this workspace
 *       500:
 *         description: Internal server error
 *       502:
 *         description: GitHub API error during webhook deletion
 */
router.post('/disconnect', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const userClient = await withUserClient(req);
    const { githubToken } = req.body;

    if (!githubToken) {
      throw new ValidationError('Missing required field: githubToken');
    }

    const { data: rows, error: selectError } = await userClient
      .from('workspace_github_webhooks')
      .select('*')
      .eq('workspace_id', workspaceId)
      .limit(1);

    if (selectError) {
      throw new AuthError(selectError.message);
    }

    const row = rows?.[0] as GithubWebhookRow | undefined;

    if (!row) {
      throw new NotFoundError('No GitHub connection found for this workspace');
    }

    // Delete webhook from GitHub if we have a webhook ID
    if (row.webhook_id) {
      const ghRes = await githubRateLimiter.execute(() =>
        fetch(
          `https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/hooks/${row.webhook_id}`,
          {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
            },
          },
        ),
      );

      // 404 = webhook already deleted on GitHub side — that's fine
      if (!ghRes.ok && ghRes.status !== 404) {
        const ghBody = await ghRes.text();
        logger.error({ status: ghRes.status, body: ghBody }, '[GitHub] Webhook deletion failed');
        res.status(502).json({
          error: `GitHub API error (${ghRes.status}): ${ghBody}`,
        });
        return;
      }
    }

    // Remove from DB
    const { error: deleteError } = await userClient
      .from('workspace_github_webhooks')
      .delete()
      .eq('workspace_id', workspaceId);

    if (deleteError) {
      throw new AuthError(deleteError.message);
    }

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_disconnected', $1, $2)",
      [workspaceId, JSON.stringify({ repoOwner: row.repo_owner, repoName: row.repo_name })]
    );

    insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'integration_disconnected',
      actorType: 'user',
      actorId: (req as any).user?.id ?? null,
      details: { repoOwner: row.repo_owner, repoName: row.repo_name },
    });

    res.json({ connected: false });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Disconnect');
  }
});

// ─── GET /api/workspaces/:id/github/account — OAuth account info ──────────────

/**
 * @swagger
 * /api/workspaces/{id}/github/account:
 *   get:
 *     tags: [GitHub]
 *     summary: Get GitHub OAuth account info
 *     operationId: getWorkspaceGithubAccount
 *     description: Returns the GitHub OAuth account information for the current user, including username, avatar URL, connection timestamp, and granted scopes. In single-user mode, returns the first user's connection.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: "Account info returned successfully. Returns `{ connected: false }` if no user or GitHub connection exists, or full account details if connected."
 *       500:
 *         description: Internal server error
 */
router.get('/account', async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    if (!currentUserId) {
      throw new AuthError('Authentication required');
    }

    const conn = await queryOne<GitHubConnectionRow & { avatar_url: string | null }>(
      'SELECT gc.*, u.avatar_url FROM github_connections gc JOIN users u ON gc.user_id = u.id WHERE gc.user_id = $1 ORDER BY gc.created_at DESC LIMIT 1',
      [currentUserId]
    );

    if (!conn) {
      res.json({ connected: false });
      return;
    }

    const scopes = conn.scopes ? conn.scopes.split(/[,\s]+/).filter(Boolean) : [];

    res.json({
      connected: true,
      username: conn.github_username,
      avatarUrl: conn.avatar_url || `https://github.com/${conn.github_username}.png`,
      connectedAt: conn.created_at,
      scopes,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Account');
  }
});

// ─── POST /api/workspaces/:id/github/test-connection — Verify token validity ─

/**
 * @swagger
 * /api/workspaces/{id}/github/test-connection:
 *   post:
 *     tags: [GitHub]
 *     summary: Test GitHub connection validity
 *     operationId: testWorkspaceGithubConnection
 *     description: Verifies that the stored GitHub OAuth token is still valid by making an authenticated request to the GitHub API. Returns the validity status and the associated GitHub username on success.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: "Test result returned. Returns `{ valid: true, username }` on success, or `{ valid: false, error }` if no connection exists or token is invalid."
 */
router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    if (!currentUserId) {
      throw new AuthError('Authentication required');
    }

    const conn = await queryOne<Pick<GitHubConnectionRow, 'encrypted_token' | 'github_username'>>(
      'SELECT encrypted_token, github_username FROM github_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [currentUserId]
    );

    if (!conn) {
      res.json({ valid: false, error: 'No GitHub connection found' });
      return;
    }

    const token = decryptToken(conn.encrypted_token);

    const ghRes = await githubRateLimiter.execute(() =>
      fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }),
    );

    if (ghRes.ok) {
      const user = await ghRes.json() as { login: string; id: number };
      res.json({ valid: true, username: user.login });
    } else {
      res.json({ valid: false, error: `GitHub API returned ${ghRes.status}` });
    }
  } catch (error: any) {
    logger.error('[GitHub] Test connection error:', error);
    res.json({ valid: false, error: error.message });
  }
});

// ─── POST /api/workspaces/:id/github/disconnect-oauth — Revoke OAuth token ───

/**
 * @swagger
 * /api/workspaces/{id}/github/disconnect-oauth:
 *   post:
 *     tags: [GitHub]
 *     summary: Revoke GitHub OAuth token and remove connection
 *     operationId: disconnectWorkspaceGithubOauth
 *     description: Revokes the stored GitHub OAuth token via the GitHub API (best-effort), removes the GitHub connection record from the database, and clears the user's GitHub ID. If GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not configured, the token is not revoked on GitHub's side but the local connection is still removed.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: OAuth connection removed successfully
 *       404:
 *         description: No user configured or no GitHub connection found
 *       500:
 *         description: Internal server error
 */
router.post('/disconnect-oauth', async (req: Request, res: Response) => {
  try {
    const currentUserId = req.user?.id;
    if (!currentUserId) {
      throw new AuthError('Authentication required');
    }

    const conn = await queryOne<Pick<GitHubConnectionRow, 'id' | 'encrypted_token' | 'user_id'>>(
      'SELECT id, encrypted_token, user_id FROM github_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [currentUserId]
    );

    if (!conn) {
      throw new NotFoundError('No GitHub connection found');
    }

    const userId = conn.user_id;

    // Revoke the full OAuth GRANT (not just the token) so GitHub re-shows
    // the consent screen on the next OAuth flow instead of auto-approving.
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (clientId && clientSecret) {
      const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      const token = decryptToken(conn.encrypted_token);
      // 1. Revoke the grant (app authorization) — forces re-consent
      try {
        await githubRateLimiter.execute(() =>
          fetch(`https://api.github.com/applications/${clientId}/grant`, {
            method: 'DELETE',
            headers: {
              Authorization: basicAuth,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ access_token: token }),
          }),
        );
      } catch (revokeErr) {
        // Grant revocation failed — fall back to token-only revocation
        logger.warn({ err: revokeErr }, '[GitHub] Grant revocation failed, falling back to token revocation');
        try {
          await githubRateLimiter.execute(() =>
            fetch(`https://api.github.com/applications/${clientId}/token`, {
              method: 'DELETE',
              headers: {
                Authorization: basicAuth,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ access_token: token }),
            }),
          );
        } catch (tokenRevokeErr) {
          logger.warn({ err: tokenRevokeErr }, '[GitHub] Token revocation also failed (proceeding with local disconnect)');
        }
      }
    }

    // Remove connection from DB
    await execute('DELETE FROM github_connections WHERE id = $1', [conn.id]);
    await execute("UPDATE users SET github_id = NULL, updated_at = NOW() WHERE id = $1", [userId]);

    // Emit WAL event
    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_oauth_disconnected', '', $1)",
      [JSON.stringify({ userId })]
    );

    insertAuditEntry({
      workspaceId: String(req.params.id),
      provider: 'github',
      action: 'token_revoked',
      actorType: 'user',
      actorId: userId,
      details: { method: 'oauth_disconnect' },
    });

    res.json({ disconnected: true });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Disconnect OAuth');
  }
});

// ─── DELETE /api/workspaces/:id/github — Full disconnect (OAuth + webhook + all data) ──

/**
 * @swagger
 * /api/workspaces/{id}/github:
 *   delete:
 *     tags: [GitHub]
 *     summary: Fully disconnect GitHub integration for a workspace
 *     operationId: deleteWorkspaceGithub
 *     description: |
 *       Revokes the OAuth token via the GitHub API (best-effort), then atomically
 *       deletes all GitHub-specific data: integration_tokens, github_connections,
 *       workspace_github_webhooks, and webhook_dlq entries for the github provider.
 *       Writes an integration_audit_log entry for the disconnect. Pipeline runs
 *       continue but without GitHub integration features.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: GitHub integration disconnected successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disconnected:
 *                   type: boolean
 *       404:
 *         description: No GitHub connection found for this workspace
 *       500:
 *         description: Internal server error
 */
router.delete('/', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  try {
    const currentUserId = req.user?.id;
    if (!currentUserId) {
      throw new AuthError('Authentication required');
    }

    const oauthConn = await queryOne<Pick<GitHubConnectionRow, 'id' | 'encrypted_token' | 'user_id'>>(
      'SELECT id, encrypted_token, user_id FROM github_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [currentUserId],
    );
    const userId = oauthConn?.user_id ?? null;

    const webhookConn = await queryOne<GithubWebhookRow>(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId],
    );

    const hasTokens = await queryOne<{ cnt: string }>(
      "SELECT COUNT(*)::text AS cnt FROM integration_tokens WHERE workspace_id = $1 AND provider = 'github'",
      [workspaceId],
    );

    if (!oauthConn && !webhookConn && Number(hasTokens?.cnt ?? 0) === 0) {
      throw new NotFoundError('No GitHub connection found for this workspace');
    }

    // 1a. Revoke full OAuth GRANT via GitHub API (forces re-consent on next connect)
    if (oauthConn) {
      const clientId = process.env.GITHUB_CLIENT_ID;
      const clientSecret = process.env.GITHUB_CLIENT_SECRET;
      if (clientId && clientSecret) {
        const basicAuth = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
        const token = decryptToken(oauthConn.encrypted_token);
        try {
          const revokeRes = await githubRateLimiter.execute(() =>
            fetch(`https://api.github.com/applications/${clientId}/grant`, {
              method: 'DELETE',
              headers: {
                Authorization: basicAuth,
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ access_token: token }),
            }),
          );
          if (!revokeRes.ok && revokeRes.status !== 404 && revokeRes.status !== 422) {
            logger.warn({ status: revokeRes.status }, '[GitHub] Grant revocation returned non-success, falling back to token revocation');
            await githubRateLimiter.execute(() =>
              fetch(`https://api.github.com/applications/${clientId}/token`, {
                method: 'DELETE',
                headers: {
                  Authorization: basicAuth,
                  Accept: 'application/vnd.github+json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ access_token: token }),
              }),
            );
          }
        } catch (revokeErr) {
          logger.warn({ err: revokeErr }, '[GitHub] Grant revocation failed (proceeding with local cleanup)');
        }
      } else {
        logger.warn('[GitHub] GITHUB_CLIENT_ID/SECRET not configured — skipping grant revocation');
      }
    }

    // 1b. Delete webhook from GitHub (best-effort, before local cleanup)
    if (webhookConn?.webhook_id && oauthConn) {
      try {
        const token = decryptToken(oauthConn.encrypted_token);
        const delRes = await githubRateLimiter.execute(() =>
          fetch(
            `https://api.github.com/repos/${webhookConn.repo_owner}/${webhookConn.repo_name}/hooks/${webhookConn.webhook_id}`,
            {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            },
          ),
        );
        // 404 = already deleted — that's fine
        if (!delRes.ok && delRes.status !== 404) {
          logger.warn({ status: delRes.status }, '[GitHub] Webhook deletion returned non-success (proceeding with local cleanup)');
        }
      } catch (delErr) {
        logger.warn({ err: delErr }, '[GitHub] Webhook deletion failed (proceeding with local cleanup)');
      }
    }

    // 2. Atomic local cleanup
    await transaction(async (client) => {
      // Delete integration_tokens for github provider
      await client.query(
        "DELETE FROM integration_tokens WHERE workspace_id = $1 AND provider = 'github'",
        [workspaceId],
      );

      // Delete github_connections (OAuth record)
      if (oauthConn) {
        await client.query('DELETE FROM github_connections WHERE id = $1', [oauthConn.id]);
        if (userId) {
          await client.query("UPDATE users SET github_id = NULL, updated_at = NOW() WHERE id = $1", [userId]);
        }
      }

      // Delete workspace_github_webhooks
      await client.query('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [workspaceId]);

      // Clear webhook_dlq entries for github provider in this workspace
      await client.query(
        "DELETE FROM webhook_dlq WHERE workspace_id = $1 AND provider = 'github'",
        [workspaceId],
      );

      // Write audit log entry
      await client.query(
        `INSERT INTO integration_audit_log (workspace_id, provider, action, actor_type, actor_id, details)
         VALUES ($1, 'github', 'integration_disconnected', 'user', $2, $3)`,
        [
          workspaceId,
          userId,
          JSON.stringify({
            repoOwner: webhookConn?.repo_owner ?? null,
            repoName: webhookConn?.repo_name ?? null,
            hadOAuth: !!oauthConn,
            hadWebhook: !!webhookConn,
          }),
        ],
      );
    });

    // 3. WAL event (outside transaction — fire-and-forget)
    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_disconnected', $1, $2)",
      [workspaceId, JSON.stringify({
        repoOwner: webhookConn?.repo_owner ?? null,
        repoName: webhookConn?.repo_name ?? null,
      })],
    );

    res.json({ disconnected: true });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Full disconnect');
  }
});

// ─── PUT /api/workspaces/:id/github/auto-pr — Update auto-PR settings ────────

/**
 * @swagger
 * /api/workspaces/{id}/github/auto-pr:
 *   put:
 *     tags: [GitHub]
 *     summary: Update auto-PR settings for a workspace
 *     operationId: updateWorkspaceGithubAutoPr
 *     description: Updates the automatic pull request configuration for the workspace's GitHub connection, including whether auto-PR is enabled, the target branch, and the list of reviewers.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enabled:
 *                 type: boolean
 *                 description: Whether automatic PR creation is enabled
 *               targetBranch:
 *                 type: string
 *                 description: Target branch for auto-created PRs (defaults to "main")
 *               reviewers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of GitHub usernames to request as reviewers
 *     responses:
 *       200:
 *         description: Auto-PR settings updated successfully
 *       404:
 *         description: No GitHub connection found for this workspace
 *       500:
 *         description: Internal server error
 */
router.put('/auto-pr', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const userClient = await withUserClient(req);
    const { enabled, targetBranch, reviewers } = req.body;

    const { data: rows, error: selectError } = await userClient
      .from('workspace_github_webhooks')
      .select('workspace_id')
      .eq('workspace_id', workspaceId)
      .limit(1);

    if (selectError) {
      throw new AuthError(selectError.message);
    }

    const row = rows?.[0] as Pick<GithubWebhookRow, 'workspace_id'> | undefined;

    if (!row) {
      throw new NotFoundError('No GitHub connection found for this workspace');
    }

    const { error: updateError } = await userClient
      .from('workspace_github_webhooks')
      .update({
        auto_pr_enabled: !!enabled,
        auto_pr_target_branch: targetBranch || 'main',
        auto_pr_reviewers: Array.isArray(reviewers) ? reviewers : [],
      })
      .eq('workspace_id', workspaceId);

    if (updateError) {
      throw new AuthError(updateError.message);
    }

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_auto_pr_updated', $1, $2)",
      [workspaceId, JSON.stringify({ enabled, targetBranch, reviewers })]
    );

    res.json({
      enabled: !!enabled,
      targetBranch: targetBranch || 'main',
      reviewers: Array.isArray(reviewers) ? reviewers : [],
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Auto-PR update');
  }
});

// ─── GET /api/workspaces/:id/github/actions-yaml — Generate GitHub Actions workflow ──

/**
 * @swagger
 * /api/workspaces/{id}/github/actions-yaml:
 *   get:
 *     tags: [GitHub]
 *     summary: Generate GitHub Actions workflow YAML
 *     operationId: getWorkspaceGithubActionsYaml
 *     description: Generates a GitHub Actions workflow YAML file configured for the specified workspace. The workflow triggers Rorca pipeline execution on push to main and polls for completion. Returns the YAML as a downloadable file attachment.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     produces:
 *       - application/x-yaml
 *     responses:
 *       200:
 *         description: GitHub Actions workflow YAML file returned as attachment
 *         content:
 *           application/x-yaml:
 *             schema:
 *               type: string
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Internal server error
 */
router.get('/actions-yaml', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = await queryOne<{ id: string; label: string; path: string }>(
      'SELECT id, label, path FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const yaml = generateActionsYaml(workspace.id, workspace.label);

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="rorca-pipeline.yml"`);
    res.send(yaml);
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Actions YAML generation');
  }
});

function generateActionsYaml(workspaceId: string, workspaceLabel: string): string {
  return `# Rorca Pipeline — ${workspaceLabel}
# Generated by Rorca. Place in .github/workflows/rorca-pipeline.yml
#
# Required repository secrets:
#   RORCA_API_URL   — Base URL of your Rorca backend (e.g. https://rorca.example.com)
#   RORCA_API_TOKEN — Auth token for the Rorca API
#   WORKSPACE_ID     — Rorca workspace ID (default: ${workspaceId})

name: Rorca Pipeline

on:
  push:
    branches: [main]

jobs:
  rorca-pipeline:
    name: Trigger Rorca Spec Execution
    runs-on: ubuntu-latest
    timeout-minutes: 60

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Find latest approved spec
        id: find-spec
        run: |
          SPEC_DIR="forge/specs/approved"
          if [ ! -d "$SPEC_DIR" ]; then
            echo "::error::No approved specs directory found at $SPEC_DIR"
            exit 1
          fi
          LATEST_SPEC=$(ls -t "$SPEC_DIR"/*.json 2>/dev/null | head -1)
          if [ -z "$LATEST_SPEC" ]; then
            echo "::notice::No approved specs found — skipping pipeline"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          SPEC_SLUG=$(basename "$LATEST_SPEC" .json)
          echo "spec_path=forge/specs/approved/$SPEC_SLUG.json" >> "$GITHUB_OUTPUT"
          echo "spec_slug=$SPEC_SLUG" >> "$GITHUB_OUTPUT"
          echo "skip=false" >> "$GITHUB_OUTPUT"
          echo "Found spec: $SPEC_SLUG"

      - name: Trigger Rorca pipeline
        if: steps.find-spec.outputs.skip != 'true'
        id: trigger
        run: |
          RESPONSE=$(curl -sf -X POST \\
            "\${{ secrets.RORCA_API_URL }}/api/pipeline/trigger" \\
            -H "Authorization: Bearer \${{ secrets.RORCA_API_TOKEN }}" \\
            -H "Content-Type: application/json" \\
            -d '{
              "specPath": "'\${{ steps.find-spec.outputs.spec_path }}'",
              "workspaceId": "'\${{ secrets.WORKSPACE_ID || '${workspaceId}' }}'",
              "triggerType": "github-actions"
            }')

          RUN_ID=$(echo "$RESPONSE" | jq -r '.runId // empty')
          CONFLICT=$(echo "$RESPONSE" | jq -r '.conflict // false')

          if [ "$CONFLICT" = "true" ]; then
            ACTIVE_ID=$(echo "$RESPONSE" | jq -r '.activeRunId')
            echo "::warning::Pipeline conflict — active run $ACTIVE_ID already in progress"
            echo "run_id=$ACTIVE_ID" >> "$GITHUB_OUTPUT"
          elif [ -z "$RUN_ID" ]; then
            echo "::error::Failed to trigger pipeline. Response: $RESPONSE"
            exit 1
          else
            echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"
            echo "Triggered pipeline run: $RUN_ID"
          fi

      - name: Wait for pipeline completion
        if: steps.find-spec.outputs.skip != 'true'
        run: |
          RUN_ID="\${{ steps.trigger.outputs.run_id }}"
          MAX_POLLS=120   # 120 * 30s = 60 min max
          POLL_INTERVAL=30

          for i in $(seq 1 $MAX_POLLS); do
            RESPONSE=$(curl -sf \\
              "\${{ secrets.RORCA_API_URL }}/api/pipeline/runs/$RUN_ID" \\
              -H "Authorization: Bearer \${{ secrets.RORCA_API_TOKEN }}")

            STATUS=$(echo "$RESPONSE" | jq -r '.run.status // empty')

            case "$STATUS" in
              finished)
                echo "Pipeline completed successfully"
                exit 0
                ;;
              failed)
                echo "::error::Pipeline run $RUN_ID failed"
                exit 1
                ;;
              running)
                PASSED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="pass")] | length')
                TOTAL=$(echo "$RESPONSE" | jq '.stories | length')
                echo "Status: running ($PASSED/$TOTAL stories passed) — poll $i/$MAX_POLLS"
                ;;
              *)
                echo "Status: $STATUS — poll $i/$MAX_POLLS"
                ;;
            esac

            sleep $POLL_INTERVAL
          done

          echo "::error::Pipeline timed out after 60 minutes"
          exit 1

      - name: Report status
        if: always() && steps.find-spec.outputs.skip != 'true'
        run: |
          RUN_ID="\${{ steps.trigger.outputs.run_id }}"
          RESPONSE=$(curl -sf \\
            "\${{ secrets.RORCA_API_URL }}/api/pipeline/runs/$RUN_ID" \\
            -H "Authorization: Bearer \${{ secrets.RORCA_API_TOKEN }}" || echo '{}')

          STATUS=$(echo "$RESPONSE" | jq -r '.run.status // "unknown"')
          TOTAL=$(echo "$RESPONSE" | jq '.stories | length // 0')
          PASSED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="pass")] | length')
          FAILED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="fail")] | length')
          SKIPPED=$(echo "$RESPONSE" | jq '[.stories[]? | select(.outcome=="skip")] | length')

          echo "## Rorca Pipeline Report" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "| Metric | Value |" >> "$GITHUB_STEP_SUMMARY"
          echo "|--------|-------|" >> "$GITHUB_STEP_SUMMARY"
          echo "| Run ID | \`$RUN_ID\` |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Status | $STATUS |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Spec   | \`\${{ steps.find-spec.outputs.spec_slug }}\` |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Passed | $PASSED/$TOTAL |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Failed | $FAILED |" >> "$GITHUB_STEP_SUMMARY"
          echo "| Skipped | $SKIPPED |" >> "$GITHUB_STEP_SUMMARY"
`;
}

// ─── GET /api/workspaces/:id/github/rate-limit — GitHub API rate limit status ─

/**
 * @swagger
 * /api/workspaces/{id}/github/rate-limit:
 *   get:
 *     tags: [GitHub]
 *     summary: Get GitHub API rate limit status
 *     operationId: getGithubRateLimit
 *     description: Returns the current outbound GitHub API rate limit status including remaining requests, limit, reset time, and circuit breaker state.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Rate limit status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 remaining: { type: number }
 *                 limit: { type: number }
 *                 resetAt: { type: string, nullable: true }
 *                 circuitState: { type: string, enum: [closed, open, half-open] }
 */
router.get('/rate-limit', (_req: Request, res: Response) => {
  res.json(githubRateLimiter.getStatus());
});

// ─── Helper: get OAuth token for the current user ─────────────────────────────

async function getOAuthToken(req: Request): Promise<string | null> {
  const currentUserId = req.user?.id;
  if (!currentUserId) return null;

  const conn = await queryOne<{ encrypted_token: string }>(
    'SELECT encrypted_token FROM github_connections WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
    [currentUserId]
  );
  if (!conn) return null;
  return decryptToken(conn.encrypted_token);
}

// ─── GET /api/workspaces/:id/github/repos — List user repos ──────────────────

/**
 * @swagger
 * /api/workspaces/{id}/github/repos:
 *   get:
 *     tags: [GitHub]
 *     summary: List GitHub repositories for the connected account
 *     operationId: listWorkspaceGithubRepos
 *     description: Fetches up to 100 repos (sorted by updated_at desc) from the connected GitHub OAuth account.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Repo list returned
 *       400:
 *         description: No GitHub OAuth connection found
 *       502:
 *         description: GitHub API error
 */
router.get('/repos', async (req: Request, res: Response) => {
  try {
    const token = await getOAuthToken(req);
    if (!token) {
      res.status(400).json({ error: 'No GitHub OAuth connection found. Connect GitHub in Settings > GitHub.' });
      return;
    }

    const ghRes = await githubRateLimiter.execute(() =>
      fetch('https://api.github.com/user/repos?per_page=100&sort=updated&direction=desc&type=all', {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    );

    if (!ghRes.ok) {
      const body = await ghRes.text();
      logger.error({ status: ghRes.status, body }, '[GitHub] Repos fetch failed');
      res.status(502).json({ error: `GitHub API error (${ghRes.status})` });
      return;
    }

    const repos = await ghRes.json() as Array<{
      id: number;
      full_name: string;
      name: string;
      owner: { login: string };
      description: string | null;
      private: boolean;
      open_issues_count: number;
      updated_at: string;
      html_url: string;
    }>;

    res.json({
      repos: repos.map(r => ({
        id: r.id,
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        description: r.description,
        private: r.private,
        openIssuesCount: r.open_issues_count,
        updatedAt: r.updated_at,
        htmlUrl: r.html_url,
      })),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Repos');
  }
});

// ─── GET /api/workspaces/:id/github/repos/:owner/:repo/issues ────────────────

/**
 * @swagger
 * /api/workspaces/{id}/github/repos/{owner}/{repo}/issues:
 *   get:
 *     tags: [GitHub]
 *     summary: List open issues for a GitHub repository
 *     operationId: listWorkspaceGithubRepoIssues
 *     description: Fetches up to 100 open issues (excluding PRs) from the specified repository.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *       - in: path
 *         name: owner
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: repo
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Issue list returned
 *       400:
 *         description: No GitHub OAuth connection found
 *       502:
 *         description: GitHub API error
 */
router.get('/repos/:owner/:repo/issues', async (req: Request, res: Response) => {
  try {
    const { owner, repo } = req.params;

    const token = await getOAuthToken(req);
    if (!token) {
      res.status(400).json({ error: 'No GitHub OAuth connection found. Connect GitHub in Settings > GitHub.' });
      return;
    }

    const ghRes = await githubRateLimiter.execute(() =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100&sort=created&direction=desc`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    );

    if (!ghRes.ok) {
      const body = await ghRes.text();
      logger.error({ status: ghRes.status, body }, '[GitHub] Issues fetch failed');
      res.status(502).json({ error: `GitHub API error (${ghRes.status})` });
      return;
    }

    const issues = await ghRes.json() as Array<{
      id: number;
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      pull_request?: object;
      labels: Array<{ name: string; color: string }>;
      assignee: { login: string; avatar_url: string } | null;
      created_at: string;
    }>;

    // Filter out pull requests — GitHub Issues API includes PRs
    const filtered = issues.filter(i => !i.pull_request);

    res.json({
      issues: filtered.map(i => ({
        id: i.id,
        number: i.number,
        title: i.title,
        body: i.body ?? '',
        htmlUrl: i.html_url,
        labels: i.labels.map(l => ({ name: l.name, color: l.color })),
        assignee: i.assignee ? { login: i.assignee.login, avatarUrl: i.assignee.avatar_url } : null,
        createdAt: i.created_at,
      })),
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Issues');
  }
});

// ─── POST /api/workspaces/:id/github/import-issues ────────────────────────────

/**
 * Extracts acceptance criteria from GitHub issue body markdown.
 * Parses `- [ ]` and `- [x]` checkbox patterns.
 */
function extractAcceptanceCriteria(body: string): string[] {
  const lines = body.split('\n');
  const criteria: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*-\s*\[[ xX]\]\s*(.+)/);
    if (match) {
      criteria.push(match[1].trim());
    }
  }
  return criteria;
}

/**
 * Converts a repo name + timestamp into a spec slug.
 */
function repoToSpecSlug(repoName: string): string {
  const sanitized = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ts = Date.now();
  return `${sanitized}-${ts}`.slice(0, 60);
}

/**
 * @swagger
 * /api/workspaces/{id}/github/import-issues:
 *   post:
 *     tags: [GitHub]
 *     summary: Import GitHub issues as a pending spec
 *     operationId: importWorkspaceGithubIssues
 *     description: Creates a pending spec JSON from selected GitHub issues. Each issue becomes a user story with title, description, and acceptance criteria extracted from markdown checkboxes.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [owner, repo, issueNumbers]
 *             properties:
 *               owner:
 *                 type: string
 *               repo:
 *                 type: string
 *               issueNumbers:
 *                 type: array
 *                 items:
 *                   type: integer
 *               specTitle:
 *                 type: string
 *                 description: Optional human-readable title for the spec
 *     responses:
 *       201:
 *         description: Spec created
 *       400:
 *         description: Validation error or no GitHub connection
 *       404:
 *         description: Workspace not found
 *       502:
 *         description: GitHub API error
 */
router.post('/import-issues', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { owner, repo, issueNumbers, specTitle } = req.body as {
      owner?: string;
      repo?: string;
      issueNumbers?: number[];
      specTitle?: string;
    };

    if (!owner || !repo) {
      throw new ValidationError('Missing required fields: owner, repo');
    }
    if (!Array.isArray(issueNumbers) || issueNumbers.length === 0) {
      throw new ValidationError('issueNumbers must be a non-empty array');
    }

    const workspace = await queryOne<{ id: string; path: string }>(
      'SELECT id, path FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    const token = await getOAuthToken(req);
    if (!token) {
      res.status(400).json({ error: 'No GitHub OAuth connection found. Connect GitHub in Settings > GitHub.' });
      return;
    }

    // Fetch each selected issue from GitHub
    const fetchedIssues: Array<{
      number: number;
      title: string;
      body: string;
      htmlUrl: string;
      labels: string[];
    }> = [];

    for (const num of issueNumbers) {
      const ghRes = await githubRateLimiter.execute(() =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${num}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        })
      );

      if (!ghRes.ok) {
        logger.warn({ num, status: ghRes.status }, '[GitHub] Issue fetch failed — skipping');
        continue;
      }

      const issue = await ghRes.json() as {
        number: number;
        title: string;
        body: string | null;
        html_url: string;
        pull_request?: object;
        labels: Array<{ name: string }>;
      };

      if (issue.pull_request) continue; // skip PRs

      fetchedIssues.push({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? '',
        htmlUrl: issue.html_url,
        labels: issue.labels.map((l) => l.name),
      });
    }

    if (fetchedIssues.length === 0) {
      res.status(422).json({ error: 'No valid issues could be fetched from GitHub' });
      return;
    }

    // Build user stories from issues
    const userStories = fetchedIssues.map((issue, idx) => ({
      id: `US-${String(idx + 1).padStart(3, '0')}`,
      title: issue.title,
      description: issue.body,
      acceptanceCriteria: extractAcceptanceCriteria(issue.body),
      dependsOn: [] as string[],
      passes: false,
      githubIssueNumber: issue.number,
      githubIssueUrl: issue.htmlUrl,
    }));

    // Build spec slug and title
    const slug = repoToSpecSlug(repo);
    const title = specTitle || `${owner}/${repo} Issues`;

    const specContent = {
      id: slug,
      title,
      userStories,
      generatedAt: new Date().toISOString(),
      source: 'github-import',
      githubRepo: `${owner}/${repo}`,
    };

    // Ensure pending directory exists and write spec file
    const pendingDir = path.join(workspace.path, 'forge', 'specs', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    const specFilePath = path.join(pendingDir, `${slug}.json`);
    fs.writeFileSync(specFilePath, JSON.stringify(specContent, null, 2) + '\n', 'utf8');

    // Emit WAL event
    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_issues_imported', $1, $2)",
      [workspaceId, JSON.stringify({ slug, owner, repo, storyCount: userStories.length, issueNumbers })]
    );

    res.status(201).json({
      specId: slug,
      storyCount: userStories.length,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[GitHub] Import issues');
  }
});

// ─── GET /api/workspaces/:id/github/workflow-config — Get dispatch config ────

/**
 * @swagger
 * /api/workspaces/{id}/github/workflow-config:
 *   get:
 *     tags: [GitHub]
 *     summary: Get workflow dispatch configuration for a workspace
 *     operationId: getWorkspaceWorkflowConfig
 *     description: Returns the stored GitHub Actions workflow dispatch configuration for this workspace.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Workflow config (null if not configured)
 *       404:
 *         description: Workspace not found
 */
router.get('/workflow-config', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }
  const row = await queryOne<{ workflow_config: unknown }>(
    'SELECT workflow_config FROM workspace_github_webhooks WHERE workspace_id = $1',
    [workspaceId]
  );
  res.json({ workflowConfig: row?.workflow_config ?? null });
});

// ─── PUT /api/workspaces/:id/github/workflow-config — Save dispatch config ───

/**
 * @swagger
 * /api/workspaces/{id}/github/workflow-config:
 *   put:
 *     tags: [GitHub]
 *     summary: Save workflow dispatch configuration for a workspace
 *     operationId: saveWorkspaceWorkflowConfig
 *     description: Stores GitHub Actions workflow dispatch config (workflow_id, ref, inputs, enabled flag).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workflowConfig]
 *             properties:
 *               workflowConfig:
 *                 type: object
 *                 properties:
 *                   enabled: { type: boolean }
 *                   workflow_id: { type: string }
 *                   ref: { type: string }
 *                   inputs: { type: object }
 *     responses:
 *       200:
 *         description: Config saved successfully
 *       404:
 *         description: Workspace or GitHub webhook connection not found
 */
router.put('/workflow-config', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { workflowConfig } = req.body;

  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const row = await queryOne<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = $1',
    [workspaceId]
  );
  if (!row) {
    throw new NotFoundError('GitHub webhook connection not found. Connect a repository first.');
  }

  await execute(
    'UPDATE workspace_github_webhooks SET workflow_config = $1 WHERE workspace_id = $2',
    [JSON.stringify(workflowConfig), workspaceId]
  );

  res.json({ ok: true });
});

// ─── POST /api/workspaces/:id/github/dispatch — Trigger workflow dispatch ─────

/**
 * @swagger
 * /api/workspaces/{id}/github/dispatch:
 *   post:
 *     tags: [GitHub]
 *     summary: Trigger a GitHub Actions workflow dispatch event
 *     operationId: dispatchWorkspaceWorkflow
 *     description: |
 *       Proxies a workflow_dispatch event to the GitHub API using the workspace's
 *       stored OAuth token. Requires the token to have the `workflow` scope.
 *       Returns 204 on success (GitHub returns no body for dispatches).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [owner, repo, workflow_id, ref]
 *             properties:
 *               owner:
 *                 type: string
 *                 description: GitHub repository owner
 *               repo:
 *                 type: string
 *                 description: GitHub repository name
 *               workflow_id:
 *                 type: string
 *                 description: Workflow filename (e.g. deploy.yml) or workflow ID number
 *               ref:
 *                 type: string
 *                 description: Branch or tag ref to run the workflow on (e.g. main)
 *               inputs:
 *                 type: object
 *                 description: Optional input key-value pairs for the workflow
 *     responses:
 *       204:
 *         description: Workflow dispatch triggered successfully
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Workspace not found, no GitHub connection, or workflow not found on GitHub
 *       422:
 *         description: Invalid inputs — check workflow filename and input parameters
 *       502:
 *         description: GitHub API error
 */
router.post('/dispatch', requireWorkspaceAdmin(), async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { owner, repo, workflow_id, ref, inputs } = req.body;

  if (!owner || !repo || !workflow_id || !ref) {
    throw new ValidationError('Missing required fields: owner, repo, workflow_id, ref');
  }

  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
  }

  const token = await getOAuthToken(req);
  if (!token) {
    throw new NotFoundError('No GitHub OAuth connection found. Connect your GitHub account first.');
  }

  const ghUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`;
  const body: Record<string, unknown> = { ref };
  if (inputs && Object.keys(inputs).length > 0) {
    body.inputs = inputs;
  }

  const ghRes = await fetch(ghUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(body),
  });

  if (!ghRes.ok) {
    const ghBody = await ghRes.text();
    logger.error({ status: ghRes.status, body: ghBody, workflow_id }, '[GitHub] Workflow dispatch failed');

    insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'api_call_failed',
      actorType: 'user',
      actorId: (req as any).user?.id ?? null,
      details: { workflow_id, ref, owner, repo, status: ghRes.status, error: ghBody },
    });

    if (ghRes.status === 404) {
      res.status(404).json({
        error: `Workflow '${workflow_id}' not found in ${owner}/${repo}. Check the workflow filename and that it exists on the '${ref}' branch.`,
      });
      return;
    }
    if (ghRes.status === 422) {
      let detail = ghBody;
      try { detail = JSON.parse(ghBody).message ?? ghBody; } catch { /* use raw body */ }
      res.status(422).json({
        error: `Invalid workflow inputs for '${workflow_id}': ${detail}`,
      });
      return;
    }
    res.status(502).json({
      error: `GitHub API error (${ghRes.status}) for workflow '${workflow_id}': ${ghBody}`,
    });
    return;
  }

  insertAuditEntry({
    workspaceId: String(workspaceId),
    provider: 'github',
    action: 'api_call_made',
    actorType: 'user',
    actorId: (req as any).user?.id ?? null,
    details: { workflow_id, ref, owner, repo },
  });

  // 204 No Content is the success response from GitHub for workflow_dispatch
  res.status(204).send();
});

// ─── Helper: verify webhook signature ────────────────────────────────────────

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// ─── Helper: get decrypted webhook secret for a workspace ────────────────────

export async function getWebhookSecret(workspaceId: string): Promise<string | null> {
  const row = await queryOne<Pick<GithubWebhookRow, 'encrypted_webhook_secret'>>(
    'SELECT encrypted_webhook_secret FROM workspace_github_webhooks WHERE workspace_id = $1',
    [workspaceId]
  );

  if (!row) return null;
  return decryptToken(row.encrypted_webhook_secret);
}

export default router;
