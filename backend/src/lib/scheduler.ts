/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import PgBoss from 'pg-boss';
import { CronExpressionParser } from 'cron-parser';
import { query, execute, transaction } from '../db/index';
import { INTERNAL_SERVICE_TOKEN } from '../lib/auth-utils';
import { createBackup, getBackupDir, pruneOldBackups } from './backup';
import { logger } from './logger';
import { pruneExpiredMcpAuditLogs, runMcpAuditAnomalyScan } from './mcp-audit';
import { getRunPtyRetentionDays, pruneExpiredRunPtyCaptures } from './run-pty-store';
import { runPtyRetention } from './pty-operations';
import { isReleaseOneCapabilityEnabled } from './release-one-capability-profile';

interface ScheduleRow {
  id: number;
  workspace_id: string;
  spec_id: string;
  cron_expression: string;
  enabled: boolean;
  last_triggered_at: string | null;
  agent?: string | null;
  model?: string | null;
}

export type CronJobHandler = (jobs: PgBoss.Job<Record<string, unknown>>[]) => Promise<void>;

/**
 * Trigger a scheduled pipeline run by making an internal HTTP request to the
 * pipeline trigger endpoint. This reuses all existing conflict detection,
 * worktree creation, hook execution, and output buffering logic.
 */
export async function triggerScheduledRun(schedule: {
  id: number;
  workspace_id: string;
  spec_id: string;
  agent?: string | null;
  model?: string | null;
}, requestKey: string): Promise<{ accepted: boolean; runId: number | null; reason: string }> {
  if (!isReleaseOneCapabilityEnabled('scheduled_autonomy')) {
    return { accepted: false, runId: null, reason: 'RELEASE_ONE_CAPABILITY_DISABLED:scheduled_autonomy' };
  }
  if (!requestKey) {
    return { accepted: false, runId: null, reason: 'missing_idempotency_key' };
  }
  const specPath = `forge/specs/approved/${schedule.spec_id}.json`;

  const port = process.env.PORT || 3030;
  try {
    const preflightBody: Record<string, unknown> = {
      specPath,
      workspaceId: schedule.workspace_id,
      autoWorktree: false,
      orchestrationMode: 'sequential',
      parallelism: 1,
    };
    if (schedule.agent) preflightBody.agentOverride = schedule.agent;
    if (schedule.model) preflightBody.modelOverride = schedule.model;

    const preflightResp = await fetch(`http://localhost:${port}/api/pipeline/preflight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rorca-Internal': INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify(preflightBody),
    });
    const preflightResult = await preflightResp.json() as Record<string, unknown>;
    if (!preflightResp.ok) {
      logger.error({ error: preflightResult.error }, `[Scheduler] Preflight failed for schedule ${schedule.id}`);
      return { accepted: false, runId: null, reason: String(preflightResult.code ?? 'preflight_failed') };
    }
    const preview = preflightResult.preview as Record<string, unknown> | undefined;
    if (typeof preview?.previewHash !== 'string' || typeof preview.expiresAt !== 'string') {
      return { accepted: false, runId: null, reason: 'invalid_preflight_response' };
    }

    const body: Record<string, unknown> = {
      ...preflightBody,
      triggerType: 'scheduled',
      idempotencyKey: requestKey,
      previewHash: preview.previewHash,
      previewExpiresAt: preview.expiresAt,
    };
    if (schedule.agent) body.agentOverride = schedule.agent;
    if (schedule.model) body.modelOverride = schedule.model;

    const resp = await fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rorca-Internal': INTERNAL_SERVICE_TOKEN,
        'Idempotency-Key': requestKey,
      },
      body: JSON.stringify(body),
    });

    const respBody = await resp.json() as Record<string, unknown>;

    if (respBody.conflict) {
      logger.info(`[Scheduler] Skipped schedule ${schedule.id} — active run conflict`);
      return { accepted: true, runId: null, reason: 'active_run_conflict' };
    }

    if (!resp.ok) {
      logger.error({ error: respBody.error }, `[Scheduler] Trigger failed for schedule ${schedule.id}`);
      return { accepted: false, runId: null, reason: String(respBody.code ?? 'trigger_failed') };
    }

    const runId = Number(respBody.runId);
    logger.info(`[Scheduler] Triggered run ${respBody.runId} for schedule ${schedule.id} (spec: ${schedule.spec_id})`);
    return { accepted: true, runId: Number.isSafeInteger(runId) && runId > 0 ? runId : null, reason: 'dispatched' };
  } catch (error) {
    logger.error({ error }, `[Scheduler] HTTP trigger failed for schedule ${schedule.id}`);
    return { accepted: false, runId: null, reason: 'transport_failure' };
  }
}

/**
 * isDue — returns true if the schedule is due to fire based on its cron expression
 * and last_triggered_at. Used by the pg-boss cron handler to determine which
 * pipeline_schedules to fire on each minute tick.
 */
export function scheduledOccurrence(schedule: { cron_expression: string; last_triggered_at: string | null }): Date | null {
  try {
    const interval = CronExpressionParser.parse(schedule.cron_expression);
    const previous = interval.prev().toDate();
    const lastTriggered = schedule.last_triggered_at ? new Date(schedule.last_triggered_at) : null;
    return !lastTriggered || previous.getTime() > lastTriggered.getTime() ? previous : null;
  } catch {
    return null;
  }
}

export function isDue(schedule: { cron_expression: string; last_triggered_at: string | null }): boolean {
  return scheduledOccurrence(schedule) !== null;
}

/**
 * checkAndFireDueSchedules — check all enabled pipeline_schedules and fire any
 * that are due. Called by the pg-boss `pipeline:cron` job handler in the worker.
 *
 * pg-boss provides distributed locking via the `pipeline:cron` schedule so this
 * fires exactly once per minute even with multiple worker instances running.
 */
interface ScheduleOccurrenceRow extends ScheduleRow {
  occurrence_id: number;
  request_key: string;
}

async function dispatchScheduleOccurrence(occurrence: ScheduleOccurrenceRow): Promise<void> {
  const leaseOwner = `schedule-dispatch:${process.pid}:${crypto.randomUUID()}`;
  const claimed = await query<{ id: number }>(
    `UPDATE pipeline_schedule_occurrences
        SET status = 'dispatching', lease_owner = $2,
            lease_expires_at = NOW() + INTERVAL '2 minutes',
            attempt_count = attempt_count + 1, last_attempt_at = NOW()
      WHERE id = $1
        AND (status = 'claimed' OR (status = 'dispatching' AND lease_expires_at <= NOW()))
      RETURNING id`,
    [occurrence.occurrence_id, leaseOwner],
  );
  if (claimed.length !== 1) return;

  const outcome = await triggerScheduledRun(occurrence, occurrence.request_key);
  const completed = await execute(
    `UPDATE pipeline_schedule_occurrences
        SET status = CASE WHEN $3 THEN 'dispatched' ELSE 'claimed' END,
            dispatched_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
            run_id = CASE WHEN $3 THEN $4 ELSE run_id END,
            last_error_code = CASE WHEN $3 THEN NULL ELSE $5 END,
            lease_owner = NULL, lease_expires_at = NULL
      WHERE id = $1 AND status = 'dispatching' AND lease_owner = $2`,
    [occurrence.occurrence_id, leaseOwner, outcome.accepted, outcome.runId, outcome.reason],
  );
  if (completed.rowCount !== 1) {
    throw new Error(`[Scheduler] occurrence ${occurrence.occurrence_id} lost its application dispatch lease`);
  }
}

export async function checkAndFireDueSchedules(): Promise<void> {
  if (!isReleaseOneCapabilityEnabled('scheduled_autonomy')) return;
  try {
    const pending = await query<ScheduleOccurrenceRow>(
      `SELECT schedule.*, occurrence.id AS occurrence_id, occurrence.request_key
       FROM pipeline_schedule_occurrences occurrence
       JOIN pipeline_schedules schedule ON schedule.id = occurrence.schedule_id
       WHERE (occurrence.status = 'claimed'
              OR (occurrence.status = 'dispatching' AND occurrence.lease_expires_at <= NOW()))
         AND schedule.enabled = TRUE
       ORDER BY occurrence.id ASC LIMIT 100`,
      [],
    );
    for (const occurrence of pending) await dispatchScheduleOccurrence(occurrence);

    const schedules = await query<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE enabled = true ORDER BY id',
      [],
    );
    for (const schedule of schedules) {
      const occurrenceAt = scheduledOccurrence(schedule);
      if (!occurrenceAt) continue;
      const requestKey = `schedule:${schedule.id}:${occurrenceAt.toISOString()}`;
      const claimed = await transaction(async (client) => {
        const inserted = (await client.query<{ occurrence_id: number }>(
          `INSERT INTO pipeline_schedule_occurrences (
             schedule_id, workspace_id, scheduled_for, request_key, status
           ) VALUES ($1,$2,$3,$4,'claimed')
           ON CONFLICT (schedule_id, scheduled_for) DO NOTHING
           RETURNING id AS occurrence_id`,
          [schedule.id, schedule.workspace_id, occurrenceAt.toISOString(), requestKey],
        )).rows[0];
        if (!inserted) return null;
        const advanced = await client.query(
          `UPDATE pipeline_schedules
           SET last_triggered_at = $2, updated_at = NOW()
           WHERE id = $1 AND enabled = TRUE
             AND (last_triggered_at IS NULL OR last_triggered_at < $2)
           RETURNING id`,
          [schedule.id, occurrenceAt.toISOString()],
        );
        if (advanced.rowCount !== 1) {
          await client.query('DELETE FROM pipeline_schedule_occurrences WHERE id = $1', [inserted.occurrence_id]);
          return null;
        }
        return { ...schedule, occurrence_id: inserted.occurrence_id, request_key: requestKey };
      });
      if (claimed) await dispatchScheduleOccurrence(claimed);
    }
  } catch (error) {
    logger.error({ error }, '[Scheduler] checkAndFireDueSchedules error');
    throw error;
  }
}

/**
 * PIPELINE_CRON_QUEUE — the single pg-boss queue used for all cron-triggered
 * pipeline runs. A single schedule entry fires into this queue every minute;
 * pg-boss distributed locking ensures exactly one fire per minute across all
 * worker instances. The handler then checks pipeline_schedules for due entries.
 *
 * Application-owned occurrence rows provide the per-schedule exactly-once
 * claim. No dynamic per-schedule pg-boss queues or schedules exist.
 */
export const PIPELINE_CRON_QUEUE = 'pipeline:cron';

/**
 * registerSchedulesWithBoss — on worker startup:
 * 1. Register a single `pipeline:cron` schedule that fires every minute.
 *    The handler calls checkAndFireDueSchedules() — which checks all enabled
 *    pipeline_schedules for due entries. pg-boss distributed locking prevents
 *    double-firing across multiple workers.
 * Application rows reconcile create/update/delete and restart without dynamic
 * queue subscriptions. Re-registration is idempotent on every worker restart.
 */
export async function registerSchedulesWithBoss(
  boss: PgBoss,
  cronJobHandler: CronJobHandler,
): Promise<void> {
  if (!isReleaseOneCapabilityEnabled('scheduled_autonomy')) {
    logger.info('[Scheduler] Release-1 scheduled autonomy is disabled; meta-cron was not registered');
    return;
  }
  // 1. Register the meta-cron: fires every minute, handler checks all due schedules.
  // pipeline:cron queue is already created by ensureQueues() in initBoss(), but
  // createQueue() is idempotent — safe to call again for explicit documentation.
  try {
    await boss.createQueue(PIPELINE_CRON_QUEUE);
    await boss.schedule(PIPELINE_CRON_QUEUE, '* * * * *', {});
    await boss.work(PIPELINE_CRON_QUEUE, cronJobHandler);
    logger.info('[Scheduler] Registered meta-cron pipeline:cron (every minute)');
  } catch (err) {
    logger.error({ err }, '[Scheduler] Failed to register meta-cron pipeline:cron');
  }

}

// ─── Daily backup cron ──────────────────────────────────────────────────────

let lastBackupDate: string | null = null;
const BACKUP_RETRY_DELAY_MS = 15 * 60 * 1_000;
let nextBackupAttemptAt = 0;

let backupIntervalHandle: ReturnType<typeof setInterval> | null = null;
let lastMcpAuditPruneDate: string | null = null;
let lastRunPtyPruneDate: string | null = null;
let mcpAuditAnomalyHandle: ReturnType<typeof setInterval> | null = null;
let mcpAuditRetentionHandle: ReturnType<typeof setInterval> | null = null;
let runPtyRetentionHandle: ReturnType<typeof setInterval> | null = null;

async function checkDailyBackup(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (lastBackupDate === today) return;

  const now = new Date();
  // Run daily backup at 2:00 AM local time
  if (now.getHours() < 2) return;
  if (Date.now() < nextBackupAttemptAt) return;

  // Persisted freshness guard: the in-memory lastBackupDate resets on every
  // process restart, which previously re-triggered the multi-GB pg_dump and
  // starved engine boots of migration locks for minutes at a time. Skip when
  // any backup file is less than 24h old so restarts never re-dump.
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const backupDir = getBackupDir();
    const files = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((name) => name.startsWith('rorca-backup-') && name.endsWith('.sql'))
      : [];
    if (files.length > 0) {
      const newestMs = Math.max(...files.map((name) => fs.statSync(path.join(backupDir, name)).mtimeMs));
      const ageMs = Date.now() - newestMs;
      if (ageMs < 24 * 60 * 60 * 1_000) {
        lastBackupDate = today;
        logger.info(`[Scheduler] Backup skipped — newest backup file is ${Math.round(ageMs / 60_000)}m old`);
        return;
      }
    }
  } catch {
    // Backups must never be blocked by a freshness-check failure.
  }

  lastBackupDate = today;
  try {
    const result = await createBackup();
    const pruned = pruneOldBackups();
    logger.info(`[Scheduler] Daily backup created: ${result.filename} (${result.size} bytes), pruned ${pruned}`);
    nextBackupAttemptAt = 0;

  } catch (error) {
    logger.error({ error }, '[Scheduler] Daily backup failed');
    // Do not turn a persistent failure into a minute-by-minute fork storm.
    lastBackupDate = null;
    nextBackupAttemptAt = Date.now() + BACKUP_RETRY_DELAY_MS;
  }
}

export function startDailyBackupScheduler(): void {
  if (backupIntervalHandle) return;
  logger.info('[Scheduler] Starting daily backup check — running every 60s');
  backupIntervalHandle = setInterval(() => {
    checkDailyBackup().catch(err => logger.error({ err }, '[Scheduler] Backup check error'));
  }, 60_000);
  // Run immediately on startup
  checkDailyBackup().catch(err => logger.error({ err }, '[Scheduler] Initial backup check error'));
}

export function stopDailyBackupScheduler(): void {
  if (backupIntervalHandle) {
    clearInterval(backupIntervalHandle);
    backupIntervalHandle = null;
    logger.info('[Scheduler] Daily backup scheduler stopped');
  }
}

async function checkDailyMcpAuditRetention(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastMcpAuditPruneDate === today) return;

  const now = new Date();
  // Run after backup window to reduce startup churn.
  if (now.getHours() < 3) return;

  lastMcpAuditPruneDate = today;
  const deletedRows = await pruneExpiredMcpAuditLogs();
  logger.info({ deletedRows }, '[Scheduler] MCP audit retention run completed');
}

export function startMcpAuditScheduler(): void {
  if (!mcpAuditAnomalyHandle) {
    logger.info('[Scheduler] Starting MCP audit anomaly scan — running every 5m');
    mcpAuditAnomalyHandle = setInterval(() => {
      // P1 only detects and logs anomalies. It does not auto-block to avoid lockouts.
      runMcpAuditAnomalyScan().catch((err) => logger.error({ err }, '[Scheduler] MCP audit anomaly scan error'));
    }, 5 * 60_000);
    mcpAuditAnomalyHandle.unref();
    runMcpAuditAnomalyScan().catch((err) => logger.error({ err }, '[Scheduler] Initial MCP audit anomaly scan error'));
  }

  if (!mcpAuditRetentionHandle) {
    logger.info('[Scheduler] Starting MCP audit retention check — running every 60s');
    mcpAuditRetentionHandle = setInterval(() => {
      checkDailyMcpAuditRetention().catch((err) => logger.error({ err }, '[Scheduler] MCP audit retention check error'));
    }, 60_000);
    mcpAuditRetentionHandle.unref();
    checkDailyMcpAuditRetention().catch((err) => logger.error({ err }, '[Scheduler] Initial MCP audit retention check error'));
  }
}

async function checkDailyRunPtyRetention(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  if (lastRunPtyPruneDate === today) return;

  const now = new Date();
  if (now.getHours() < 4) return;

  lastRunPtyPruneDate = today;
  const retentionDays = getRunPtyRetentionDays();
  const deletedRows = await pruneExpiredRunPtyCaptures(retentionDays);
  const artifactRetention = await runPtyRetention(false);
  logger.info({ deletedRows, retentionDays, artifactRetention }, '[Scheduler] PTY capture retention run completed');
}

export function startRunPtyRetentionScheduler(): void {
  if (runPtyRetentionHandle) return;

  logger.info('[Scheduler] Starting PTY capture retention check — running every 60s');
  runPtyRetentionHandle = setInterval(() => {
    checkDailyRunPtyRetention().catch((err) => logger.error({ err }, '[Scheduler] PTY capture retention check error'));
  }, 60_000);
  runPtyRetentionHandle.unref();
  checkDailyRunPtyRetention().catch((err) => logger.error({ err }, '[Scheduler] Initial PTY capture retention check error'));
}

export function stopMcpAuditScheduler(): void {
  if (mcpAuditAnomalyHandle) {
    clearInterval(mcpAuditAnomalyHandle);
    mcpAuditAnomalyHandle = null;
  }
  if (mcpAuditRetentionHandle) {
    clearInterval(mcpAuditRetentionHandle);
    mcpAuditRetentionHandle = null;
  }
}

export function stopRunPtyRetentionScheduler(): void {
  if (!runPtyRetentionHandle) return;
  clearInterval(runPtyRetentionHandle);
  runPtyRetentionHandle = null;
}

// ─── Legacy API shim (used by server.ts) ────────────────────────────────────
// The Express server no longer handles cron scheduling (that's the worker's job),
// but it still manages the daily backup interval.

export function startScheduler(): void {
  startDailyBackupScheduler();
  startMcpAuditScheduler();
  startRunPtyRetentionScheduler();
}

export function stopScheduler(): void {
  stopDailyBackupScheduler();
  stopMcpAuditScheduler();
  stopRunPtyRetentionScheduler();
}
