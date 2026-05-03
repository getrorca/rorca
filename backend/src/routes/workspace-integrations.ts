/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { query, queryOne } from '../db/index';
import { NotFoundError } from '../lib/errors';
import { logger } from '../lib/logger';

const router = Router({ mergeParams: true });

interface IntegrationStatus {
  provider: string;
  status: 'connected' | 'disconnected' | 'error' | 'coming_soon';
  connectedAt: string | null;
  username: string | null;
  avatarUrl: string | null;
  orgName: string | null;
}

interface GithubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  webhook_id: number | null;
  last_webhook_at: string | null;
  created_at: string;
}

interface GitHubConnectionRow {
  github_username: string | null;
  avatar_url: string | null;
  created_at: string;
}

// ─── GET /api/workspaces/:id/integrations ─────────────────────────────────────

/**
 * @swagger
 * /api/workspaces/{id}/integrations:
 *   get:
 *     tags: [Integrations]
 *     summary: Get integration statuses for a workspace
 *     operationId: getWorkspaceIntegrations
 *     description: Returns the connection status for all supported integrations (GitHub, Linear, Vercel, Slack). GitHub status is fetched from the database; Linear, Vercel, and Slack are always returned as coming_soon.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Integration statuses returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   provider:
 *                     type: string
 *                     example: github
 *                   status:
 *                     type: string
 *                     enum: [connected, disconnected, error, coming_soon]
 *                   connectedAt:
 *                     type: string
 *                     nullable: true
 *                   username:
 *                     type: string
 *                     nullable: true
 *                   avatarUrl:
 *                     type: string
 *                     nullable: true
 *                   orgName:
 *                     type: string
 *                     nullable: true
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Internal server error
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = await queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    // GitHub: check workspace webhook + OAuth account
    let githubStatus: IntegrationStatus = {
      provider: 'github',
      status: 'disconnected',
      connectedAt: null,
      username: null,
      avatarUrl: null,
      orgName: null,
    };

    try {
      // Check OAuth connection first (github_connections table)
      const oauthRow = await queryOne<GitHubConnectionRow>(
        `SELECT gc.github_username, u.avatar_url, gc.created_at
         FROM github_connections gc
         JOIN users u ON gc.user_id = u.id
         ORDER BY gc.created_at DESC LIMIT 1`,
        [],
      );

      // Also check workspace webhook connection
      const webhookRow = await queryOne<GithubWebhookRow>(
        'SELECT workspace_id, repo_owner, repo_name, webhook_id, last_webhook_at, created_at FROM workspace_github_webhooks WHERE workspace_id = $1',
        [workspaceId],
      );

      if (oauthRow || webhookRow) {
        const username = oauthRow?.github_username ?? null;
        const avatarUrl =
          oauthRow?.avatar_url ||
          (username ? `https://github.com/${username}.png` : null);
        const connectedAt = oauthRow?.created_at ?? webhookRow?.created_at ?? null;

        githubStatus = {
          provider: 'github',
          status: 'connected',
          connectedAt,
          username,
          avatarUrl,
          orgName: webhookRow?.repo_owner ?? null,
        };
      }
    } catch (ghErr) {
      logger.warn({ err: ghErr }, '[Integrations] GitHub status check failed');
      githubStatus.status = 'error';
    }

    const integrations: IntegrationStatus[] = [
      githubStatus,
      {
        provider: 'linear',
        status: 'coming_soon',
        connectedAt: null,
        username: null,
        avatarUrl: null,
        orgName: null,
      },
      {
        provider: 'vercel',
        status: 'coming_soon',
        connectedAt: null,
        username: null,
        avatarUrl: null,
        orgName: null,
      },
      {
        provider: 'slack',
        status: 'coming_soon',
        connectedAt: null,
        username: null,
        avatarUrl: null,
        orgName: null,
      },
    ];

    res.json(integrations);
  } catch (error: unknown) {
    logger.error({ err: error }, '[Integrations] Status fetch error');
    throw error;
  }
});

// ─── GET /api/workspaces/:id/integrations/health ────────────────────────────

interface IntegrationHealthRow {
  provider: string;
  status: string;
  error_rate: string | number | null;
  rate_limit_remaining: number | null;
  rate_limit_max: number | null;
  consecutive_failures: number;
  last_success: string | null;
  webhook_success_rate: string | number | null;
  last_error: string | null;
  checked_at: string;
}

interface IntegrationHealthTrendRow {
  provider: string;
  rate_limit_remaining: number | null;
  rate_limit_max: number | null;
  error_rate: string | number | null;
  checked_at: string;
}

/**
 * @swagger
 * /api/workspaces/{id}/integrations/health:
 *   get:
 *     tags: [Integrations]
 *     summary: Get integration health status for a workspace
 *     operationId: getWorkspaceIntegrationHealth
 *     description: Returns per-integration health status with error rate, rate limit usage, consecutive failures, and 24h trend data. Health snapshots are populated by a pg-boss cron job every 5 minutes.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Integration health statuses
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 integrations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       provider:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [healthy, degraded, disconnected]
 *                       error_rate:
 *                         type: number
 *                       rate_limit_remaining:
 *                         type: integer
 *                       rate_limit_max:
 *                         type: integer
 *                       last_success:
 *                         type: string
 *                         nullable: true
 *                       consecutive_failures:
 *                         type: integer
 *                       webhook_success_rate:
 *                         type: number
 *                       last_error:
 *                         type: string
 *                         nullable: true
 *                       checked_at:
 *                         type: string
 *                       trend:
 *                         type: array
 *                         items:
 *                           type: object
 *       404:
 *         description: Workspace not found
 */
