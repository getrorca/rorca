import { Router, Request, Response } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { queryOne, execute } from '../db/index';
import { encryptToken, decryptToken } from './auth';
import { logger } from '../lib/logger';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';
import { githubRateLimiter } from '../lib/github-rate-limiter';
import { insertAuditEntry } from './integration-audit-log';

const router = Router({ mergeParams: true });

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

    const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    const row = await queryOne<GithubWebhookRow>(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId]
    );

    if (!row) {
      res.json({ connected: false });
      return;
    }

    let reviewConfig: Record<string, unknown> = {};
    if ((row as any).review_config) {
      try {
        reviewConfig = typeof (row as any).review_config === 'string'
          ? JSON.parse((row as any).review_config)
          : (row as any).review_config;
      } catch {
        reviewConfig = {};
      }
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
        reviewers: JSON.parse(row.auto_pr_reviewers || '[]') as string[],
      },
      reviewConfig,
    });
  } catch (error: any) {
    logger.error('[GitHub] Status error:', error);
    res.status(500).json({ error: error.message });
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
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { repoOwner, repoName, githubToken } = req.body;

    if (!repoOwner || !repoName || !githubToken) {
      throw new ValidationError('Missing required fields: repoOwner, repoName, githubToken');
      return;
    }

    const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Check if already connected
    const existing = await queryOne<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId]
    );
    if (existing) {
      throw new ConflictError('GitHub already connected for this workspace. Disconnect first.');
      return;
    }

    // Generate webhook secret
    const webhookSecret = randomBytes(32).toString('hex');

    // Determine the webhook URL — use RORCA_BASE_URL env or fall back to localhost
    const baseUrl = process.env.RORCA_BASE_URL || 'http://localhost:3030';
    const webhookUrl = `${baseUrl}/api/webhooks/github`;

    // Create webhook via GitHub API
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
          events: ['push', 'pull_request', 'issues'],
          config: {
            url: webhookUrl,
            content_type: 'json',
            secret: webhookSecret,
            insecure_ssl: '0',
          },
        }),
      }),
    );

    if (!ghRes.ok) {
      const ghBody = await ghRes.text();
      logger.error({ status: ghRes.status, body: ghBody }, '[GitHub] Webhook creation failed');
      res.status(ghRes.status === 404 ? 404 : 502).json({
        error: `GitHub API error (${ghRes.status}): ${ghBody}`,
      });
      return;
    }

    const ghData = await ghRes.json() as { id: number };

    // Store connection
    await execute(
      `INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
       VALUES ($1, $2, $3, $4, $5)`,
      [workspaceId, repoOwner, repoName, ghData.id, encryptToken(webhookSecret)]
    );

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_connected', $1, $2)",
      [workspaceId, JSON.stringify({ repoOwner, repoName, webhookId: ghData.id })]
    );

    insertAuditEntry({
      workspaceId: String(workspaceId),
      provider: 'github',
      action: 'integration_connected',
      actorType: 'user',
      actorId: (req as any).user?.id ?? null,
      details: { repoOwner, repoName, webhookId: ghData.id },
    });

    res.status(201).json({
      connected: true,
      repoOwner,
      repoName,
      webhookId: ghData.id,
    });
  } catch (error: any) {
    logger.error('[GitHub] Connect error:', error);
    res.status(500).json({ error: error.message });
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
router.post('/disconnect', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { githubToken } = req.body;

    if (!githubToken) {
      throw new ValidationError('Missing required field: githubToken');
      return;
    }

    const row = await queryOne<GithubWebhookRow>(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId]
    );

    if (!row) {
      throw new NotFoundError('No GitHub connection found for this workspace');
      return;
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
    await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [workspaceId]);

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
    logger.error('[GitHub] Disconnect error:', error);
    res.status(500).json({ error: error.message });
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
    // Get first user's GitHub connection (auth is bypassed — single-user local tool)
    const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
    const userId = userRow?.id;
    if (!userId) {
      res.json({ connected: false });
      return;
    }

    const conn = await queryOne<GitHubConnectionRow & { avatar_url: string | null }>(
      'SELECT gc.*, u.avatar_url FROM github_connections gc JOIN users u ON gc.user_id = u.id WHERE gc.user_id = $1',
      [userId]
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
    logger.error('[GitHub] Account error:', error);
    res.status(500).json({ error: error.message });
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
    const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
    const userId = userRow?.id;
    if (!userId) {
      res.json({ valid: false, error: 'No user configured' });
      return;
    }

    const conn = await queryOne<Pick<GitHubConnectionRow, 'encrypted_token' | 'github_username'>>(
      'SELECT encrypted_token, github_username FROM github_connections WHERE user_id = $1',
      [userId]
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
    const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
    const userId = userRow?.id;
    if (!userId) {
      throw new NotFoundError('No user configured');
      return;
    }

    const conn = await queryOne<Pick<GitHubConnectionRow, 'id' | 'encrypted_token'>>(
      'SELECT id, encrypted_token FROM github_connections WHERE user_id = $1',
      [userId]
    );

    if (!conn) {
      throw new NotFoundError('No GitHub connection found');
      return;
    }

    // Attempt to revoke the token via GitHub API (best-effort)
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (clientId && clientSecret) {
      try {
        const token = decryptToken(conn.encrypted_token);
        await githubRateLimiter.execute(() =>
          fetch(`https://api.github.com/applications/${clientId}/token`, {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ access_token: token }),
          }),
        );
      } catch (revokeErr) {
        logger.warn({ err: revokeErr }, '[GitHub] Token revocation failed (proceeding with local disconnect)');
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
    logger.error('[GitHub] Disconnect OAuth error:', error);
    res.status(500).json({ error: error.message });
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
router.put('/auto-pr', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { enabled, targetBranch, reviewers } = req.body;

    const row = await queryOne<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId]
    );

    if (!row) {
      throw new NotFoundError('No GitHub connection found for this workspace');
      return;
    }

    await execute(
      `UPDATE workspace_github_webhooks
       SET auto_pr_enabled = $1,
           auto_pr_target_branch = $2,
           auto_pr_reviewers = $3
       WHERE workspace_id = $4`,
      [
        enabled ? 1 : 0,
        targetBranch || 'main',
        JSON.stringify(Array.isArray(reviewers) ? reviewers : []),
        workspaceId,
      ]
    );

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
    logger.error('[GitHub] Auto-PR update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/workspaces/:id/github/review-config — Get review request config ─────

/**
 * @swagger
 * /api/workspaces/{id}/github/review-config:
 *   get:
 *     tags: [GitHub]
 *     summary: Get review request configuration
 *     operationId: getWorkspaceGithubReviewConfig
 *     description: Returns the review request configuration for automatic PR reviewer assignment.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Review config returned
 *       404:
 *         description: No GitHub connection found
 */
router.get('/review-config', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const row = await queryOne<{ review_config: string | null }>(
      'SELECT review_config FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId],
    );

    if (!row) {
      throw new NotFoundError('No GitHub connection found for this workspace');
    }

    let config: Record<string, unknown> = {};
    if (row.review_config) {
      try {
        config = typeof row.review_config === 'string'
          ? JSON.parse(row.review_config)
          : row.review_config as Record<string, unknown>;
      } catch {
        config = {};
      }
    }

    res.json({ reviewConfig: config });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      logger.error('[GitHub] Review config get error:', error);
      res.status(500).json({ error: error.message });
    }
  }
});

