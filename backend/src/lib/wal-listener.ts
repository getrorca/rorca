/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * wal-listener.ts — Dedicated LISTEN/NOTIFY client for wal_events
 *
 * Establishes a long-lived pg.Client connection (NOT from the pool) that
 * runs LISTEN wal_events. On each notification, parses the JSON payload
 * and calls broadcastAll() in sse-hub.ts.
 *
 * Implements exponential backoff reconnection (1s → 2s → 4s → … → max 30s)
 * if the connection drops.
 *
 * Also handles token usage recording that previously lived in the polling
 * loop: updates story_results with token counts and inserts into token_usage.
 */

import { Client, type ClientConfig } from 'pg';
import { queryOne } from '../db/index';
import { broadcastAll, broadcastAllDurably, type WalEvent } from './sse-hub';
import { logger } from './logger';
import { persistLegacyStoryResultAccounting } from './story-result-persistence';
import {
  acknowledgeTrustedWalRelay,
  relayReadyTrustedWalEvents,
} from './trusted-wal';

// ── Backoff Configuration ───────────────────────────────────────────────

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const CHANNEL = 'wal_events';

// ── State ───────────────────────────────────────────────────────────────

let client: Client | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

// ── Token Usage Recording ───────────────────────────────────────────────

async function handleTokenTracking(event: WalEvent): Promise<void> {
  if (!event.story_id || !event.payload) return;
  // Canonical story-result outbox events already committed their keyed
  // accounting projection in the same transaction. Only legacy WAL may backfill.
  if (event.trust_provenance === 'host' && event.trusted_source === 'story-result') return;
  if (event.event_type !== 'story_passed' && event.event_type !== 'story_failed') return;

  try {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    if (payload.input_tokens == null && payload.output_tokens == null
      && payload.reasoning_tokens == null && payload.cost_usd == null) return;
    const runId = Number(payload.run_id);
    if (!Number.isSafeInteger(runId) || runId <= 0) return;

    // The shared compatibility transaction refuses ingest-keyed canonical
    // results and binds legacy accounting to one story_result_id. Therefore a
    // WAL notification can neither double-account nor repair a partial
    // canonical projection accidentally.
    await persistLegacyStoryResultAccounting({
      runId,
      storyId: event.story_id,
      inputTokens: payload.input_tokens,
      outputTokens: payload.output_tokens,
      reasoningTokens: payload.reasoning_tokens,
      modelUsed: payload.model,
      costUsd: payload.cost_usd,
    });
  } catch (error) {
    logger.debug({ err: error, eventId: event.id }, '[wal-listener] Legacy token projection skipped');
  }
}

// ── Client Config Builder ───────────────────────────────────────────────

function buildClientConfig(): ClientConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const searchPathOption = '--search_path=rorca,public';

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      options: searchPathOption,
      // statement_timeout not needed — LISTEN is a long-lived idle connection
    };
  }

  return {
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'rorca',
    password: process.env.PGPASSWORD || 'rorca',
    database: process.env.PGDATABASE || 'rorca',
    options: searchPathOption,
  };
}

// ── Connection Management ───────────────────────────────────────────────

