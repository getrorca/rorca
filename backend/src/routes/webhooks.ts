/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { queryOne, execute } from '../db/index';
import { decryptToken } from '../lib/auth-utils';
import { verifyWebhookSignature } from './workspace-github';
import { logger } from '../lib/logger';
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { getWebhookRouter, type WebhookProvider } from '../lib/webhook-router';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { insertAuditEntry } from './integration-audit-log';

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

// ─── Legacy event handler registry ──────────────────────────────────────────
// Preserved for backward compatibility with webhook-handlers.ts registrations.
// These handlers are bridged into the WebhookRouter during registerWebhookHandlers().

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

/** Dispatch to all registered legacy handlers for the given event. */
async function dispatchLegacyHandlers(
  event: string,
  payload: Record<string, any>,
  workspaceId: string,
): Promise<void> {
  const handlers = eventHandlers.get(event) || [];
  for (const handler of handlers) {
    try {
      await handler(payload, event, workspaceId);
    } catch (err) {
      logger.error({ err }, `[Webhook] Legacy handler error for '${event}'`);
    }
  }
}

// ─── Valid providers ────────────────────────────────────────────────────────

const VALID_PROVIDERS = new Set<WebhookProvider>(['github', 'linear', 'vercel', 'slack']);

function isValidProvider(provider: string): provider is WebhookProvider {
  return VALID_PROVIDERS.has(provider as WebhookProvider);
}

// ─── POST /api/webhooks/github — GitHub webhook receiver ────────────────────

/**
 * @swagger
 * /api/webhooks/github:
 *   post:
 *     tags: [Webhooks]
 *     summary: Receive GitHub webhook events
 *     operationId: receiveGithubWebhook
 *     description: Public endpoint that receives GitHub webhook events. Verifies HMAC-SHA256 signature via X-Hub-Signature-256 header, deduplicates via X-GitHub-Delivery, responds immediately with 200, then dispatches to registered handlers with retry + DLQ.
 *     parameters:
 *       - in: header
 *         name: x-hub-signature-256
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: x-github-event
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: x-github-delivery
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               repository:
 *                 type: object
 *                 properties:
 *                   full_name: { type: string }
 *     responses:
 *       200:
 *         description: Webhook received
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 status: { type: string }
 *       400:
 *         description: Missing webhook headers or raw body
 *       401:
 *         description: Invalid webhook signature
 *       404:
 *         description: No workspace connected to this repository
 */
