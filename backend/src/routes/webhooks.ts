/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { queryOne, execute } from '../db/index';
import { decryptToken, LOCAL_ADMIN } from '../lib/auth-utils';
import { getIntegrationSecret } from '../lib/integration-vault';
import { verifyWebhookSignature } from './workspace-github';
import { logger } from '../lib/logger';
import { AdminRequiredError, AuthError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import {
  getWebhookRouter,
  webhookPayloadSha256,
  type VerifiedWebhookDelivery,
  type WebhookProvider,
} from '../lib/webhook-router';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { insertAuditEntry } from './integration-audit-log';
import { requireProviderMutationAuthority } from '../lib/provider-mutation-authority';

export const webhookCallbackRouter = Router({ strict: true, caseSensitive: true });
export const webhookAdminRouter = Router({ strict: true, caseSensitive: true });

interface GithubWebhookAuthority {
  source: 'github-app' | 'legacy-repository-webhook';
  workspace_id: string;
  repo_owner: string;
  repo_name: string;
  webhook_id: number | null;
  encrypted_webhook_secret?: string;
  webhook_secret_id?: string;
  installation_id?: number | string;
  repository_id?: number | string;
  account_id?: number | string;
  account_login?: string;
  binding_id?: string;
  authority_status?: 'active' | 'disabled' | 'invalid';
}

interface WorkspaceMembershipRow {
  role: 'member' | 'admin' | 'owner';
}

const WORKSPACE_ROLE_RANK: Record<WorkspaceMembershipRow['role'], number> = {
  member: 0,
  admin: 1,
  owner: 2,
};
const MAX_GITHUB_WEBHOOK_BYTES = 1024 * 1024;
const SUPPORTED_GITHUB_EVENTS = new Set(['ping', 'push', 'pull_request', 'issues', 'check_run']);
const DELIVERY_ID = /^[A-Za-z0-9-]{8,100}$/;

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
  for (const handler of handlers) await handler(payload, event, workspaceId);
}

// ─── Valid providers ────────────────────────────────────────────────────────

const VALID_PROVIDERS = new Set<WebhookProvider>(['github', 'linear', 'vercel', 'slack']);

function isValidProvider(provider: string): provider is WebhookProvider {
  return VALID_PROVIDERS.has(provider as WebhookProvider);
}

function verifiedDelivery(payload: unknown, method: VerifiedWebhookDelivery['method']): VerifiedWebhookDelivery {
  return { method, payloadSha256: webhookPayloadSha256(payload) };
}

function providerVerificationMethod(provider: Exclude<WebhookProvider, 'github'>): VerifiedWebhookDelivery['method'] {
  switch (provider) {
    case 'linear': return 'linear-signature';
    case 'vercel': return 'vercel-signature';
    case 'slack': return 'slack-signature';
  }
}

function workspaceIdFromRequest(req: Request): string {
  const candidate = req.method === 'GET' ? req.query.workspaceId : req.body?.workspaceId;
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 255) {
    throw new ValidationError('workspaceId is required');
  }
  return candidate.trim();
}

function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    next(new AdminRequiredError());
    return;
  }
  next();
}

