/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * W5-006 Forgejo webhook receiver. Mirrors the reviewed GitHub webhook
 * overlay: HMAC-SHA256 verification (X-Forgejo-Signature AND
 * X-Gitea-Signature), exact-path mounting at /api/webhooks/forgejo, events
 * pull_request / push / status, workspace-scoped, verified-credential-bound
 * repositories only, and an immutable delivery ledger.
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'node:crypto';
import { execute, queryOne } from '../db/index';
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { logger } from '../lib/logger';
import { webhookPayloadSha256 } from '../lib/webhook-router';
import { forgejoWebhookSecretCipher } from '../lib/forgejo-token-credential-provider';

export const forgejoWebhookCallbackRouter = Router({ strict: true, caseSensitive: true });

const MAX_FORGEJO_WEBHOOK_BYTES = 1024 * 1024;
const DELIVERY_ID = /^[A-Za-z0-9-]{8,100}$/;
const SUPPORTED_FORGEJO_EVENTS = new Set(['ping', 'push', 'pull_request', 'status']);
const SUPPORTED_PR_ACTIONS = new Set(['opened', 'synchronize', 'closed']);
const STALE_PROCESSING_MS = 2 * 60_000;
const MAX_DELIVERY_CLAIMS = 5;

interface ForgejoCredentialRow {
  id: string;
  workspace_id: string;
  instance_url: string;
  repo_owner: string;
  repo_name: string;
  status: string;
  webhook_secret_encrypted: string | null;
  webhook_secret_previous_encrypted: string | null;
  webhook_secret_version: number | string;
  webhook_secret_revoked_at: string | null;
}

interface DeliveryClaim {
  claimToken: string;
  attempt: number;
}

interface ForgejoWebhookPayload {
  action?: unknown;
  ref?: unknown;
  after?: unknown;
  sha?: unknown;
  sender?: { login?: unknown };
  repository?: { full_name?: unknown; name?: unknown; owner?: { login?: unknown } };
}

function parsePayload(value: unknown): ForgejoWebhookPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const repository = candidate.repository;
  let parsedRepository: ForgejoWebhookPayload['repository'] | undefined;
  if (repository && typeof repository === 'object') {
    const repo = repository as Record<string, unknown>;
    const owner = repo.owner;
    parsedRepository = {
      full_name: repo.full_name,
      name: repo.name,
      owner: owner && typeof owner === 'object'
        ? { login: (owner as Record<string, unknown>).login }
        : typeof owner === 'string'
          ? { login: owner }
          : undefined,
    };
  }
  return {
    action: candidate.action,
    ref: candidate.ref,
    after: candidate.after,
    sha: candidate.sha,
    sender: candidate.sender && typeof candidate.sender === 'object'
      ? { login: (candidate.sender as Record<string, unknown>).login }
      : undefined,
    repository: parsedRepository,
  };
}

/** Resolve the canonical `owner/name` repository identity from the Forgejo or
 * Gitea payload shape: `repository.full_name`, or the legacy
 * `repository.name` + `repository.owner.login` pair. */
function repositoryFullName(payload: ForgejoWebhookPayload): string | null {
  const repository = payload.repository;
  if (!repository) return null;
  if (typeof repository.full_name === 'string' && repository.full_name.includes('/')) {
    return repository.full_name;
  }
  const name = typeof repository.name === 'string' ? repository.name : null;
  const ownerLogin = typeof repository.owner?.login === 'string' ? repository.owner.login : null;
  if (name && ownerLogin) return `${ownerLogin}/${name}`;
  return null;
}

function rawBodyOf(req: Request): Buffer | undefined {
  // The raw body is captured by the express.json() verify callback for exact
  // provider callback paths (see server.ts WEBHOOK_CALLBACK_PATHS).
  return (req as Request & { rawBody?: Buffer }).rawBody;
}