// ─── PUT /api/workspaces/:id/github/review-config — Update review request config ──

/**
 * @swagger
 * /api/workspaces/{id}/github/review-config:
 *   put:
 *     tags: [GitHub]
 *     summary: Update review request configuration
 *     operationId: updateWorkspaceGithubReviewConfig
 *     description: Updates the review request configuration for automatic PR reviewer assignment. Supports default reviewers, team reviewers, conditional rules (tag/persona matching), and CODEOWNERS-style path rules.
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
 *               defaultReviewers:
 *                 type: array
 *                 items: { type: string }
 *                 description: GitHub usernames to always request
 *               teamReviewers:
 *                 type: array
 *                 items: { type: string }
 *                 description: GitHub team slugs to always request
 *               rules:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     condition:
 *                       type: object
 *                       properties:
 *                         field: { type: string, enum: [tag, persona] }
 *                         matches: { type: string }
 *                     reviewers: { type: array, items: { type: string } }
 *                     teamReviewers: { type: array, items: { type: string } }
 *               pathRules:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     pattern: { type: string }
 *                     reviewers: { type: array, items: { type: string } }
 *                     teamReviewers: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Review config updated
 *       404:
 *         description: No GitHub connection found
 */
router.put('/review-config', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { defaultReviewers, teamReviewers, rules, pathRules } = req.body;

    const row = await queryOne<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = $1',
      [workspaceId],
    );

    if (!row) {
      throw new NotFoundError('No GitHub connection found for this workspace');
    }

    // Validate and sanitize usernames (alphanumeric + hyphens, no @ prefix)
    const sanitizeUsername = (u: string) => u.replace(/^@/, '').trim();
    const isValidUsername = (u: string) => /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(u);

    const config: Record<string, unknown> = {};

    if (Array.isArray(defaultReviewers)) {
      config.defaultReviewers = defaultReviewers
        .map(sanitizeUsername)
        .filter((r): r is string => typeof r === 'string' && r.length > 0 && isValidUsername(r));
    }

    if (Array.isArray(teamReviewers)) {
      config.teamReviewers = teamReviewers
        .map((t: unknown) => typeof t === 'string' ? t.replace(/^@/, '').trim() : '')
        .filter((t: string) => t.length > 0);
    }

    if (Array.isArray(rules)) {
      config.rules = rules
        .filter((r: any) => r?.condition?.field && r?.condition?.matches)
        .map((r: any) => ({
          condition: {
            field: r.condition.field === 'persona' ? 'persona' : 'tag',
            matches: String(r.condition.matches),
          },
          reviewers: Array.isArray(r.reviewers)
            ? r.reviewers.map(sanitizeUsername).filter(isValidUsername)
            : [],
          teamReviewers: Array.isArray(r.teamReviewers)
            ? r.teamReviewers.map((t: string) => t.replace(/^@/, '').trim()).filter(Boolean)
            : [],
        }));
    }

    if (Array.isArray(pathRules)) {
      config.pathRules = pathRules
        .filter((r: any) => typeof r?.pattern === 'string' && r.pattern.trim().length > 0)
        .map((r: any) => ({
          pattern: r.pattern.trim(),
          reviewers: Array.isArray(r.reviewers)
            ? r.reviewers.map(sanitizeUsername).filter(isValidUsername)
            : [],
          teamReviewers: Array.isArray(r.teamReviewers)
            ? r.teamReviewers.map((t: string) => t.replace(/^@/, '').trim()).filter(Boolean)
            : [],
        }));
    }

    await execute(
      'UPDATE workspace_github_webhooks SET review_config = $1 WHERE workspace_id = $2',
      [JSON.stringify(config), workspaceId],
    );

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_review_config_updated', $1, $2)",
      [workspaceId, JSON.stringify(config)],
    );

    res.json({ reviewConfig: config });
  } catch (error: any) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      logger.error('[GitHub] Review config update error:', error);
      res.status(500).json({ error: error.message });
    }
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
      return;
    }

    const yaml = generateActionsYaml(workspace.id, workspace.label);

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="rorca-pipeline.yml"`);
    res.send(yaml);
  } catch (error: any) {
    logger.error('[GitHub] Actions YAML generation error:', error);
    res.status(500).json({ error: error.message });
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

async function getOAuthToken(): Promise<string | null> {
  const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
  if (!userRow) return null;
  const conn = await queryOne<{ encrypted_token: string }>(
    'SELECT encrypted_token FROM github_connections WHERE user_id = $1',
    [userRow.id]
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
    const token = await getOAuthToken();
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
    logger.error('[GitHub] Repos error:', error);
    res.status(500).json({ error: error.message });
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

    const token = await getOAuthToken();
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
    logger.error('[GitHub] Issues error:', error);
    res.status(500).json({ error: error.message });
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
router.post('/import-issues', async (req: Request, res: Response) => {
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

    const token = await getOAuthToken();
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
    logger.error('[GitHub] Import issues error:', error);
    if (error.statusCode) {
      res.status(error.statusCode).json({ error: error.message });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
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
