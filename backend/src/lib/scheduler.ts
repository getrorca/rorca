import { CronExpressionParser } from 'cron-parser';
import { db } from '../db/index';
import { INTERNAL_SERVICE_TOKEN } from '../routes/auth';

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
  const specPath = `ralph/specs/approved/${schedule.spec_id}.json`;

  const port = process.env.PORT || 3030;
  try {
    const resp = await fetch(`http://localhost:${port}/api/pipeline/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Rorcha-Internal': INTERNAL_SERVICE_TOKEN,
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
      console.log(`[Scheduler] Skipped schedule ${schedule.id} — active run conflict`);
      return;
    }

    if (!resp.ok) {
      console.error(`[Scheduler] Trigger failed for schedule ${schedule.id}:`, body.error);
      return;
    }

    console.log(`[Scheduler] Triggered run ${body.runId} for schedule ${schedule.id} (spec: ${schedule.spec_id})`);
  } catch (error) {
    console.error(`[Scheduler] HTTP trigger failed for schedule ${schedule.id}:`, error);
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

function checkSchedules(): void {
  try {
    const schedules = db.prepare(
      'SELECT * FROM pipeline_schedules WHERE enabled = 1'
    ).all() as ScheduleRow[];

    for (const schedule of schedules) {
      if (isDue(schedule)) {
        // Update last_triggered_at immediately to prevent double-firing
        db.prepare(
          `UPDATE pipeline_schedules SET last_triggered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        ).run(schedule.id);

        triggerScheduledRun(schedule).catch(err => {
          console.error(`[Scheduler] Unhandled error for schedule ${schedule.id}:`, err);
        });
      }
    }
  } catch (error) {
    console.error('[Scheduler] Check error:', error);
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (intervalHandle) return;
  console.log('[Scheduler] Starting — checking every 60s');
  intervalHandle = setInterval(checkSchedules, 60_000);
  // Run immediately on startup to catch any missed triggers
  checkSchedules();
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[Scheduler] Stopped');
  }
}
