import { Router, Request, Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { db } from '../db/index';
import { parsePaginationParams, paginateArray } from '../lib/paginate';

const router = Router();

interface ScheduleRow {
  id: number;
  workspace_id: string;
  spec_id: string;
  cron_expression: string;
  enabled: number;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
}

function nextRunAt(cronExpression: string): string | null {
  try {
    const interval = CronExpressionParser.parse(cronExpression);
    return interval.next().toISOString();
  } catch {
    return null;
  }
}

// ─── GET /api/pipeline/schedules — List all schedules ─────────────────────────

router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const rows = db.prepare(
      'SELECT * FROM pipeline_schedules WHERE workspace_id = ? ORDER BY created_at DESC'
    ).all(workspaceId) as ScheduleRow[];

    const schedules = rows.map(row => ({
      ...row,
      enabled: !!row.enabled,
      next_run_at: row.enabled ? nextRunAt(row.cron_expression) : null,
    }));

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(schedules, pagination));
  } catch (error: any) {
    console.error('[Schedules] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/pipeline/schedules — Create a new schedule ─────────────────────

router.post('/', (req: Request, res: Response) => {
  try {
    const { workspaceId, specId, cronExpression, enabled } = req.body;

    if (!workspaceId || !specId || !cronExpression) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, specId, cronExpression' });
      return;
    }

    // Validate workspace exists
    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Validate cron expression
    try {
      CronExpressionParser.parse(cronExpression);
    } catch (e: any) {
      res.status(422).json({ error: `Invalid cron expression: ${e.message}` });
      return;
    }

    const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

    const result = db.prepare(
      `INSERT INTO pipeline_schedules (workspace_id, spec_id, cron_expression, enabled)
       VALUES (?, ?, ?, ?)`
    ).run(workspaceId, specId, cronExpression, isEnabled);

    const schedule = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?')
      .get(result.lastInsertRowid) as ScheduleRow;

    res.status(201).json({
      schedule: {
        ...schedule,
        enabled: !!schedule.enabled,
        next_run_at: schedule.enabled ? nextRunAt(schedule.cron_expression) : null,
      },
    });
  } catch (error: any) {
    console.error('[Schedules] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PATCH /api/pipeline/schedules/:id — Update a schedule ────────────────────

router.patch('/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid schedule id' });
      return;
    }

    const existing = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id) as ScheduleRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }

    const { cronExpression, enabled, specId } = req.body;

    if (cronExpression !== undefined) {
      try {
        CronExpressionParser.parse(cronExpression);
      } catch (e: any) {
        res.status(422).json({ error: `Invalid cron expression: ${e.message}` });
        return;
      }
    }

    const newCron = cronExpression ?? existing.cron_expression;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
    const newSpecId = specId ?? existing.spec_id;

    db.prepare(
      `UPDATE pipeline_schedules SET cron_expression = ?, enabled = ?, spec_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newCron, newEnabled, newSpecId, id);

    const updated = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id) as ScheduleRow;

    res.json({
      schedule: {
        ...updated,
        enabled: !!updated.enabled,
        next_run_at: updated.enabled ? nextRunAt(updated.cron_expression) : null,
      },
    });
  } catch (error: any) {
    console.error('[Schedules] Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/pipeline/schedules/:id — Delete a schedule ───────────────────

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid schedule id' });
      return;
    }

    const existing = db.prepare('SELECT * FROM pipeline_schedules WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Schedule not found' });
      return;
    }

    db.prepare('DELETE FROM pipeline_schedules WHERE id = ?').run(id);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('[Schedules] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
