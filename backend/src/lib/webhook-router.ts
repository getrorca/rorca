/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-022: Generic webhook infrastructure
 *
 * WebhookRouter supports:
 *   - Registering handler functions per (provider, event_type) pair
 *   - Signature verification per provider via pluggable verifier functions
 *   - Delivery deduplication via webhook_events table
 *   - Retry with exponential backoff (3 attempts) via pg-boss delayed jobs
 *   - Dead letter queue (webhook_dlq) for exhausted retries
 *
 * Usage:
 *   const router = new WebhookRouter();
 *   router.on('github', 'push', async (payload, meta) => { ... });
 *   router.setVerifier('github', async (rawBody, signature, req) => { ... });
 *   await router.dispatch('github', 'push', payload, meta);
 */

import crypto from 'node:crypto';
import { queryOne, execute } from '../db/index';
import { logger } from './logger';

// ─── Types ────────────────────────────────────────────────────────────────

export type WebhookProvider = 'github' | 'linear' | 'vercel' | 'slack';

export interface WebhookMeta {
  deliveryId?: string;
  workspaceId?: string;
  signature?: string;
}

export type WebhookHandlerFn = (
  payload: Record<string, any>,
  meta: WebhookMeta,
) => void | Promise<void>;

/**
 * Signature verifier — returns true if the signature is valid.
 * Receives the raw body buffer, the signature header value, and the request
 * (for accessing additional headers like workspace lookup).
 */
export type SignatureVerifier = (
  rawBody: Buffer,
  signature: string,
  meta: WebhookMeta,
) => boolean | Promise<boolean>;

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

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 3;
const MAX_DELIVERY_CLAIMS = 5;
const STALE_PROCESSING_MS = 2 * 60_000;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000]; // exponential: 1s, 2s, 4s

export interface WebhookDeliveryClaim {
  claimToken: string;
  attempt: number;
}

export class WebhookDispatchError extends Error {
  constructor(readonly failedHandlers: number) {
    super(`${failedHandlers} webhook handler(s) exhausted bounded retries`);
    this.name = 'WebhookDispatchError';
  }
}

// ─── WebhookRouter ────────────────────────────────────────────────────────

export class WebhookRouter {
  private handlers = new Map<string, WebhookHandlerFn[]>();
  private verifiers = new Map<WebhookProvider, SignatureVerifier>();

  /**
   * Register a handler for a specific (provider, eventType) pair.
   * Multiple handlers per pair are supported — they run sequentially.
   */
  on(provider: WebhookProvider, eventType: string, handler: WebhookHandlerFn): void {
    const key = `${provider}:${eventType}`;
    const existing = this.handlers.get(key) || [];
    existing.push(handler);
    this.handlers.set(key, existing);
  }

  /**
   * Set a signature verifier for a provider.
   * Called before any handler is invoked.
   */
  setVerifier(provider: WebhookProvider, verifier: SignatureVerifier): void {
    this.verifiers.set(provider, verifier);
  }

  /**
   * Get the signature verifier for a provider (if set).
   */
  getVerifier(provider: WebhookProvider): SignatureVerifier | undefined {
    return this.verifiers.get(provider);
  }

  /**
   * Check if any handlers are registered for a (provider, eventType) pair.
   */
  hasHandlers(provider: WebhookProvider, eventType: string): boolean {
    const key = `${provider}:${eventType}`;
    const handlers = this.handlers.get(key);
    return !!handlers && handlers.length > 0;
  }

  /**
   * Check if a delivery has already been processed (dedup).
   * Returns the status if found, undefined if new.
   */
  async checkDedup(
    provider: WebhookProvider,
    deliveryId: string,
    eventType: string,
    workspaceId?: string,
  ): Promise<string | undefined> {
    const row = await queryOne<{ status: string }>(
      `SELECT status FROM webhook_events
        WHERE provider = $1 AND delivery_id = $2 AND event_type = $3
          AND workspace_id IS NOT DISTINCT FROM $4`,
      [provider, deliveryId, eventType, workspaceId || null],
    );
    return row?.status;
  }

