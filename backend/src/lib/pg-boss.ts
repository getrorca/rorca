/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * pg-boss.ts — Singleton wrapper for the pg-boss job queue.
 *
 * Usage:
 *   import { initBoss, getBoss } from './pg-boss';
 *
 *   // In startup sequence (after initializeDB):
 *   await initBoss();
 *
 *   // Anywhere after init:
 *   const boss = getBoss();
 *   await boss.send('pipeline:run', { runId: 42 });
 *
 * pg-boss manages its own schema (pgboss.*) via boss.start() — no hand-written
 * migrations are needed for its tables.
 */

import PgBoss from 'pg-boss';
import { logger } from './logger';

let bossInstance: PgBoss | null = null;
let bossInitPromise: Promise<void> | null = null;

/**
 * initBoss — create and start the pg-boss singleton.
 *
 * Must be called once during process startup, after the main DB pool is ready.
 * Calling it a second time is a no-op (idempotent).
 */
export async function initBoss(): Promise<void> {
  if (bossInstance) {
    logger.debug('[pg-boss] already initialised — skipping');
    return;
  }
  if (bossInitPromise) {
    await bossInitPromise;
    return;
  }

  bossInitPromise = (async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('[pg-boss] DATABASE_URL is not set — cannot initialise pg-boss');
    }

    const boss = new PgBoss({
      connectionString,
      // Keep pg-boss internal tables in their own schema (pgboss.*)
      schema: 'pgboss',
      // Data retention and archiving settings (US-001)
      // - Move completed jobs from pgboss.job → pgboss.archive after 1 hour
      archiveCompletedAfterSeconds: 3600,
      // - Keep failed jobs in pgboss.job for 7 days before archiving (longer retention for debugging)
      archiveFailedAfterSeconds: 604800,
      // - Delete archived jobs older than 14 days (balance between retention and table bloat)
      deleteAfterDays: 14,
      // - Retention period: keep archived data for 30 days before hard delete
      retentionDays: 30,
      // - Run maintenance cycle (archive + delete) every 2 minutes
      maintenanceIntervalSeconds: 120,
      // - Fire monitor-states event every 60 seconds with queue health snapshots (required for US-004)
      monitorStateIntervalSeconds: 60,
    });

    boss.on('error', (err) => {
      logger.error({ err }, '[pg-boss] internal error — pg-boss maintenance or connection issue');
    });

    // boss.start() creates / migrates the pgboss schema automatically
    await boss.start();

    // pg-boss v10: queues must be explicitly created before send() or work() can use them.
    // createQueue() is idempotent — safe to call on every startup.
    await ensureQueues(boss);

    bossInstance = boss;
    logger.info('[pg-boss] started — schema ready');
  })();

  try {
    await bossInitPromise;
  } finally {
    bossInitPromise = null;
  }
}

/**
 * ensureQueues — idempotently create all base pipeline queues.
 *
 * pg-boss v10 requires explicit createQueue() before send() or work() can use a queue.
 * This must be called after boss.start() in both the Express server (so send() works
 * without the worker running) and the worker process (so work() registrations succeed).
 *
 * createQueue() is idempotent — calling it multiple times is safe.
 */
export async function ensureQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue('pipeline:run');
  await boss.createQueue('pipeline:retry');
  await boss.createQueue('pipeline:cancel');
  await boss.createQueue('pipeline:cron');
  await boss.createQueue('pipeline:merge');
  await boss.createQueue('pipeline:pr-delivery');
  await boss.createQueue('spec:enrich');
  await boss.createQueue('context:enrich');
  await boss.createQueue('workspace:hydrate');
  await boss.createQueue('context:capture');
  await boss.createQueue('context:distill');
  // pg-boss v10+ requires scheduled queue names to exist before schedule().
  await boss.createQueue('queue-snapshot-prune');
  await boss.createQueue('integration:health-check');
  await boss.createQueue('spec:match-skills');
  await boss.createQueue('spec:memory-synthesis');
  await boss.createQueue('spec:suggest-skills');
  logger.debug('[pg-boss] ensureQueues — pipeline, reviewed PR delivery, maintenance, context capture/distillation, and spec job queues created');
}

/**
 * getBoss — retrieve the running pg-boss singleton.
 *
 * Throws if called before initBoss() has resolved.
 */
export function getBoss(): PgBoss {
  if (!bossInstance) {
    throw new Error(
      '[pg-boss] getBoss() called before initBoss() completed. ' +
        'Ensure initBoss() is awaited during process startup.',
    );
  }
  return bossInstance;
}