function verifyForgejoHmac(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = `sha256=${digest}`;
  const provided = signatureHeader.trim();
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

async function claimDelivery(
  deliveryId: string,
  eventType: string,
  workspaceId: string,
  payloadSha256: string,
): Promise<DeliveryClaim | null> {
  const claimToken = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const row = await queryOne<{ claim_token: string; attempt_count: number }>(
    `INSERT INTO webhook_events
       (provider, delivery_id, event_type, status, workspace_id, processing_started_at, completed_at,
        claim_token, attempt_count, payload_sha256, verification_method, signature_verified_at)
     VALUES ('forgejo', $1, $2, 'processing', $3, NOW(), NULL, $4, 1, $5, 'forgejo-hmac-sha256', NOW())
     ON CONFLICT (provider, delivery_id) DO UPDATE
       SET status = 'processing', processing_started_at = NOW(), completed_at = NULL,
           claim_token = EXCLUDED.claim_token, attempt_count = webhook_events.attempt_count + 1,
           payload_sha256 = EXCLUDED.payload_sha256,
           verification_method = EXCLUDED.verification_method,
           signature_verified_at = EXCLUDED.signature_verified_at
       WHERE webhook_events.event_type = EXCLUDED.event_type
         AND webhook_events.workspace_id IS NOT DISTINCT FROM EXCLUDED.workspace_id
         AND (webhook_events.payload_sha256 IS NULL
              OR webhook_events.payload_sha256 = EXCLUDED.payload_sha256)
         AND (webhook_events.verification_method IS NULL
              OR webhook_events.verification_method = EXCLUDED.verification_method)
         AND webhook_events.attempt_count < $6
         AND (webhook_events.status = 'failed'
              OR (webhook_events.status = 'processing' AND webhook_events.processing_started_at < $7))
     RETURNING claim_token, attempt_count`,
    [deliveryId, eventType, workspaceId || null, claimToken, payloadSha256,
      MAX_DELIVERY_CLAIMS, staleBefore],
  );
  return row ? { claimToken: row.claim_token, attempt: Number(row.attempt_count) } : null;
}

async function completeDelivery(deliveryId: string, claimToken: string): Promise<boolean> {
  const result = await execute(
    `UPDATE webhook_events SET status = 'completed', completed_at = NOW(), claim_token = NULL
      WHERE provider = 'forgejo' AND delivery_id = $1 AND status = 'processing' AND claim_token = $2`,
    [deliveryId, claimToken],
  );
  return result.rowCount === 1;
}

async function failDelivery(deliveryId: string, claimToken: string): Promise<boolean> {
  const result = await execute(
    `UPDATE webhook_events SET status = 'failed', completed_at = NULL, claim_token = NULL
      WHERE provider = 'forgejo' AND delivery_id = $1 AND status = 'processing' AND claim_token = $2`,
    [deliveryId, claimToken],
  );
  return result.rowCount === 1;
}

async function resolveWorkspace(repoOwner: string, repoName: string): Promise<ForgejoCredentialRow | null> {
  // Repo-identity lookup is not workspace-scoped by nature, so it runs through
  // the split-principal definer seam; direct table access stays RLS-scoped.
  const row = await queryOne<ForgejoCredentialRow>(
    `SELECT id, workspace_id, instance_url, repo_owner, repo_name, status,
            webhook_secret_encrypted, webhook_secret_previous_encrypted,
            webhook_secret_version, webhook_secret_revoked_at
       FROM rorca.resolve_forgejo_webhook_binding($1, $2)`,
    [repoOwner, repoName],
  );
  return row ?? null;
}

function canonicalPrAction(payload: ForgejoWebhookPayload): string | null {
  const action = payload.action;
  if (typeof action !== 'string' || !SUPPORTED_PR_ACTIONS.has(action)) return null;
  return action;
}

async function insertAudit(workspaceId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await execute(
    `INSERT INTO integration_audit_log (workspace_id, provider, action, actor_type, details)
     VALUES ($1, 'forgejo', $2, 'webhook', $3::jsonb)`,
    [workspaceId, action, JSON.stringify(details)],
  ).catch(() => {});
}

/**
 * @swagger
 * /api/webhooks/forgejo:
 *   post:
 *     summary: Receive a signed Forgejo webhook delivery
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Signed Forgejo provider callback with integration side effects; it is a native webhook surface and remains default-denied from MCP/API tier exposure."
 *     responses:
 *       200: { description: Delivery accepted or safely ignored }
 *       401: { description: Invalid webhook authentication }
 */
forgejoWebhookCallbackRouter.post('/', async (req: Request, res: Response) => {
  const signature = String(req.headers['x-forgejo-signature'] ?? req.headers['x-gitea-signature'] ?? '');
  const event = req.headers['x-forgejo-event'] as string | undefined
    ?? req.headers['x-gitea-event'] as string | undefined;
  const deliveryId = req.headers['x-forgejo-delivery'] as string | undefined
    ?? req.headers['x-gitea-delivery'] as string | undefined;

  try {
    if (!signature || !event || !deliveryId || !DELIVERY_ID.test(deliveryId)) {
      throw new AuthError('Invalid Forgejo webhook authentication headers');
    }
    const rawBody = rawBodyOf(req);
    if (!rawBody) throw new ValidationError('Missing raw body for Forgejo signature verification');
    if (rawBody.length > MAX_FORGEJO_WEBHOOK_BYTES) throw new ValidationError('Forgejo webhook payload exceeds the 1 MiB limit');

    const payload = parsePayload(req.body);
    if (!payload) throw new ValidationError('Forgejo webhook payload is invalid');
    const repoFullName = repositoryFullName(payload);
    if (!repoFullName) throw new ValidationError('Missing repository info in Forgejo payload');
    const parts = repoFullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ValidationError('Invalid repository identity in Forgejo payload');
    const [repoOwner, repoName] = parts;

    const credential = await resolveWorkspace(repoOwner, repoName);
    if (!credential) {
      // Unbound repositories are dropped with an audit record — never processed.
      await insertAudit('unknown', 'forgejo_webhook_rejected', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        reason: 'unbound_repository',
      }).catch(() => {});
      throw new NotFoundError('No workspace connected to this Forgejo repository');
    }
    if (credential.status !== 'active') {
      await insertAudit(credential.workspace_id, 'forgejo_webhook_rejected', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        reason: 'credential_not_active',
      }).catch(() => {});
      throw new ForbiddenError('Forgejo credential binding is not active');
    }
    // HMAC-SHA256 over the raw body, verified against the dedicated high-
    // entropy webhook signing secret (A1) — never the credential binding UUID.
    // The plaintext secret is resolved ONLY at verification time from
    // ciphertext at rest and is never logged, audited, or returned. The
    // previous secret remains valid during the bounded rotation window.
    if (credential.webhook_secret_revoked_at != null || Number(credential.webhook_secret_version) <= 0) {
      await insertAudit(credential.workspace_id, 'forgejo_webhook_rejected', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        reason: 'webhook_secret_unavailable',
      }).catch(() => {});
      throw new AuthError('Forgejo webhook secret is not provisioned');
    }
    const currentSecret = credential.webhook_secret_encrypted
      ? forgejoWebhookSecretCipher.decrypt(credential.webhook_secret_encrypted)
      : null;
    const previousSecret = credential.webhook_secret_previous_encrypted
      ? forgejoWebhookSecretCipher.decrypt(credential.webhook_secret_previous_encrypted)
      : null;
    const secretValid = (currentSecret != null && verifyForgejoHmac(rawBody, signature, currentSecret))
      || (previousSecret != null && verifyForgejoHmac(rawBody, signature, previousSecret));
    if (!secretValid) {
      await insertAudit(credential.workspace_id, 'forgejo_webhook_rejected', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        reason: 'invalid_signature',
      }).catch(() => {});
      throw new AuthError('Invalid Forgejo webhook signature');
    }
    if (!SUPPORTED_FORGEJO_EVENTS.has(event)) {
      throw new ValidationError(`Unsupported Forgejo webhook event: ${event}`);
    }
    if (event === 'pull_request' && !canonicalPrAction(payload)) {
      throw new ValidationError(`Unsupported Forgejo pull_request action: ${payload?.action}`);
    }

    const provenance = { method: 'forgejo-hmac-sha256' as const, payloadSha256: webhookPayloadSha256(payload) };
    const claim = await claimDelivery(deliveryId, event, credential.workspace_id, provenance.payloadSha256);
    if (!claim) {
      const existing = await queryOne<{ status: string }>(
        `SELECT status FROM webhook_events
          WHERE provider = 'forgejo' AND delivery_id = $1 AND event_type = $2
            AND workspace_id = $3`,
        [deliveryId, event, credential.workspace_id],
      );
      if (existing?.status === 'completed') res.json({ ok: true, status: 'duplicate' });
      else res.status(503).json({ ok: false, status: 'retry-later', code: 'WEBHOOK_DELIVERY_IN_PROGRESS' });
      return;
    }

    try {
      await insertAudit(credential.workspace_id, 'forgejo_webhook_received', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        delivery_attempt: claim.attempt,
        action: typeof payload.action === 'string' ? payload.action : null,
        sender: typeof payload.sender?.login === 'string' ? payload.sender.login : null,
      }).catch(() => {});

      await execute(
        "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('forgejo_webhook', $1, $2)",
        [credential.workspace_id, JSON.stringify({
          event, deliveryId, repo: repoFullName, deliveryAttempt: claim.attempt,
          action: typeof payload.action === 'string' ? payload.action : null,
          ref: typeof payload.ref === 'string' ? payload.ref : null,
          sha: typeof payload.after === 'string' ? payload.after
            : typeof payload.sha === 'string' ? payload.sha : null,
          sender: typeof payload.sender?.login === 'string' ? payload.sender.login : null,
        })],
      );

      logger.info(`[Webhook] Forgejo ${event} from ${repoFullName} for workspace ${credential.workspace_id}`);
      const completed = await completeDelivery(deliveryId, claim.claimToken);
      if (!completed) throw new Error('Forgejo webhook delivery claim was reclaimed before acknowledgement');
      await insertAudit(credential.workspace_id, 'forgejo_webhook_processed', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName, delivery_attempt: claim.attempt,
      }).catch(() => {});
      res.json({ ok: true, status: 'completed' });
    } catch {
      logger.error({ deliveryId, event, workspaceId: credential.workspace_id }, '[Webhook] Forgejo processing failed; requesting provider redelivery');
      await failDelivery(deliveryId, claim.claimToken).catch(() => false);
      await insertAudit(credential.workspace_id, 'forgejo_webhook_failed', {
        webhook_event: event, delivery_id: deliveryId, repo: repoFullName,
        delivery_attempt: claim.attempt, error_code: 'WEBHOOK_PROCESSING_FAILED',
      }).catch(() => {});
      res.status(503).json({ ok: false, status: 'failed', code: 'WEBHOOK_PROCESSING_FAILED' });
    }
  } catch (error) {
    // Every rejected/misrouted delivery terminates with an explicit response:
    // an async Express 4 handler never sees thrown errors, and a hanging
    // provider callback would stall the caller (and Jest) indefinitely.
    if (error instanceof AuthError) res.status(401).json({ ok: false, error: error.message });
    else if (error instanceof ForbiddenError) res.status(403).json({ ok: false, error: error.message });
    else if (error instanceof NotFoundError) res.status(404).json({ ok: false, error: error.message });
    else if (error instanceof ValidationError) res.status(400).json({ ok: false, error: error.message });
    else {
      logger.error({ error, deliveryId, event }, '[Webhook] Forgejo receiver failed');
      res.status(500).json({ ok: false, error: 'internal' });
    }
  }
});

export default forgejoWebhookCallbackRouter;