  /**
   * Atomically claim a new, failed, or bounded stale-processing delivery.
   * Completed/recent/exhausted claims remain duplicates. The returned token is
   * required for acknowledgement so a crashed claimant cannot complete a claim
   * that a provider redelivery has reclaimed.
   */
  async claimDelivery(
    provider: WebhookProvider,
    deliveryId: string,
    eventType: string,
    workspaceId?: string,
  ): Promise<WebhookDeliveryClaim | null> {
    const claimToken = crypto.randomUUID();
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const row = await queryOne<{ claim_token: string; attempt_count: number }>(
      `INSERT INTO webhook_events
         (provider, delivery_id, event_type, status, workspace_id, processing_started_at, completed_at, claim_token, attempt_count)
       VALUES ($1, $2, $3, 'processing', $4, NOW(), NULL, $5, 1)
       ON CONFLICT (provider, delivery_id) DO UPDATE
         SET status = 'processing', processing_started_at = NOW(), completed_at = NULL,
             claim_token = EXCLUDED.claim_token, attempt_count = webhook_events.attempt_count + 1
       WHERE webhook_events.event_type = EXCLUDED.event_type
         AND webhook_events.workspace_id IS NOT DISTINCT FROM EXCLUDED.workspace_id
         AND webhook_events.attempt_count < $7
         AND (webhook_events.status = 'failed'
              OR (webhook_events.status = 'processing' AND webhook_events.processing_started_at < $6))
       RETURNING claim_token, attempt_count`,
      [provider, deliveryId, eventType, workspaceId || null, claimToken, staleBefore, MAX_DELIVERY_CLAIMS],
    );
    return row ? { claimToken: row.claim_token, attempt: Number(row.attempt_count) } : null;
  }

  async completeDelivery(provider: WebhookProvider, deliveryId: string, claimToken: string): Promise<boolean> {
    const result = await execute(
      `UPDATE webhook_events
          SET status = 'completed', completed_at = NOW(), claim_token = NULL
        WHERE provider = $1 AND delivery_id = $2 AND status = 'processing' AND claim_token = $3`,
      [provider, deliveryId, claimToken],
    );
    return result.rowCount === 1;
  }

  async failDelivery(provider: WebhookProvider, deliveryId: string, claimToken: string): Promise<boolean> {
    const result = await execute(
      `UPDATE webhook_events
          SET status = 'failed', completed_at = NULL, claim_token = NULL
        WHERE provider = $1 AND delivery_id = $2 AND status = 'processing' AND claim_token = $3`,
      [provider, deliveryId, claimToken],
    );
    return result.rowCount === 1;
  }

  /**
   * Record a delivery in the dedup table.
   */
  async recordDelivery(
    provider: WebhookProvider,
    deliveryId: string,
    eventType: string,
    status: string,
    workspaceId?: string,
  ): Promise<void> {
    await execute(
      `INSERT INTO webhook_events (provider, delivery_id, event_type, status, workspace_id, completed_at, claim_token, attempt_count)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 = 'completed' THEN NOW() ELSE NULL END, NULL, 0)
       ON CONFLICT (provider, delivery_id) DO UPDATE
         SET status = $4, completed_at = CASE WHEN $4 = 'completed' THEN NOW() ELSE NULL END, claim_token = NULL`,
      [provider, deliveryId, eventType, status, workspaceId || null],
    );
  }

