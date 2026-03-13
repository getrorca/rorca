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

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('[pg-boss] DATABASE_URL is not set — cannot initialise pg-boss');
  }

  const boss = new PgBoss({
    connectionString,
    // Keep pg-boss internal tables in their own schema (pgboss.*)
    schema: 'pgboss',
    // Archive completed jobs every 2 minutes; expire after 7 days
    maintenanceIntervalSeconds: 120,
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,
  });

  boss.on('error', (err) => {
    logger.error({ err }, '[pg-boss] internal error');
  });

  // boss.start() creates / migrates the pgboss schema automatically
  await boss.start();

  // pg-boss v10: queues must be explicitly created before send() or work() can use them.
  // createQueue() is idempotent — safe to call on every startup.
  await ensureQueues(boss);

  bossInstance = boss;
  logger.info('[pg-boss] started — schema ready');
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
  logger.debug('[pg-boss] ensureQueues — pipeline:run, pipeline:retry, pipeline:cancel, pipeline:cron created');
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
