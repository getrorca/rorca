/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import PgBoss from 'pg-boss';
import { CronExpressionParser } from 'cron-parser';
import { query, execute } from '../db/index';
import { INTERNAL_SERVICE_TOKEN } from '../lib/auth-utils';
import { createBackup, pruneOldBackups } from './backup';
import { logger } from './logger';
import { pruneExpiredMcpAuditLogs, runMcpAuditAnomalyScan } from './mcp-audit';
import { getRunPtyRetentionDays, pruneExpiredRunPtyCaptures } from './run-pty-store';

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
}): Promise<void> {
  const specPath = `forge/specs/approved/${schedule.spec_id}.json`;

  const port = process.env.PORT || 3030;
  try {
    const body: Record<string, unknown> = {
      specPath,
      workspaceId: schedule.workspace_id,
      autoWorktree: false,
      triggerType: 'scheduled',
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
      return;
    }

    if (!resp.ok) {
      logger.error({ error: respBody.error }, `[Scheduler] Trigger failed for schedule ${schedule.id}`);
      return;
    }

    logger.info(`[Scheduler] Triggered run ${respBody.runId} for schedule ${schedule.id} (spec: ${schedule.spec_id})`);
  } catch (error) {
    logger.error({ error }, `[Scheduler] HTTP trigger failed for schedule ${schedule.id}`);
  }
}

/**
 * isDue — returns true if the schedule is due to fire based on its cron expression
 * and last_triggered_at. Used by the pg-boss cron handler to determine which
 * pipeline_schedules to fire on each minute tick.
 */
export function isDue(schedule: { cron_expression: string; last_triggered_at: string | null }): boolean {
  try {
    const interval = CronExpressionParser.parse(schedule.cron_expression);
    const prevDue = interval.prev().toDate();
    const lastTriggered = schedule.last_triggered_at ? new Date(schedule.last_triggered_at) : null;
    if (!lastTriggered) return true;
    return prevDue.getTime() > lastTriggered.getTime();
  } catch {
    return false;
  }
}

/**
 * checkAndFireDueSchedules — check all enabled pipeline_schedules and fire any
 * that are due. Called by the pg-boss `pipeline:cron` job handler in the worker.
 *
 * pg-boss provides distributed locking via the `pipeline:cron` schedule so this
 * fires exactly once per minute even with multiple worker instances running.
 */
export async function checkAndFireDueSchedules(): Promise<void> {
  try {
    const schedules = await query<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE enabled = true',
      [],
    );

    for (const schedule of schedules) {
      if (isDue(schedule)) {
        // Update last_triggered_at immediately to prevent double-firing
        await execute(
          `UPDATE pipeline_schedules SET last_triggered_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [schedule.id],
        );

        triggerScheduledRun(schedule).catch(err => {
          logger.error({ err }, `[Scheduler] Unhandled error for schedule ${schedule.id}`);
        });
      }
    }
  } catch (error) {
    logger.error({ error }, '[Scheduler] checkAndFireDueSchedules error');
  }
}

/**
 * Compute the pg-boss schedule name for a given schedule ID.
 * Used by route handlers for boss.schedule() / boss.unschedule() calls.
 * Must be consistent everywhere.
 */
export function scheduleName(scheduleId: number): string {
  return `pipeline:cron:${scheduleId}`;
}

/**
 * PIPELINE_CRON_QUEUE — the single pg-boss queue used for all cron-triggered
 * pipeline runs. A single schedule entry fires into this queue every minute;
 * pg-boss distributed locking ensures exactly one fire per minute across all
 * worker instances. The handler then checks pipeline_schedules for due entries.
 *
 * Individual per-schedule entries (pipeline:cron:<id>) are ALSO registered so
 * pg-boss provides a per-schedule distributed lock: exactly one trigger per
 * schedule interval even with N workers.
 */
export const PIPELINE_CRON_QUEUE = 'pipeline:cron';

/**
 * registerSchedulesWithBoss — on worker startup:
 * 1. Register a single `pipeline:cron` schedule that fires every minute.
 *    The handler calls checkAndFireDueSchedules() — which checks all enabled
 *    pipeline_schedules for due entries. pg-boss distributed locking prevents
 *    double-firing across multiple workers.
 * 2. Also register individual per-schedule boss.schedule() entries (pipeline:cron:<id>)
 *    for additional per-schedule granularity. These queue jobs are handled by the
 *    same pipeline:cron handler via triggerScheduledRun() directly.
 *
 * Re-registration is idempotent — safe on every worker restart.
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

  // 2. Also register per-schedule entries for direct distributed-lock firing
  try {
    const schedules = await query<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE enabled = true',
      [],
    );

    for (const schedule of schedules) {
      const name = scheduleName(schedule.id);
      const data = {
        scheduleId: schedule.id,
        specId: schedule.spec_id,
        workspaceId: schedule.workspace_id,
        agent: schedule.agent ?? null,
        model: schedule.model ?? null,
      };

      try {
        // pg-boss v10: createQueue() must precede schedule() and work() — idempotent
        await boss.createQueue(name);
        await boss.schedule(name, schedule.cron_expression, data);
        // Each per-schedule queue needs its own worker subscription
        await boss.work(name, cronJobHandler);
        logger.info(`[Scheduler] Registered per-schedule ${name} (${schedule.cron_expression})`);
      } catch (perErr) {
        logger.error({ err: perErr, scheduleId: schedule.id }, `[Scheduler] Failed to register ${name}`);
      }
    }

    logger.info(`[Scheduler] Registered ${schedules.length} per-schedule entrie(s) with pg-boss`);
  } catch (error) {
    logger.error({ error }, '[Scheduler] Failed to load schedules from DB');
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
  logger.info({ deletedRows, retentionDays }, '[Scheduler] PTY capture retention run completed');
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
