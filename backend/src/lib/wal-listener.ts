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
import { broadcastAll, type WalEvent } from './sse-hub';
import { queryOne, execute } from '../db/index';
import { logger } from './logger';

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

interface ModelPricingRow {
  model_id: string;
  input_cost_per_1k: number;
  output_cost_per_1k: number;
}

async function recordTokenUsage(
  runId: number,
  storyId: string,
  inputTokens: number,
  outputTokens: number,
  model?: string,
  explicitCostUsd?: number,
): Promise<void> {
  const run = await queryOne('SELECT workspace_id FROM pipeline_runs WHERE id = $1', [runId]) as { workspace_id: string } | undefined;
  if (!run) return;

  const modelName = model || 'unknown';
  const pricing = await queryOne('SELECT * FROM model_pricing WHERE model_id = $1', [modelName]) as ModelPricingRow | undefined;

  const derivedCostUsd = pricing
    ? (inputTokens / 1000) * pricing.input_cost_per_1k + (outputTokens / 1000) * pricing.output_cost_per_1k
    : 0;
  const costUsd = explicitCostUsd ?? derivedCostUsd;

  await execute(
    `INSERT INTO token_usage (run_id, story_id, workspace_id, model, input_tokens, output_tokens, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [runId, storyId, run.workspace_id, modelName, inputTokens, outputTokens, Math.round(costUsd * 1_000_000) / 1_000_000],
  );
}

async function handleTokenTracking(event: WalEvent): Promise<void> {
  if (!event.story_id || !event.payload) return;
  if (event.event_type !== 'story_passed' && event.event_type !== 'story_failed') return;

  try {
    const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
    if (payload.input_tokens == null && payload.output_tokens == null) return;

    const runId = payload.run_id;
    if (!runId) return;

    // Update story_results with token counts
    const storyRow = await queryOne(
      'SELECT id FROM story_results WHERE run_id = $1 AND story_id = $2 ORDER BY id DESC LIMIT 1',
      [runId, event.story_id],
    ) as { id: number } | undefined;

    // A missing result means its durable fallback may still be awaiting replay.
    // The canonical story-result transaction owns result/commit/accounting as one
    // unit; never create an orphan accounting row that replay would duplicate.
    if (!storyRow) return;

    await execute(
      `UPDATE story_results
       SET input_tokens = COALESCE($1, input_tokens),
           output_tokens = COALESCE($2, output_tokens),
           cost_usd = COALESCE($3, cost_usd)
       WHERE id = $4`,
      [payload.input_tokens ?? null, payload.output_tokens ?? null, payload.cost_usd ?? null, storyRow.id],
    );

    // Preserve legacy WAL accounting only when canonical result persistence did
    // not already write it. Canonical execution-engine ordering makes this a
    // compatibility backfill, not a competing story-result persistence path.
    const existing = await queryOne(
      'SELECT id FROM token_usage WHERE run_id = $1 AND story_id = $2 LIMIT 1',
      [runId, event.story_id],
    );
    if (!existing) {
      await recordTokenUsage(
        runId,
        event.story_id,
        payload.input_tokens || 0,
        payload.output_tokens || 0,
        payload.model,
        payload.cost_usd,
      );
    }
  } catch {
    // payload parse error — ignore
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
        const row = JSON.parse(msg.payload);

        // Build WalEvent from the notification payload (row_to_json(NEW))
        const event: WalEvent = {
          id: row.id,
          ts: row.ts,
          event_type: row.event_type,
          workspace_id: row.workspace_id ?? null,
          spec_id: row.spec_id ?? null,
          story_id: row.story_id ?? null,
          actor: row.actor ?? 'system',
          payload: typeof row.payload === 'string' ? row.payload : (row.payload != null ? JSON.stringify(row.payload) : null),
        };

        broadcastAll(event);

        // Token tracking (fire-and-forget — errors logged internally)
        handleTokenTracking(event).catch((err) => {
          logger.debug({ err, eventId: event.id }, '[wal-listener] Token tracking error');
        });
      } catch (err) {
        logger.warn({ err, raw: msg.payload?.substring(0, 200) }, '[wal-listener] Failed to parse notification payload');
      }
    });

    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);

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
