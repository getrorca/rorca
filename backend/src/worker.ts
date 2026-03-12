/**
 * worker.ts — Standalone pg-boss worker process for Rorca.
 *
 * This process is completely independent of the Express server. It connects
 * to the same DATABASE_URL and owns the execution-engine job lifecycle:
 *
 *   pipeline:run    — trigger a new pipeline run
 *   pipeline:retry  — retry failed stories in a completed run
 *   pipeline:cancel — cancel an active run
 *
 * Start: npm run worker
 * Stop:  SIGTERM (graceful) — drains in-flight jobs up to 45 min, then exits
 */

import 'dotenv/config';
import PgBoss from 'pg-boss';
import { logger } from './lib/logger';

// ── Validate environment ─────────────────────────────────────────────────

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.error('[worker] DATABASE_URL is not set — exiting');
  process.exit(1);
}

// ── Bootstrap pg-boss ────────────────────────────────────────────────────

const boss = new PgBoss({
  connectionString: databaseUrl,
  // Schema for pg-boss internal tables — keeps them out of public schema
  schema: 'pgboss',
  // Maintenance interval for job archiving / expiry
  maintenanceIntervalSeconds: 120,
});

boss.on('error', (err) => {
  logger.error({ err }, '[worker] pg-boss internal error');
});

// ── Job handlers ─────────────────────────────────────────────────────────

async function handlePipelineRun(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:run received');
    // Placeholder: execution-engine integration added in PG-003+
  }
}

async function handlePipelineRetry(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:retry received');
    // Placeholder: retry logic added in PG-003+
  }
}

async function handlePipelineCancel(jobs: PgBoss.Job<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    logger.info({ jobId: job.id, data: job.data }, '[worker] pipeline:cancel received');
    // Placeholder: cancel logic added in PG-003+
  }
}

// ── Graceful shutdown ────────────────────────────────────────────────────

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`[worker] received ${signal} — stopping pg-boss (waiting up to 30s for in-flight jobs)`);
  try {
    // pg-boss stop() drains in-flight jobs and closes connections
    await boss.stop({ timeout: 30_000 });
    logger.info('[worker] pg-boss stopped cleanly — exiting');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, '[worker] error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Startup ──────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  try {
    await boss.start();
  } catch (err) {
    logger.error({ err }, '[worker] failed to connect to database or initialize pg-boss schema');
    process.exit(1);
  }

  // Register job queue handlers
  await boss.work('pipeline:run', handlePipelineRun);
  await boss.work('pipeline:retry', handlePipelineRetry);
  await boss.work('pipeline:cancel', handlePipelineCancel);

  logger.info('[worker] pg-boss started, listening for jobs');
}

start();
