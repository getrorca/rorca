import { Router, Request, Response } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import { db } from '../db/index';
import { encryptToken, decryptToken } from './auth';

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
 *         description: Connection status returned successfully. Returns `{ connected: false }` if no GitHub connection exists, or full connection details if connected.
 *       404:
 *         description: Workspace not found
 *       500:
 *         description: Internal server error
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const row = db.prepare(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId) as GithubWebhookRow | undefined;

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
        reviewers: JSON.parse(row.auto_pr_reviewers || '[]') as string[],
      },
    });
  } catch (error: any) {
    console.error('[GitHub] Status error:', error);
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
      res.status(400).json({ error: 'Missing required fields: repoOwner, repoName, githubToken' });
      return;
    }

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Check if already connected
    const existing = db.prepare(
      'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId);
    if (existing) {
      res.status(409).json({ error: 'GitHub already connected for this workspace. Disconnect first.' });
      return;
    }

    // Generate webhook secret
    const webhookSecret = randomBytes(32).toString('hex');

    // Determine the webhook URL — use RORCA_BASE_URL env or fall back to localhost
    const baseUrl = process.env.RORCA_BASE_URL || 'http://localhost:3030';
    const webhookUrl = `${baseUrl}/api/webhooks/github`;

    // Create webhook via GitHub API
    const ghRes = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/hooks`, {
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
    });

    if (!ghRes.ok) {
      const ghBody = await ghRes.text();
      console.error('[GitHub] Webhook creation failed:', ghRes.status, ghBody);
      res.status(ghRes.status === 404 ? 404 : 502).json({
        error: `GitHub API error (${ghRes.status}): ${ghBody}`,
      });
      return;
    }

    const ghData = await ghRes.json() as { id: number };

    // Store connection
    db.prepare(
      `INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
       VALUES (?, ?, ?, ?, ?)`
    ).run(workspaceId, repoOwner, repoName, ghData.id, encryptToken(webhookSecret));

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_connected', ?, ?)"
    ).run(workspaceId, JSON.stringify({ repoOwner, repoName, webhookId: ghData.id }));

    res.status(201).json({
      connected: true,
      repoOwner,
      repoName,
      webhookId: ghData.id,
    });
  } catch (error: any) {
    console.error('[GitHub] Connect error:', error);
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
      res.status(400).json({ error: 'Missing required field: githubToken' });
      return;
    }

    const row = db.prepare(
      'SELECT * FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId) as GithubWebhookRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'No GitHub connection found for this workspace' });
      return;
    }

    // Delete webhook from GitHub if we have a webhook ID
    if (row.webhook_id) {
      const ghRes = await fetch(
        `https://api.github.com/repos/${row.repo_owner}/${row.repo_name}/hooks/${row.webhook_id}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        }
      );

      // 404 = webhook already deleted on GitHub side — that's fine
      if (!ghRes.ok && ghRes.status !== 404) {
        const ghBody = await ghRes.text();
        console.error('[GitHub] Webhook deletion failed:', ghRes.status, ghBody);
        res.status(502).json({
          error: `GitHub API error (${ghRes.status}): ${ghBody}`,
        });
        return;
      }
    }

    // Remove from DB
    db.prepare('DELETE FROM workspace_github_webhooks WHERE workspace_id = ?').run(workspaceId);

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_disconnected', ?, ?)"
    ).run(workspaceId, JSON.stringify({ repoOwner: row.repo_owner, repoName: row.repo_name }));

    res.json({ connected: false });
  } catch (error: any) {
    console.error('[GitHub] Disconnect error:', error);
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
 *         description: Account info returned successfully. Returns `{ connected: false }` if no user or GitHub connection exists, or full account details if connected.
 *       500:
 *         description: Internal server error
 */
router.get('/account', (req: Request, res: Response) => {
  try {
    // Get first user's GitHub connection (auth is bypassed — single-user local tool)
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined)?.id;
    if (!userId) {
      res.json({ connected: false });
      return;
    }

    const conn = db.prepare(
      'SELECT gc.*, u.avatar_url FROM github_connections gc JOIN users u ON gc.user_id = u.id WHERE gc.user_id = ?'
    ).get(userId) as (GitHubConnectionRow & { avatar_url: string | null }) | undefined;

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
    console.error('[GitHub] Account error:', error);
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
 *         description: Test result returned. Returns `{ valid: true, username }` on success, or `{ valid: false, error }` if no connection exists or token is invalid.
 */
router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined)?.id;
    if (!userId) {
      res.json({ valid: false, error: 'No user configured' });
      return;
    }

    const conn = db.prepare(
      'SELECT encrypted_token, github_username FROM github_connections WHERE user_id = ?'
    ).get(userId) as Pick<GitHubConnectionRow, 'encrypted_token' | 'github_username'> | undefined;

    if (!conn) {
      res.json({ valid: false, error: 'No GitHub connection found' });
      return;
    }

    const token = decryptToken(conn.encrypted_token);

    const ghRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (ghRes.ok) {
      const user = await ghRes.json() as { login: string; id: number };
      res.json({ valid: true, username: user.login });
    } else {
      res.json({ valid: false, error: `GitHub API returned ${ghRes.status}` });
    }
  } catch (error: any) {
    console.error('[GitHub] Test connection error:', error);
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
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string } | undefined)?.id;
    if (!userId) {
      res.status(404).json({ error: 'No user configured' });
      return;
    }

    const conn = db.prepare(
      'SELECT id, encrypted_token FROM github_connections WHERE user_id = ?'
    ).get(userId) as Pick<GitHubConnectionRow, 'id' | 'encrypted_token'> | undefined;

    if (!conn) {
      res.status(404).json({ error: 'No GitHub connection found' });
      return;
    }

    // Attempt to revoke the token via GitHub API (best-effort)
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;
    if (clientId && clientSecret) {
      try {
        const token = decryptToken(conn.encrypted_token);
        await fetch(`https://api.github.com/applications/${clientId}/token`, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ access_token: token }),
        });
      } catch (revokeErr) {
        console.warn('[GitHub] Token revocation failed (proceeding with local disconnect):', revokeErr);
      }
    }

    // Remove connection from DB
    db.prepare('DELETE FROM github_connections WHERE id = ?').run(conn.id);
    db.prepare("UPDATE users SET github_id = NULL, updated_at = datetime('now') WHERE id = ?").run(userId);

    // Emit WAL event
    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_oauth_disconnected', '', ?)"
    ).run(JSON.stringify({ userId }));

    res.json({ disconnected: true });
  } catch (error: any) {
    console.error('[GitHub] Disconnect OAuth error:', error);
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
router.put('/auto-pr', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { enabled, targetBranch, reviewers } = req.body;

    const row = db.prepare(
      'SELECT workspace_id FROM workspace_github_webhooks WHERE workspace_id = ?'
    ).get(workspaceId);

    if (!row) {
      res.status(404).json({ error: 'No GitHub connection found for this workspace' });
      return;
    }

    db.prepare(
      `UPDATE workspace_github_webhooks
       SET auto_pr_enabled = ?,
           auto_pr_target_branch = ?,
           auto_pr_reviewers = ?
       WHERE workspace_id = ?`
    ).run(
      enabled ? 1 : 0,
      targetBranch || 'main',
      JSON.stringify(Array.isArray(reviewers) ? reviewers : []),
      workspaceId,
    );

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_auto_pr_updated', ?, ?)"
    ).run(workspaceId, JSON.stringify({ enabled, targetBranch, reviewers }));

    res.json({
      enabled: !!enabled,
      targetBranch: targetBranch || 'main',
      reviewers: Array.isArray(reviewers) ? reviewers : [],
    });
  } catch (error: any) {
    console.error('[GitHub] Auto-PR update error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/actions-yaml', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = db.prepare('SELECT id, label, path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { id: string; label: string; path: string } | undefined;
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const yaml = generateActionsYaml(workspace.id, workspace.label);

    res.setHeader('Content-Type', 'application/x-yaml');
    res.setHeader('Content-Disposition', `attachment; filename="rorca-pipeline.yml"`);
    res.send(yaml);
  } catch (error: any) {
    console.error('[GitHub] Actions YAML generation error:', error);
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

export function getWebhookSecret(workspaceId: string): string | null {
  const row = db.prepare(
    'SELECT encrypted_webhook_secret FROM workspace_github_webhooks WHERE workspace_id = ?'
  ).get(workspaceId) as Pick<GithubWebhookRow, 'encrypted_webhook_secret'> | undefined;

  if (!row) return null;
  return decryptToken(row.encrypted_webhook_secret);
}

export default router;
