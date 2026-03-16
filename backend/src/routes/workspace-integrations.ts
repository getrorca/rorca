import { Router, Request, Response } from 'express';
import { queryOne } from '../db/index';
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
      const webhookRow = await queryOne<GithubWebhookRow>(
        'SELECT workspace_id, repo_owner, repo_name, webhook_id, last_webhook_at, created_at FROM workspace_github_webhooks WHERE workspace_id = $1',
        [workspaceId],
      );

      if (webhookRow) {
        // Has workspace connection — fetch OAuth account info for username/avatar
        const userRow = await queryOne<{ id: string }>('SELECT id FROM users LIMIT 1');
        let username: string | null = null;
        let avatarUrl: string | null = null;
        let connectedAt: string = webhookRow.created_at;

        if (userRow) {
          const connRow = await queryOne<GitHubConnectionRow>(
            `SELECT gc.github_username, u.avatar_url, gc.created_at
             FROM github_connections gc
             JOIN users u ON gc.user_id = u.id
             WHERE gc.user_id = $1`,
            [userRow.id],
          );
          if (connRow) {
            username = connRow.github_username;
            avatarUrl =
              connRow.avatar_url ||
              (connRow.github_username
                ? `https://github.com/${connRow.github_username}.png`
                : null);
            connectedAt = connRow.created_at;
          }
        }

        githubStatus = {
          provider: 'github',
          status: 'connected',
          connectedAt,
          username,
          avatarUrl,
          orgName: webhookRow.repo_owner,
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

export default router;
