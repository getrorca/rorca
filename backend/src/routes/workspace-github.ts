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
}

// ─── GET /api/workspaces/:id/github — Connection status ──────────────────────

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
    });
  } catch (error: any) {
    console.error('[GitHub] Status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/workspaces/:id/github/connect — Create webhook + store ────────

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

    // Determine the webhook URL — use RORCHA_BASE_URL env or fall back to localhost
    const baseUrl = process.env.RORCHA_BASE_URL || 'http://localhost:3030';
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
