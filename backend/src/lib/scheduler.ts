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
import { createBackup, pruneOldBackups } from './backup';
import { logger } from './logger';
import { pruneExpiredMcpAuditLogs, runMcpAuditAnomalyScan } from './mcp-audit';
import { getRunPtyRetentionDays, pruneExpiredRunPtyCaptures } from './run-pty-store';
import { runPtyRetention } from './pty-operations';

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
}, requestKey?: string): Promise<{ accepted: boolean; runId: number | null; reason: string }> {
  const specPath = `forge/specs/approved/${schedule.spec_id}.json`;

  const port = process.env.PORT || 3030;
  try {
    const body: Record<string, unknown> = {
      specPath,
      workspaceId: schedule.workspace_id,
      autoWorktree: false,
      triggerType: 'scheduled',
      orchestrationMode: 'sequential',
      parallelism: 1,
      ...(requestKey ? { idempotencyKey: requestKey } : {}),
    };
    if (schedule.agent) body.agent = schedule.agent;
    if (schedule.model) body.model = schedule.model;

    const resp = await fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rorca-Internal': INTERNAL_SERVICE_TOKEN,
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

  lastBackupDate = today;
  try {
    const result = await createBackup();
    const pruned = pruneOldBackups();
    logger.info(`[Scheduler] Daily backup created: ${result.filename} (${result.size} bytes), pruned ${pruned}`);
  } catch (error) {
    logger.error({ error }, '[Scheduler] Daily backup failed');
    // Reset so it retries next interval
    lastBackupDate = null;
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
