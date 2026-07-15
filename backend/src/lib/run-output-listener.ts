/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * Cross-process wake-up channel for durable run output.
 *
 * Raw output remains authoritative in PostgreSQL for replay. LISTEN/NOTIFY only
 * wakes attached SSE handlers immediately after a committed chunk insert; each
 * handler then reads the durable rows by sequence. A bounded polling fallback in
 * the route preserves delivery across listener reconnects and notification loss.
 */
import { Client, type ClientConfig } from 'pg';
import { logger } from './logger';

const CHANNEL = 'run_output_events';
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

type RunOutputSubscriber = () => void;

const subscribers = new Map<number, Set<RunOutputSubscriber>>();
let client: Client | null = null;
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = INITIAL_BACKOFF_MS;

function buildClientConfig(): ClientConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const options = '--search_path=rorca,public';
  if (databaseUrl) return { connectionString: databaseUrl, options };
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number.parseInt(process.env.PGPORT || '5432', 10),
    user: process.env.PGUSER || 'rorca',
    password: process.env.PGPASSWORD || 'rorca',
    database: process.env.PGDATABASE || 'rorca',
    options,
  };
}

function dispatch(rawPayload: string | undefined): void {
  if (!rawPayload) return;
  try {
    const parsed = JSON.parse(rawPayload) as { runId?: unknown };
    const runId = Number(parsed.runId);
    if (!Number.isSafeInteger(runId) || runId <= 0) return;
    for (const subscriber of subscribers.get(runId) ?? []) {
      try { subscriber(); } catch (err) {
        logger.warn({ err, runId }, '[run-output-listener] subscriber failed');
      }
    }
  } catch (err) {
    logger.warn({ err }, '[run-output-listener] ignored malformed notification');
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, backoffMs);
  reconnectTimer.unref?.();
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function connect(): Promise<void> {
  if (stopped) return;
  if (client) {
    client.removeAllListeners();
    try { await client.end(); } catch { /* disconnected already */ }
  }

  try {
    const next = new Client(buildClientConfig());
    client = next;
    next.on('notification', (message) => {
      if (message.channel === CHANNEL) dispatch(message.payload);
    });
    next.on('error', (err) => {
      logger.warn({ err }, '[run-output-listener] connection lost');
      scheduleReconnect();
    });
    next.on('end', scheduleReconnect);
    await next.connect();
    await next.query(`LISTEN ${CHANNEL}`);
    backoffMs = INITIAL_BACKOFF_MS;
    logger.info('[run-output-listener] listening for committed output chunks');
  } catch (err) {
    logger.warn({ err }, '[run-output-listener] startup failed; SSE polling fallback remains active');
    scheduleReconnect();
  }
}

export function startRunOutputListener(): void {
  if (client || reconnectTimer) return;
  stopped = false;
  void connect();
}

export async function stopRunOutputListener(): Promise<void> {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const active = client;
  client = null;
  if (active) {
    active.removeAllListeners();
    try { await active.end(); } catch { /* disconnected already */ }
  }
}

export function subscribeRunOutput(runId: number, subscriber: RunOutputSubscriber): () => void {
  let runSubscribers = subscribers.get(runId);
  if (!runSubscribers) {
    runSubscribers = new Set();
    subscribers.set(runId, runSubscribers);
  }
  runSubscribers.add(subscriber);
  return () => {
    runSubscribers?.delete(subscriber);
    if (runSubscribers?.size === 0) subscribers.delete(runId);
  };
}

export function publishRunOutputWakeupForTests(runId: number): void {
  dispatch(JSON.stringify({ runId }));
}
