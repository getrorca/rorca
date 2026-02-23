import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { decryptToken } from './auth';
import { verifyWebhookSignature } from './workspace-github';

const router = Router();

interface GithubWebhookRow {
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  webhook_id: number | null;
  encrypted_webhook_secret: string;
  last_webhook_at: string | null;
  created_at: string;
}

// ─── POST /api/webhooks/github — Receive GitHub webhook events ───────────────
// This route is PUBLIC (no auth) — GitHub sends webhooks without bearer tokens.
// Signature verification via HMAC-SHA256 ensures authenticity.

router.post('/github', (req: Request, res: Response) => {
  try {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    if (!signature || !event) {
      res.status(400).json({ error: 'Missing GitHub webhook headers' });
      return;
    }

    // GitHub sends the repo full_name as owner/repo in the payload
    const payload = req.body;
    const repoFullName = payload?.repository?.full_name as string | undefined;

    if (!repoFullName) {
      res.status(400).json({ error: 'Missing repository info in payload' });
      return;
    }

    const [repoOwner, repoName] = repoFullName.split('/');

    // Look up the workspace connection by repo owner + name
    const row = db.prepare(
      'SELECT * FROM workspace_github_webhooks WHERE repo_owner = ? AND repo_name = ?'
    ).get(repoOwner, repoName) as GithubWebhookRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'No workspace connected to this repository' });
      return;
    }

    // Verify webhook signature
    const secret = decryptToken(row.encrypted_webhook_secret);
    const rawBody = JSON.stringify(req.body);
    if (!verifyWebhookSignature(rawBody, signature, secret)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }

    // Update last_webhook_at timestamp
    db.prepare(
      "UPDATE workspace_github_webhooks SET last_webhook_at = datetime('now') WHERE workspace_id = ?"
    ).run(row.workspace_id);

    // Emit WAL event for the webhook
    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_webhook', ?, ?)"
    ).run(row.workspace_id, JSON.stringify({
      event,
      deliveryId,
      repo: repoFullName,
      action: payload.action || null,
      ref: payload.ref || null,
      sender: payload.sender?.login || null,
    }));

    console.log(`[Webhook] GitHub ${event} from ${repoFullName} for workspace ${row.workspace_id}`);

    res.json({ ok: true });
  } catch (error: any) {
    console.error('[Webhook] GitHub error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
