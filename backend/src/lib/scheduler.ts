import { CronExpressionParser } from 'cron-parser';
import { query, execute } from '../db/index';
import { INTERNAL_SERVICE_TOKEN } from '../routes/auth';
import { createBackup, pruneOldBackups } from './backup';
import { logger } from './logger';

interface ScheduleRow {
  id: number;
  workspace_id: string;
  spec_id: string;
  cron_expression: string;
  enabled: number;
  last_triggered_at: string | null;
}

/**
 * Trigger a scheduled pipeline run by making an internal HTTP request to the
 * pipeline trigger endpoint. This reuses all existing conflict detection,
 * worktree creation, hook execution, and output buffering logic.
 */
async function triggerScheduledRun(schedule: ScheduleRow): Promise<void> {
  const specPath = `forge/specs/approved/${schedule.spec_id}.json`;

  const port = process.env.PORT || 3030;
  try {
    const resp = await fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rorca-Internal': INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify({
        specPath,
        workspaceId: schedule.workspace_id,
        autoWorktree: false,
        triggerType: 'scheduled',
      }),
    });

    const body = await resp.json() as Record<string, unknown>;

    if (body.conflict) {
      logger.info(`[Scheduler] Skipped schedule ${schedule.id} — active run conflict`);
      return;
    }

    if (!resp.ok) {
      logger.error({ error: body.error }, `[Scheduler] Trigger failed for schedule ${schedule.id}`);
      return;
    }

    logger.info(`[Scheduler] Triggered run ${body.runId} for schedule ${schedule.id} (spec: ${schedule.spec_id})`);
  } catch (error) {
    logger.error({ error }, `[Scheduler] HTTP trigger failed for schedule ${schedule.id}`);
  }
}

function isDue(schedule: ScheduleRow): boolean {
  try {
    const interval = CronExpressionParser.parse(schedule.cron_expression);
    const prevDue = interval.prev().toDate();
    const lastTriggered = schedule.last_triggered_at ? new Date(schedule.last_triggered_at) : null;

    // Schedule is due if the most recent cron tick hasn't been triggered yet
    if (!lastTriggered) return true;
    return prevDue.getTime() > lastTriggered.getTime();
  } catch {
    return false;
  }
}

async function checkSchedules(): Promise<void> {
  try {
    const schedules = await query<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE enabled = true',
      []
    );

    for (const schedule of schedules) {
      if (isDue(schedule)) {
        // Update last_triggered_at immediately to prevent double-firing
        await execute(
          `UPDATE pipeline_schedules SET last_triggered_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [schedule.id]
        );

        triggerScheduledRun(schedule).catch(err => {
          logger.error({ err }, `[Scheduler] Unhandled error for schedule ${schedule.id}`);
        });
      }
    }
  } catch (error) {
    logger.error({ error }, '[Scheduler] Check error');
  }
}

// ─── Daily backup cron ──────────────────────────────────────────────────────

let lastBackupDate: string | null = null;

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

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (intervalHandle) return;
  logger.info('[Scheduler] Starting — checking every 60s');
  intervalHandle = setInterval(() => {
    checkSchedules().catch(err => logger.error({ err }, '[Scheduler] Check error'));
    checkDailyBackup().catch(err => logger.error({ err }, '[Scheduler] Backup check error'));
  }, 60_000);
  // Run immediately on startup to catch any missed triggers
  checkSchedules().catch(err => logger.error({ err }, '[Scheduler] Initial check error'));
  checkDailyBackup().catch(err => logger.error({ err }, '[Scheduler] Initial backup check error'));
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('[Scheduler] Stopped');
  }
}