router.post('/github', async (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = req.headers['x-github-event'] as string | undefined;
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;

  if (!signature || !event) {
    throw new AuthError('Invalid webhook signature');
  }

  // Use the raw body captured by the verify callback in express.json().
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody) {
    throw new ValidationError('Missing raw body for signature verification');
  }

  // GitHub sends the repo full_name as owner/repo in the payload
  const payload = req.body;
  const repoFullName = payload?.repository?.full_name as string | undefined;

  if (!repoFullName) {
    throw new ValidationError('Missing repository info in payload');
  }

  const [repoOwner, repoName] = repoFullName.split('/');

  // Look up the workspace connection by repo owner + name
  const row = await queryOne<GithubWebhookRow>(
    'SELECT * FROM workspace_github_webhooks WHERE repo_owner = $1 AND repo_name = $2',
    [repoOwner, repoName]
  );

  if (!row) {
    throw new NotFoundError('No workspace connected to this repository');
  }

  if (!row.encrypted_webhook_secret) {
    throw new ForbiddenError('Webhook secret not configured');
  }

  // Verify webhook signature using the raw body
  const secret = decryptToken(row.encrypted_webhook_secret);
  if (!verifyWebhookSignature(rawBody.toString('utf8'), signature, secret)) {
    throw new AuthError('Invalid webhook signature');
  }

  // ── Deduplication check ──
  const webhookRouter = getWebhookRouter();
  if (deliveryId) {
    const existingStatus = await webhookRouter.checkDedup('github', deliveryId);
    if (existingStatus) {
      // Already processed or in-progress — acknowledge without re-processing
      res.json({ ok: true, status: 'duplicate' });
      return;
    }
    // Mark as processing
    await webhookRouter.recordDelivery('github', deliveryId, event, 'processing', row.workspace_id);
  }

  // ── Signature valid — respond 200 immediately, process async ──
  res.json({ ok: true, status: 'processing' });

  insertAuditEntry({
    workspaceId: row.workspace_id,
    provider: 'github',
    action: 'webhook_received',
    actorType: 'webhook',
    details: {
      webhook_event: event,
      delivery_id: deliveryId,
      repo: repoFullName,
      action: payload.action || null,
      sender: payload.sender?.login || null,
    },
  });

  // Async processing via setImmediate to avoid blocking the response
  setImmediate(async () => {
    try {
      // Update last_webhook_at timestamp
      await execute(
        "UPDATE workspace_github_webhooks SET last_webhook_at = NOW() WHERE workspace_id = $1",
        [row.workspace_id]
      );

      // Log every received webhook to wal_events
      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_webhook', $1, $2)",
        [row.workspace_id, JSON.stringify({
          event,
          deliveryId,
          repo: repoFullName,
          action: payload.action || null,
          ref: payload.ref || null,
          sender: payload.sender?.login || null,
        })]
      );

      logger.info(`[Webhook] GitHub ${event} from ${repoFullName} for workspace ${row.workspace_id}`);

      // Dispatch via WebhookRouter (retry + DLQ) for new-style handlers
      const meta = { deliveryId, workspaceId: row.workspace_id };
      await webhookRouter.dispatch('github', event, payload, meta);

      // Also dispatch legacy handlers for backward compatibility
      await dispatchLegacyHandlers(event, payload, row.workspace_id);

      // Mark delivery as completed
      if (deliveryId) {
        await webhookRouter.recordDelivery('github', deliveryId, event, 'completed', row.workspace_id);
      }

      insertAuditEntry({
        workspaceId: row.workspace_id,
        provider: 'github',
        action: 'webhook_processed',
        actorType: 'webhook',
        details: {
          webhook_event: event,
          delivery_id: deliveryId,
          repo: repoFullName,
        },
      });
    } catch (err) {
      logger.error({ err }, '[Webhook] Async processing error');
      if (deliveryId) {
        await webhookRouter.recordDelivery('github', deliveryId, event, 'failed', row.workspace_id).catch(() => {});
      }

      insertAuditEntry({
        workspaceId: row.workspace_id,
        provider: 'github',
        action: 'webhook_failed',
        actorType: 'webhook',
        details: {
          webhook_event: event,
          delivery_id: deliveryId,
          repo: repoFullName,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
});

// ─── GET /api/webhooks/dlq — List dead letter queue ─────────────────────────
// IMPORTANT: DLQ routes MUST be defined before the generic /:provider route
// to prevent Express from matching "dlq" as a provider name.

interface DlqRow {
  id: number;
  provider: string;
  event_type: string;
  payload: Record<string, any>;
  error: string | null;
  attempts: number;
  delivery_id: string | null;
  workspace_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * @swagger
 * /api/webhooks/dlq:
 *   get:
 *     tags: [Webhooks]
 *     summary: List webhook dead letter queue events
 *     operationId: listWebhookDlq
 *     description: Returns paginated list of failed webhook events from the dead letter queue. Supports filtering by provider and resolved status.
 *     parameters:
 *       - in: query
 *         name: provider
 *         schema: { type: string, enum: [github, linear, vercel, slack] }
 *       - in: query
 *         name: resolved
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 250 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Paginated DLQ entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       provider: { type: string }
 *                       event_type: { type: string }
 *                       payload: { type: object }
 *                       error: { type: string }
 *                       attempts: { type: integer }
 *                       delivery_id: { type: string }
 *                       created_at: { type: string }
 *                       resolved_at: { type: string }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 */
router.get('/dlq', async (req: Request, res: Response) => {
  const pagination = parsePaginationParams(req);
  const providerFilter = req.query.provider as string | undefined;
  const resolvedFilter = req.query.resolved as string | undefined;

  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];

  if (providerFilter && isValidProvider(providerFilter)) {
    params.push(providerFilter);
    conditions.push(`provider = $${params.length}`);
  }

  if (resolvedFilter === 'true') {
    conditions.push('resolved_at IS NOT NULL');
  } else if (resolvedFilter === 'false') {
    conditions.push('resolved_at IS NULL');
  }

  const where = conditions.join(' AND ');

  const result = await paginateQuery<DlqRow>({
    query: `SELECT * FROM webhook_dlq WHERE ${where}`,
    countQuery: `SELECT COUNT(*)::int AS total FROM webhook_dlq WHERE ${where}`,
    params,
    pagination,
    orderBy: 'created_at DESC',
  });

  res.json(result);
});

// ─── POST /api/webhooks/dlq/:id/retry — Replay a DLQ event ─────────────────

/**
 * @swagger
 * /api/webhooks/dlq/{id}/retry:
 *   post:
 *     tags: [Webhooks]
 *     summary: Retry a webhook DLQ event
 *     operationId: retryWebhookDlqEvent
 *     description: Replays a dead letter queue event through its registered handlers. If handlers succeed, the DLQ entry is marked as resolved.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Retry result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 error: { type: string }
 *       404:
 *         description: DLQ entry not found
 */
router.post('/dlq/:id/retry', async (req: Request, res: Response) => {
  const dlqId = parseInt(String(req.params.id), 10);
  if (isNaN(dlqId)) {
    throw new ValidationError('Invalid DLQ entry ID');
  }

  const webhookRouter = getWebhookRouter();
  const result = await webhookRouter.replayDlqEvent(dlqId);

  if (!result.success && result.error === 'DLQ entry not found') {
    throw new NotFoundError('DLQ entry', String(dlqId));
  }

  res.json({ ok: result.success, error: result.error });
});

// ─── POST /api/webhooks/:provider — Generic webhook receiver ────────────────

/**
 * @swagger
 * /api/webhooks/{provider}:
 *   post:
 *     tags: [Webhooks]
 *     summary: Receive webhook events for a provider
 *     operationId: receiveProviderWebhook
 *     description: Generic webhook receiver for non-GitHub providers (linear, vercel, slack). Dispatches to registered WebhookRouter handlers with retry + DLQ. Signature verification delegated to provider-specific verifier if registered.
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [linear, vercel, slack]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Webhook received
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 status: { type: string }
 *       400:
 *         description: Invalid provider
 *       401:
 *         description: Signature verification failed
 */
router.post('/:provider', async (req: Request, res: Response) => {
  const provider = String(req.params.provider);

  // Skip github — handled by the dedicated route above
  if (provider === 'github') {
    throw new ValidationError('Use POST /api/webhooks/github for GitHub webhooks');
  }

  if (!isValidProvider(provider)) {
    throw new ValidationError(`Invalid webhook provider: ${provider}. Supported: ${Array.from(VALID_PROVIDERS).join(', ')}`);
  }

  const webhookRouter = getWebhookRouter();
  const rawBody: Buffer | undefined = (req as any).rawBody;
  const payload = req.body;

  // Extract provider-specific event type and delivery ID
  const eventType = extractEventType(provider, req);
  const deliveryId = extractDeliveryId(provider, req);

  // Run signature verifier if one is registered for this provider
  const verifier = webhookRouter.getVerifier(provider);
  if (verifier) {
    const signature = extractSignature(provider, req);
    if (!signature) {
      throw new AuthError('Invalid webhook signature');
    }
    if (!rawBody) {
      throw new ValidationError('Missing raw body for signature verification');
    }
    const meta = { deliveryId, workspaceId: undefined };
    const valid = await verifier(rawBody, signature, meta);
    if (!valid) {
      throw new AuthError('Invalid webhook signature');
    }
  }

  // Deduplication check
  if (deliveryId) {
    const existingStatus = await webhookRouter.checkDedup(provider, deliveryId);
    if (existingStatus) {
      res.json({ ok: true, status: 'duplicate' });
      return;
    }
    await webhookRouter.recordDelivery(provider, deliveryId, eventType, 'processing');
  }

  // Respond 200 immediately
  res.json({ ok: true, status: webhookRouter.hasHandlers(provider, eventType) ? 'processing' : 'unhandled' });

  // Async dispatch
  setImmediate(async () => {
    try {
      const meta = { deliveryId };
      await webhookRouter.dispatch(provider, eventType, payload, meta);

      if (deliveryId) {
        await webhookRouter.recordDelivery(provider, deliveryId, eventType, 'completed');
      }
    } catch (err) {
      logger.error({ err, provider, eventType }, '[Webhook] Generic async processing error');
      if (deliveryId) {
        await webhookRouter.recordDelivery(provider, deliveryId, eventType, 'failed').catch(() => {});
      }
    }
  });
});

// ─── Provider-specific header extraction ────────────────────────────────────

function extractEventType(provider: WebhookProvider, req: Request): string {
  switch (provider) {
    case 'linear':
      return (req.headers['linear-event'] as string) || (req.body?.type as string) || 'unknown';
    case 'vercel':
      return (req.headers['x-vercel-event'] as string) || (req.body?.type as string) || 'unknown';
    case 'slack':
      return (req.body?.event?.type as string) || (req.body?.type as string) || 'unknown';
    default:
      return (req.body?.type as string) || 'unknown';
  }
}

function extractDeliveryId(provider: WebhookProvider, req: Request): string | undefined {
  switch (provider) {
    case 'linear':
      return req.headers['linear-delivery'] as string | undefined;
    case 'vercel':
      return req.headers['x-vercel-delivery'] as string | undefined;
    case 'slack':
      return req.headers['x-slack-request-timestamp'] as string | undefined;
    default:
      return undefined;
  }
}

function extractSignature(provider: WebhookProvider, req: Request): string | undefined {
  switch (provider) {
    case 'linear':
      return req.headers['linear-signature'] as string | undefined;
    case 'vercel':
      return req.headers['x-vercel-signature'] as string | undefined;
    case 'slack':
      return req.headers['x-slack-signature'] as string | undefined;
    default:
      return undefined;
  }
}

export default router;