function requireDlqWorkspaceRole(minRole: 'member' | 'admin') {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const workspaceId = workspaceIdFromRequest(req);
      const user = req.user;
      if (!user) throw new AuthError();

      // LOCAL_ADMIN is the canonical workspace owner in explicit local single-user
      // mode. Authenticated/team admins must also hold the requested workspace role.
      if (process.env.AUTH_REQUIRED !== 'true' && user.id === LOCAL_ADMIN.id) {
        next();
        return;
      }

      const membership = await queryOne<WorkspaceMembershipRow>(
        'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',
        [workspaceId, user.supabaseId],
      );
      if (!membership || WORKSPACE_ROLE_RANK[membership.role] < WORKSPACE_ROLE_RANK[minRole]) {
        throw new ForbiddenError(`Webhook DLQ ${minRole} access is required for this workspace`);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function auditRejectedGithubDelivery(
  row: GithubWebhookAuthority,
  event: string,
  deliveryId: string,
  repo: string,
  reason: 'canonical_authority_inactive' | 'repository_identity_mismatch',
): Promise<void> {
  const details = {
    webhook_event: event,
    delivery_id: deliveryId,
    repo,
    binding_id: row.binding_id ?? null,
    authority_status: row.authority_status ?? 'invalid',
    rejection_reason: reason,
  };
  const auditResults = await Promise.allSettled([
    execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('github_webhook_rejected', $1, $2::jsonb)`,
      [row.workspace_id, JSON.stringify(details)],
    ),
    insertAuditEntry({
      workspaceId: row.workspace_id,
      provider: 'github',
      action: 'webhook_rejected',
      actorType: 'webhook',
      details,
    }),
  ]);
  if (auditResults.some((result) => result.status === 'rejected')) {
    logger.error({ workspaceId: row.workspace_id, deliveryId }, '[Webhook] Failed to persist complete rejection audit');
  }
}

// ─── POST /api/webhooks/github — GitHub webhook receiver ────────────────────

/**
 * @swagger
 * /api/webhooks/github:
 *   post:
 *     tags: [Webhooks]
 *     summary: Receive GitHub webhook events
 *     operationId: receiveGithubWebhook
 *     description: Public path-only runtime callback. Verifies HMAC-SHA256 plus exact effective App installation/repository identity, applies a 1 MiB bound, atomically deduplicates X-GitHub-Delivery, and uses the existing webhook router. It is intentionally default-denied from MCP/native public API tooling.
 *     x-rorca-mcp: false
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
 *         required: true
 *         schema: { type: string, pattern: '^[A-Za-z0-9-]{8,100}$' }
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
 *       403:
 *         description: App installation/repository identity mismatch or missing webhook secret
 *       404:
 *         description: No workspace connected to this repository
 *       503:
 *         description: Processing failed or another non-completed claim must be retried by the provider
 */
webhookCallbackRouter.post('/github', async (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = req.headers['x-github-event'] as string | undefined;
  const deliveryId = req.headers['x-github-delivery'] as string | undefined;

  if (!signature || !event || !deliveryId || !DELIVERY_ID.test(deliveryId)) {
    throw new AuthError('Invalid webhook authentication headers');
  }

  // Use the raw body captured by the verify callback in express.json().
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody) throw new ValidationError('Missing raw body for signature verification');
  if (rawBody.length > MAX_GITHUB_WEBHOOK_BYTES) throw new ValidationError('GitHub webhook payload exceeds the 1 MiB limit');

  // GitHub sends the repo full_name as owner/repo in the payload
  const payload = req.body;
  const repoFullName = payload?.repository?.full_name as string | undefined;

  if (!repoFullName) {
    throw new ValidationError('Missing repository info in payload');
  }

  const parts = repoFullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ValidationError('Invalid repository identity in payload');
  const [repoOwner, repoName] = parts;
  const installationId = Number(payload?.installation?.id);
  const repositoryId = Number(payload?.repository?.id);
  // Resolve App presence independently from effective authority. The LEFT JOIN
  // keeps a malformed/disabled current binding as a downgrade fence, while the
  // canonical view alone decides whether that binding may dispatch.
  let row = await queryOne<GithubWebhookAuthority>(
    `WITH current_app AS (
       SELECT b.*
         FROM github_app_workspace_bindings b
        WHERE b.superseded_at IS NULL
          AND lower(b.repo_owner) = lower($1) AND lower(b.repo_name) = lower($2)
     )
     SELECT 'github-app' AS source, b.workspace_id, b.repo_owner, b.repo_name,
            NULL::integer AS webhook_id, r.webhook_secret_id,
            b.id AS binding_id, b.installation_id, b.repository_id,
            i.account_id, i.account_login,
            COALESCE(a.authority_status, 'invalid') AS authority_status
       FROM current_app b
       LEFT JOIN github_app_registrations r ON r.id = b.registration_id
       LEFT JOIN github_app_installations i
         ON i.id = b.installation_record_id
        AND i.registration_id = b.registration_id
        AND i.installation_id = b.installation_id
       LEFT JOIN github_workspace_repository_authority a
         ON a.binding_id = b.id
        AND a.authority_source = 'github-app-installation'`,
    [repoOwner, repoName],
  );

  if (!row) {
    // Legacy compatibility exists only when the canonical authority view has no
    // current App binding for the workspace/repository.
    row = await queryOne<GithubWebhookAuthority>(
      `SELECT 'legacy-repository-webhook' AS source, a.workspace_id, a.repo_owner, a.repo_name,
              w.webhook_id, w.encrypted_webhook_secret, a.authority_status
         FROM github_workspace_repository_authority a
         JOIN workspace_github_webhooks w ON w.workspace_id = a.workspace_id
        WHERE a.authority_source = 'pat-oauth-fallback' AND a.authority_status = 'active'
          AND lower(a.repo_owner) = lower($1) AND lower(a.repo_name) = lower($2)`,
      [repoOwner, repoName],
    );
  }
  if (!row) throw new NotFoundError('No workspace connected to this repository');

  const secret = row.source === 'github-app'
    ? row.webhook_secret_id
      ? await getIntegrationSecret(String(row.webhook_secret_id), 'webhook_secret')
      : null
    : row.encrypted_webhook_secret ? decryptToken(row.encrypted_webhook_secret) : null;
  if (!secret) throw new ForbiddenError('Webhook secret not configured');
  if (!verifyWebhookSignature(rawBody, signature, secret)) throw new AuthError('Invalid webhook signature');
  if (!SUPPORTED_GITHUB_EVENTS.has(event)) throw new ValidationError(`Unsupported GitHub webhook event: ${event}`);

  if (row.source === 'github-app') {
    const identityMatches = Number.isSafeInteger(installationId) && installationId > 0
      && Number.isSafeInteger(repositoryId) && repositoryId > 0
      && installationId === Number(row.installation_id)
      && repositoryId === Number(row.repository_id)
      && Number(payload?.repository?.owner?.id) === Number(row.account_id)
      && String(payload?.repository?.owner?.login ?? '').toLowerCase() === String(row.account_login ?? '').toLowerCase();
    if (!identityMatches) {
      await auditRejectedGithubDelivery(row, event, deliveryId, repoFullName, 'repository_identity_mismatch');
      throw new ForbiddenError('GitHub App installation/repository/owner identity does not match the current binding');
    }
    if (row.authority_status !== 'active') {
      await auditRejectedGithubDelivery(row, event, deliveryId, repoFullName, 'canonical_authority_inactive');
      throw new ForbiddenError('Canonical GitHub App webhook authority is not active');
    }
  }

  const provenance = verifiedDelivery(payload, 'github-hmac-sha256');

  // Atomically claim a new, failed, or bounded stale delivery in the existing
  // ledger. Provider redelivery supplies the payload; Rorca does not claim
  // exactly-once handler semantics.
  const webhookRouter = getWebhookRouter();
  const claim = await webhookRouter.claimDelivery('github', deliveryId, event, row.workspace_id, provenance);
  if (!claim) {
    const existingStatus = await webhookRouter.checkDedup('github', deliveryId, event, row.workspace_id);
    if (existingStatus === 'completed') res.json({ ok: true, status: 'duplicate' });
    else res.status(503).json({ ok: false, status: 'retry-later', code: 'WEBHOOK_DELIVERY_IN_PROGRESS' });
    return;
  }

  try {
    await insertAuditEntry({
      workspaceId: row.workspace_id,
      provider: 'github',
      action: 'webhook_received',
      actorType: 'webhook',
      details: {
        webhook_event: event,
        delivery_id: deliveryId,
        repo: repoFullName,
        delivery_attempt: claim.attempt,
        action: payload.action || null,
        sender: payload.sender?.login || null,
      },
    }).catch(() => {});

    // A valid signed App delivery promotes observed health independently from
    // provider hook configuration, including the initial signed ping.
    if (row.source === 'github-app') {
      await execute(
        `UPDATE github_app_workspace_bindings
            SET last_webhook_at = NOW(), signed_delivery_observed = TRUE
          WHERE workspace_id = $1 AND installation_id = $2 AND repository_id = $3
            AND status = 'active' AND superseded_at IS NULL`,
        [row.workspace_id, row.installation_id, row.repository_id],
      );
    } else {
      await execute(
        'UPDATE workspace_github_webhooks SET last_webhook_at = NOW() WHERE workspace_id = $1',
        [row.workspace_id],
      );
    }

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('github_webhook', $1, $2)",
      [row.workspace_id, JSON.stringify({
        event, deliveryId, repo: repoFullName, deliveryAttempt: claim.attempt,
        action: payload.action || null, ref: payload.ref || null, sender: payload.sender?.login || null,
      })],
    );

    logger.info(`[Webhook] GitHub ${event} from ${repoFullName} for workspace ${row.workspace_id}`);
    const meta = { deliveryId, workspaceId: row.workspace_id, verifiedDelivery: provenance };
    await webhookRouter.dispatch('github', event, payload, meta);
    await dispatchLegacyHandlers(event, payload, row.workspace_id);

    const completed = await webhookRouter.completeDelivery('github', deliveryId, claim.claimToken);
    if (!completed) throw new Error('Webhook delivery claim was reclaimed before acknowledgement');

    await insertAuditEntry({
      workspaceId: row.workspace_id,
      provider: 'github',
      action: 'webhook_processed',
      actorType: 'webhook',
      details: { webhook_event: event, delivery_id: deliveryId, repo: repoFullName, delivery_attempt: claim.attempt },
    }).catch(() => {});
    res.json({ ok: true, status: 'completed' });
  } catch {
    logger.error({ deliveryId, event, workspaceId: row.workspace_id }, '[Webhook] Processing failed; requesting provider redelivery');
    await webhookRouter.failDelivery('github', deliveryId, claim.claimToken).catch(() => false);
    await insertAuditEntry({
      workspaceId: row.workspace_id,
      provider: 'github',
      action: 'webhook_failed',
      actorType: 'webhook',
      details: {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        delivery_attempt: claim.attempt, error_code: 'WEBHOOK_PROCESSING_FAILED',
      },
    }).catch(() => {});
    res.status(503).json({ ok: false, status: 'failed', code: 'WEBHOOK_PROCESSING_FAILED' });
  }
});

// ─── Protected webhook administration (mounted after auth + CSRF) ───────────
// Callback routes are exact paths, so administration can never be interpreted
// as an unauthenticated provider name.

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
 *     description: Authenticated platform-admin diagnostics scoped to one workspace membership. The route is default-denied from MCP/native public API exposure.
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
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
webhookAdminRouter.get('/dlq', requirePlatformAdmin, requireDlqWorkspaceRole('member'), async (req: Request, res: Response) => {
  const pagination = parsePaginationParams(req);
  const workspaceId = workspaceIdFromRequest(req);
  const providerFilter = req.query.provider as string | undefined;
  const resolvedFilter = req.query.resolved as string | undefined;
  if (providerFilter && !isValidProvider(providerFilter)) throw new ValidationError('Invalid webhook provider filter');
  if (resolvedFilter && resolvedFilter !== 'true' && resolvedFilter !== 'false') throw new ValidationError('resolved must be true or false');

  const conditions: string[] = ['d.workspace_id = $1'];
  const params: unknown[] = [workspaceId];

  if (providerFilter) {
    params.push(providerFilter);
    conditions.push(`d.provider = $${params.length}`);
  }

  if (resolvedFilter === 'true') {
    conditions.push('d.resolved_at IS NOT NULL');
  } else if (resolvedFilter === 'false') {
    conditions.push('d.resolved_at IS NULL');
  }

  const where = conditions.join(' AND ');

  const result = await paginateQuery<DlqRow>({
    query: `SELECT d.id, d.provider, d.event_type, d.payload, d.error, d.attempts,
                   d.delivery_id, d.workspace_id, d.created_at, d.resolved_at
              FROM webhook_dlq d WHERE ${where}`,
    countQuery: `SELECT COUNT(*)::int AS total FROM webhook_dlq d WHERE ${where}`,
    params,
    pagination,
    orderBy: 'd.created_at DESC',
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
 *     description: Explicit, CSRF-protected platform-admin replay scoped to a workspace-admin membership. A fresh provider signature is not required; replay requires the original exact verified-delivery ledger provenance. The route is default-denied from MCP/native public API exposure.
 *     x-rorca-mcp: false
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId]
 *             properties:
 *               workspaceId: { type: string }
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
webhookAdminRouter.post('/dlq/:id/retry', requireProviderMutationAuthority, requirePlatformAdmin, requireDlqWorkspaceRole('admin'), async (req: Request, res: Response) => {
  const rawDlqId = String(req.params.id);
  if (!/^[1-9][0-9]*$/.test(rawDlqId)) throw new ValidationError('Invalid DLQ entry ID');
  const dlqId = Number(rawDlqId);
  if (!Number.isSafeInteger(dlqId)) throw new ValidationError('Invalid DLQ entry ID');
  const workspaceId = workspaceIdFromRequest(req);
  const actor = String(req.user?.email || req.user?.id || 'unknown').slice(0, 255);

  // This durable intent is written before handlers run, so every replay side
  // effect has an authenticated, workspace-scoped audit predecessor.
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ('webhook_dlq_replay_requested', $1, $2, $3::jsonb)`,
    [workspaceId, actor, JSON.stringify({ dlqId })],
  );
  await insertAuditEntry({
    workspaceId,
    provider: 'webhook',
    action: 'dlq_replay_requested',
    actorType: 'user',
    actorId: actor,
    details: { dlq_id: dlqId },
  }).catch(() => {});

  const webhookRouter = getWebhookRouter();
  const result = await webhookRouter.replayDlqEvent(dlqId, workspaceId);

  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, actor, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [result.success ? 'webhook_dlq_replay_completed' : 'webhook_dlq_replay_failed', workspaceId, actor,
      JSON.stringify({ dlqId, result: result.success ? 'completed' : 'failed' })],
  ).catch((error) => logger.error({ error, dlqId, workspaceId }, '[Webhook] Failed to write DLQ replay result audit'));

  if (!result.success && result.error === 'DLQ entry not found or lacks verified delivery provenance') {
    throw new NotFoundError('DLQ entry', String(dlqId));
  }

  res.json({ ok: result.success, error: result.success ? undefined : 'Webhook DLQ replay failed' });
});

// ─── POST /api/webhooks/:provider — Generic webhook receiver ────────────────

/**
 * @swagger
 * /api/webhooks/{provider}:
 *   post:
 *     tags: [Webhooks]
 *     summary: Receive webhook events for a provider
 *     operationId: receiveProviderWebhook
 *     description: Exact callback receiver for non-GitHub providers (linear, vercel, slack). Dispatches to registered WebhookRouter handlers with retry + DLQ and requires a configured provider signature verifier. It is intentionally default-denied from MCP/native public API exposure.
 *     x-rorca-mcp: false
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
 *       503:
 *         description: Processing failed or a delivery claim must be retried
 */
webhookCallbackRouter.post(['/linear', '/vercel', '/slack'], async (req: Request, res: Response) => {
  const provider = req.path.slice(1);
  if (!isValidProvider(provider) || provider === 'github') {
    throw new ValidationError('Invalid webhook provider callback');
  }

  const webhookRouter = getWebhookRouter();
  const rawBody: Buffer | undefined = (req as any).rawBody;
  const payload = req.body;

  // Extract provider-specific event type and delivery ID
  const eventType = extractEventType(provider, req);
  const deliveryId = extractDeliveryId(provider, req);

  // Every public provider callback must authenticate before a delivery can be
  // written to the verified ledger or dispatched.
  const verifier = webhookRouter.getVerifier(provider);
  if (!verifier) throw new AuthError('Webhook signature verifier is not configured');
  const signature = extractSignature(provider, req);
  if (!signature) throw new AuthError('Invalid webhook signature');
  if (!rawBody) throw new ValidationError('Missing raw body for signature verification');
  const provenance = verifiedDelivery(payload, providerVerificationMethod(provider));
  const valid = await verifier(rawBody, signature, { deliveryId, workspaceId: undefined, verifiedDelivery: provenance });
  if (!valid) throw new AuthError('Invalid webhook signature');

  const claim = deliveryId
    ? await webhookRouter.claimDelivery(provider, deliveryId, eventType, undefined, provenance)
    : null;
  if (deliveryId && !claim) {
    const existingStatus = await webhookRouter.checkDedup(provider, deliveryId, eventType);
    if (existingStatus === 'completed') res.json({ ok: true, status: 'duplicate' });
    else res.status(503).json({ ok: false, status: 'retry-later', code: 'WEBHOOK_DELIVERY_IN_PROGRESS' });
    return;
  }

  try {
    const meta = { deliveryId, verifiedDelivery: provenance };
    await webhookRouter.dispatch(provider, eventType, payload, meta);
    if (deliveryId && claim) {
      const completed = await webhookRouter.completeDelivery(provider, deliveryId, claim.claimToken);
      if (!completed) throw new Error('Webhook delivery claim was reclaimed before acknowledgement');
    }
    res.json({ ok: true, status: webhookRouter.hasHandlers(provider, eventType) ? 'completed' : 'unhandled' });
  } catch {
    if (deliveryId && claim) await webhookRouter.failDelivery(provider, deliveryId, claim.claimToken).catch(() => false);
    res.status(503).json({ ok: false, status: 'failed', code: 'WEBHOOK_PROCESSING_FAILED' });
  }
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

// Backward-compatible default: only provider callbacks are public. Protected
// administration must be mounted explicitly after auth and CSRF middleware.
export default webhookCallbackRouter;