  /**
   * Dispatch an event to all registered handlers for (provider, eventType).
   *
   * Runs handlers sequentially. On failure, retries up to MAX_RETRY_ATTEMPTS
   * with exponential backoff (in-process setTimeout). After exhausting retries,
   * inserts into webhook_dlq.
   *
   * Returns the number of handlers invoked.
   */
  async dispatch(
    provider: WebhookProvider,
    eventType: string,
    payload: Record<string, any>,
    meta: WebhookMeta,
  ): Promise<number> {
    const key = `${provider}:${eventType}`;
    const handlers = this.handlers.get(key);

    if (!handlers || handlers.length === 0) {
      logger.info(`[WebhookRouter] unhandled event: ${provider}/${eventType}`);
      return 0;
    }

    let handlerCount = 0;
    let failedHandlers = 0;

    for (const handler of handlers) {
      let lastError: Error | null = null;
      let succeeded = false;

      for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        try {
          await handler(payload, meta);
          succeeded = true;
          handlerCount++;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          logger.warn(
            { err: lastError, provider, eventType, attempt: attempt + 1 },
            `[WebhookRouter] Handler failed (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
          );

          // Backoff before next attempt (skip delay after final attempt)
          if (attempt < MAX_RETRY_ATTEMPTS - 1) {
            await sleep(BACKOFF_DELAYS_MS[attempt]);
          }
        }
      }

      if (!succeeded && lastError) {
        // All retries exhausted — retain DLQ diagnostics, then fail dispatch so
        // the provider receives a retryable response and can redeliver payload.
        await this.insertDlq(provider, eventType, payload, lastError, meta);
        failedHandlers++;
      }
    }

    if (failedHandlers > 0) throw new WebhookDispatchError(failedHandlers);
    return handlerCount;
  }

  /**
   * Insert a failed event into the dead letter queue.
   */
  private async insertDlq(
    provider: string,
    eventType: string,
    payload: Record<string, any>,
    error: Error,
    meta: WebhookMeta,
  ): Promise<void> {
    try {
      await execute(
        `INSERT INTO webhook_dlq (provider, event_type, payload, error, attempts, delivery_id, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          provider,
          eventType,
          JSON.stringify(payload),
          error.message,
          MAX_RETRY_ATTEMPTS,
          meta.deliveryId || null,
          meta.workspaceId || null,
        ],
      );
      logger.error(
        { provider, eventType, deliveryId: meta.deliveryId, error: error.message },
        '[WebhookRouter] Handler exhausted retries — moved to DLQ',
      );
    } catch (dlqErr) {
      logger.error({ dlqErr, provider, eventType }, '[WebhookRouter] Failed to insert into DLQ');
    }
  }

  /**
   * Replay a DLQ event through its handlers.
   * Returns true if all handlers succeeded, false otherwise.
   */
  async replayDlqEvent(dlqId: number): Promise<{ success: boolean; error?: string }> {
    const row = await queryOne<DlqRow>(
      'SELECT * FROM webhook_dlq WHERE id = $1',
      [dlqId],
    );

    if (!row) {
      return { success: false, error: 'DLQ entry not found' };
    }

    if (row.resolved_at) {
      return { success: false, error: 'DLQ entry already resolved' };
    }

    const provider = row.provider as WebhookProvider;
    const eventType = row.event_type;
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    const meta: WebhookMeta = {
      deliveryId: row.delivery_id || undefined,
      workspaceId: row.workspace_id || undefined,
    };

    const key = `${provider}:${eventType}`;
    const handlers = this.handlers.get(key);

    if (!handlers || handlers.length === 0) {
      return { success: false, error: `No handlers registered for ${provider}/${eventType}` };
    }

    try {
      for (const handler of handlers) {
        await handler(payload, meta);
      }

      // Mark as resolved
      await execute(
        'UPDATE webhook_dlq SET resolved_at = NOW(), attempts = attempts + 1 WHERE id = $1',
        [dlqId],
      );

      return { success: true };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      // Increment attempts but don't re-DLQ
      await execute(
        'UPDATE webhook_dlq SET attempts = attempts + 1, error = $1 WHERE id = $2',
        [errorMsg, dlqId],
      );

      return { success: false, error: errorMsg };
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Singleton ────────────────────────────────────────────────────────────

let _instance: WebhookRouter | null = null;

export function getWebhookRouter(): WebhookRouter {
  if (!_instance) {
    _instance = new WebhookRouter();
  }
  return _instance;
}
