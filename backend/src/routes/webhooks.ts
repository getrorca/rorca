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

// ─── Event handler registry ─────────────────────────────────────────────────
// Each handler receives the parsed payload, the event name, and the workspace ID.
// Handlers run asynchronously after the 200 response has already been sent.

export type WebhookHandler = (
  payload: Record<string, any>,
  event: string,
  workspaceId: string,
) => void | Promise<void>;

const eventHandlers = new Map<string, WebhookHandler[]>();

/** Register a handler for a specific GitHub event (e.g. 'push', 'pull_request'). */
export function onGithubEvent(event: string, handler: WebhookHandler): void {
  const existing = eventHandlers.get(event) || [];
  existing.push(handler);
  eventHandlers.set(event, existing);
}

/** Dispatch to all registered handlers for the given event. */
async function dispatchEvent(
  event: string,
  payload: Record<string, any>,
  workspaceId: string,
): Promise<void> {
  const handlers = eventHandlers.get(event) || [];
  for (const handler of handlers) {
    try {
      await handler(payload, event, workspaceId);
    } catch (err) {
      console.error(`[Webhook] Handler error for '${event}':`, err);
    }
  }
}

// ─── POST /api/webhooks/github — Receive GitHub webhook events ───────────────
// This route is PUBLIC (no auth) — GitHub sends webhooks without bearer tokens.
// Signature verification via HMAC-SHA256 ensures authenticity.
// Returns 200 immediately; processing happens asynchronously.

router.post('/github', (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = req.headers['x-github-event'] as string | undefined;
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;

  if (!signature || !event) {
    res.status(400).json({ error: 'Missing GitHub webhook headers' });
    return;
  }

  // Use the raw body captured by the verify callback in express.json().
  // This is the exact bytes GitHub used to compute its HMAC — not re-serialized JSON.
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: 'Missing raw body for signature verification' });
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

  // Verify webhook signature using the raw body
  const secret = decryptToken(row.encrypted_webhook_secret);
  if (!verifyWebhookSignature(rawBody.toString('utf8'), signature, secret)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  // ── Signature valid — respond 200 immediately, process async ──
  res.json({ ok: true });

  // Async processing via setImmediate to avoid blocking the response
  setImmediate(async () => {
    try {
      // Update last_webhook_at timestamp
      db.prepare(
        "UPDATE workspace_github_webhooks SET last_webhook_at = datetime('now') WHERE workspace_id = ?"
      ).run(row.workspace_id);

      // Log every received webhook to wal_events
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

      // Dispatch to event-specific handlers
      await dispatchEvent(event, payload, row.workspace_id);
    } catch (err) {
      console.error('[Webhook] Async processing error:', err);
    }
  });
});

export default router;