router.get('/health', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = await queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
    }

    // Get latest health snapshot per provider using DISTINCT ON
    const latestRows = await query<IntegrationHealthRow>(
      `SELECT DISTINCT ON (provider)
         provider, status, error_rate, rate_limit_remaining, rate_limit_max,
         consecutive_failures, last_success, webhook_success_rate, last_error, checked_at
       FROM integration_health
       WHERE workspace_id = $1
       ORDER BY provider, checked_at DESC`,
      [workspaceId],
    );

    // Get 24h trend data per provider
    const trendRows = await query<IntegrationHealthTrendRow>(
      `SELECT provider, rate_limit_remaining, rate_limit_max, error_rate, checked_at
       FROM integration_health
       WHERE workspace_id = $1 AND checked_at > NOW() - INTERVAL '24 hours'
       ORDER BY provider, checked_at ASC`,
      [workspaceId],
    );

    // Group trend data by provider
    const trendByProvider = new Map<string, IntegrationHealthTrendRow[]>();
    for (const row of trendRows) {
      const arr = trendByProvider.get(row.provider) ?? [];
      arr.push(row);
      trendByProvider.set(row.provider, arr);
    }

    const integrations = latestRows.map((row) => ({
      provider: row.provider,
      status: row.status,
      error_rate: Number(row.error_rate ?? 0),
      rate_limit_remaining: row.rate_limit_remaining,
      rate_limit_max: row.rate_limit_max,
      consecutive_failures: row.consecutive_failures,
      last_success: row.last_success,
      webhook_success_rate: Number(row.webhook_success_rate ?? 1),
      last_error: row.last_error,
      checked_at: row.checked_at,
      trend: (trendByProvider.get(row.provider) ?? []).map((t) => ({
        rate_limit_remaining: t.rate_limit_remaining,
        rate_limit_max: t.rate_limit_max,
        error_rate: Number(t.error_rate ?? 0),
        checked_at: t.checked_at,
      })),
    }));

    res.json({ integrations });
  } catch (error: unknown) {
    logger.error({ err: error }, '[Integrations] Health fetch error');
    throw error;
  }
});

export default router;
