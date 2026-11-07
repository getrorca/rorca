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
import { Pool } from 'pg';
import { logger } from './logger';
import { getPgBossSchemaName } from './pg-boss-schema';
export { getPgBossSchemaName, getPgBossSchemaSql, getPgBossTableSql } from './pg-boss-schema';

let bossInstance: PgBoss | null = null;
let bossInitPromise: Promise<void> | null = null;

export async function prepareSplitPrincipalPgBoss(connectionString:string,schema:string):Promise<void>{
  if(!/^pgboss(?:_[a-z0-9_]{1,48})?$/.test(schema))throw new Error('[pg-boss] invalid split-principal schema');
  const runtimeUser=String(process.env.RORCA_RUNTIME_DATABASE_USER??'').trim();
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeUser))throw new Error('[pg-boss] exact runtime database principal is required');
  const installer=new PgBoss({connectionString,schema,supervise:false});
  try{await installer.start();}finally{await installer.stop({graceful:false});}
  const pool=new Pool({connectionString,max:1});
  try{
    await pool.query(`ALTER FUNCTION ${schema}.create_queue(text,json) SECURITY DEFINER`);
    await pool.query(`ALTER FUNCTION ${schema}.create_queue(text,json) SET search_path=pg_catalog`);
    await pool.query(`ALTER FUNCTION ${schema}.delete_queue(text) SECURITY DEFINER`);
    await pool.query(`ALTER FUNCTION ${schema}.delete_queue(text) SET search_path=pg_catalog`);
    // The migration principal owns pg-boss DDL; the constrained runtime needs
    // only transport-schema data/function authority and never database CREATE.
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeUser}`);
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeUser}`);
    await pool.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${runtimeUser}`);
    await pool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${runtimeUser}`);
  }finally{await pool.end();}
}

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

    const configuredSchema = getPgBossSchemaName();
    const migrationConnectionString=process.env.RORCA_MIGRATION_DATABASE_URL;
    const preapplied=process.env.RORCA_PGBOSS_PREAPPLIED==='true';
    if(preapplied&&migrationConnectionString){
      throw new Error('[pg-boss] pre-applied topology must not inject migration-owner credentials into runtime processes');
    }
    // In split-principal deployments only the migration owner may install or
    // advance pg-boss DDL. Production Compose performs this in a one-shot
    // installer; legacy/dev split setups may still prepare here explicitly.
    if(migrationConnectionString&&migrationConnectionString!==connectionString){
      await prepareSplitPrincipalPgBoss(migrationConnectionString,configuredSchema);
    }
    const boss = new PgBoss({
      connectionString,
      migrate:!(preapplied||(migrationConnectionString&&migrationConnectionString!==connectionString)),
      // pg-boss alone creates/migrates this schema. The override exists for
      // isolated real-runtime certification and parallel service instances.
      schema: configuredSchema,
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
  await boss.createQueue('pipeline:run:direct');
  await boss.createQueue('pipeline:retry');
  await boss.createQueue('pipeline:cancel');
  await boss.createQueue('pipeline:cron');
  await boss.createQueue('pipeline:merge');
  await boss.createQueue('pipeline:closeout-reconcile');
  await boss.createQueue('pipeline:pr-delivery');
  await boss.createQueue('pipeline:lifecycle-assurance');
  await boss.createQueue('pipeline:pre-staging-qualification');
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
  // Fixed bounty queues only: mission identity belongs in the payload, never the queue name.
  await boss.createQueue('bounty:control');
  await boss.createQueue('bounty:work');
  await boss.createQueue('bounty:reconcile');
  await boss.createQueue('bounty:isolated-proposal');
  logger.debug('[pg-boss] ensureQueues — pipeline, reviewed PR delivery, maintenance, context, spec, and fixed bounty queues created');
}

/**
 * getBoss — retrieve the running pg-boss singleton.
 *
 * Throws if called before initBoss() has resolved.
 */
export async function stopBoss(): Promise<void> {
  const boss=bossInstance;bossInstance=null;bossInitPromise=null;
  if (boss) await boss.stop({graceful:false});
}

export function getBoss(): PgBoss {
  if (!bossInstance) {
    throw new Error(
      '[pg-boss] getBoss() called before initBoss() completed. ' +
        'Ensure initBoss() is awaited during process startup.',
    );
  }
  return bossInstance;
}