function scheduleReconnect(): void {
  if (stopped) return;
  if (reconnectTimer) return; // already scheduled

  logger.info({ backoffMs }, `[wal-listener] Reconnecting in ${backoffMs}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);

  // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s (capped)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function resetBackoff(): void {
  backoffMs = INITIAL_BACKOFF_MS;
}

function toWalEvent(row: Record<string, unknown>): WalEvent {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    event_type: String(row.event_type),
    workspace_id: row.workspace_id == null ? null : String(row.workspace_id),
    spec_id: row.spec_id == null ? null : String(row.spec_id),
    story_id: row.story_id == null ? null : String(row.story_id),
    actor: row.actor == null ? 'system' : String(row.actor),
    payload: typeof row.payload === 'string'
      ? row.payload
      : row.payload != null ? JSON.stringify(row.payload) : null,
    ingest_key: row.ingest_key == null ? null : String(row.ingest_key),
    trust_provenance: row.trust_provenance === 'host' ? 'host' : 'untrusted',
    trusted_source: row.trusted_source === 'execution-engine'
      || row.trusted_source === 'worker'
      || row.trusted_source === 'story-result'
      ? row.trusted_source
      : null,
    canonical_run_id: row.canonical_run_id == null ? null : String(row.canonical_run_id),
    story_result_id: row.story_result_id == null ? null : String(row.story_result_id),
    event_identity_hash: row.event_identity_hash == null ? null : String(row.event_identity_hash),
    outbox_ready_at: row.outbox_ready_at == null ? null : String(row.outbox_ready_at),
    outbox_relayed_at: row.outbox_relayed_at == null ? null : String(row.outbox_relayed_at),
  };
}

async function dispatchWalRow(row: Record<string, unknown>): Promise<void> {
  const event = toWalEvent(row);
  if (event.trust_provenance === 'host') {
    await broadcastAllDurably(event);
    // Acknowledgement records durable local projection acceptance only. GitHub
    // provider completion has its own claimable/retryable ledger state.
    await acknowledgeTrustedWalRelay(event.id);
  } else {
    broadcastAll(event);
  }
  handleTokenTracking(event).catch((err) => {
    logger.debug({ err, eventId: event.id }, '[wal-listener] Token tracking error');
  });
}

async function connect(): Promise<void> {
  if (stopped) return;

  // Clean up any existing client
  if (client) {
    client.removeAllListeners();
    try { await client.end(); } catch { /* ignore */ }
    client = null;
  }

  try {
    client = new Client(buildClientConfig());

    client.on('error', (err) => {
      logger.error({ err }, '[wal-listener] Client error — scheduling reconnect');
      scheduleReconnect();
    });

    client.on('end', () => {
      if (!stopped) {
        logger.warn('[wal-listener] Connection ended — scheduling reconnect');
        scheduleReconnect();
      }
    });

    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;

      try {
        const row = JSON.parse(msg.payload) as Record<string, unknown>;
        const trustedWalId = Number(row.trusted_wal_id);
        if (Number.isSafeInteger(trustedWalId) && trustedWalId > 0) {
          queryOne<Record<string, unknown>>(
            `SELECT * FROM wal_events
              WHERE id = $1 AND trust_provenance = 'host'`,
            [trustedWalId],
          ).then(async (trustedRow) => {
            if (trustedRow) await dispatchWalRow(trustedRow);
          }).catch((err) => {
            logger.warn({ err, trustedWalId }, '[wal-listener] Failed to resolve trusted WAL relay pointer');
          });
          return;
        }
        void dispatchWalRow(row);
      } catch (err) {
        logger.warn({ err, raw: msg.payload?.substring(0, 200) }, '[wal-listener] Failed to parse notification payload');
      }
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);

    // Recover only rows released after their host ordering boundary. Rows from
    // a result transaction that crashed before local pass remain inert until
    // duplicate re-finalization releases the exact same outbox reference.
    await relayReadyTrustedWalEvents();

    resetBackoff();
    logger.info('[wal-listener] Connected and listening on channel "wal_events"');
  } catch (err) {
    logger.error({ err }, '[wal-listener] Failed to connect');
    client = null;
    scheduleReconnect();
  }
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Start the dedicated LISTEN connection. Call once at server startup.
 * Automatically reconnects with exponential backoff on connection loss.
 */
export function startWalListener(): void {
  stopped = false;
  connect();
}

/**
 * Stop the LISTEN connection and cancel any pending reconnect.
 * Call on graceful shutdown.
 */
export async function stopWalListener(): Promise<void> {
  stopped = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (client) {
    client.removeAllListeners();
    try {
      await client.end();
    } catch {
      // ignore end errors during shutdown
    }
    client = null;
  }

  logger.info('[wal-listener] Stopped');
}
