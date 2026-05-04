/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { query, queryOne, execute } from '../db/index';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { getBoss } from '../lib/pg-boss';
import { scheduleName } from '../lib/scheduler';
import { logger } from '../lib/logger';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

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

/**
 * @swagger
 * /api/pipeline/schedules:
 *   get:
 *     tags: [Pipeline]
 *     summary: List pipeline schedules for a workspace
 *     operationId: listPipelineSchedules
 *     description: Returns all cron-based pipeline schedules for the specified workspace, including computed next run time.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of schedules
 *       400:
 *         description: Missing workspaceId query parameter
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const rows = await query<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE workspace_id = $1 ORDER BY created_at DESC',
      [workspaceId]
    );

    const schedules = rows.map(row => ({
      ...row,
      enabled: !!row.enabled,
      next_run_at: row.enabled ? nextRunAt(row.cron_expression) : null,
    }));

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(schedules, pagination));
  } catch (error: any) {
    handleRouteError(res, error, '[Schedules] List');
  }
});

/**
 * @swagger
 * /api/pipeline/schedules:
 *   post:
 *     tags: [Pipeline]
 *     summary: Create a new pipeline schedule
 *     operationId: createPipelineSchedule
 *     description: Creates a new cron-based schedule that automatically triggers pipeline runs for a specific spec.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId, cronExpression]
 *             properties:
 *               workspaceId: { type: string }
 *               specId: { type: string }
 *               cronExpression: { type: string, description: "Standard cron expression" }
 *               enabled: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Schedule created
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Workspace not found
 *       422:
 *         description: Invalid cron expression
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { workspaceId, specId, cronExpression, enabled } = req.body;

    if (!workspaceId || !specId || !cronExpression) {
      throw new ValidationError('Missing required fields: workspaceId, specId, cronExpression');
      return;
    }

    // Validate workspace exists
    const workspace = await queryOne<{ id: string }>(
      'SELECT id FROM workspaces WHERE id = $1',
      [workspaceId]
    );
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Validate cron expression
    try {
      CronExpressionParser.parse(cronExpression);
    } catch (e: any) {
      throw new UnprocessableError(`Invalid cron expression: ${e.message}`);
      return;
    }

    const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

    const schedule = await queryOne<ScheduleRow>(
      `INSERT INTO pipeline_schedules (workspace_id, spec_id, cron_expression, enabled)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [workspaceId, specId, cronExpression, isEnabled]
    );

    // Register with pg-boss native scheduling if enabled
    if (schedule!.enabled) {
      try {
        const name = scheduleName(schedule!.id);
        // pg-boss v10: createQueue() must precede schedule() — idempotent
        await getBoss().createQueue(name);
        await getBoss().schedule(name, schedule!.cron_expression, {
          scheduleId: schedule!.id,
          specId: schedule!.spec_id,
          workspaceId: schedule!.workspace_id,
          agent: null,
          model: null,
        });
        logger.info(`[Schedules] Registered pg-boss schedule ${name}`);
      } catch (bossErr) {
        logger.warn({ err: bossErr, scheduleId: schedule!.id }, '[Schedules] pg-boss schedule registration failed (non-fatal)');
      }
    }

    res.status(201).json({
      schedule: {
        ...schedule,
        enabled: !!schedule!.enabled,
        next_run_at: schedule!.enabled ? nextRunAt(schedule!.cron_expression) : null,
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Schedules] Create');
  }
});

/**
 * @swagger
 * /api/pipeline/schedules/{id}:
 *   patch:
 *     tags: [Pipeline]
 *     summary: Update a pipeline schedule
 *     operationId: updatePipelineSchedule
 *     description: Updates an existing pipeline schedule. Only provided fields are modified.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cronExpression: { type: string }
 *               enabled: { type: boolean }
 *               specId: { type: string }
 *     responses:
 *       200:
 *         description: Schedule updated
 *       400:
 *         description: Invalid schedule ID
 *       404:
 *         description: Schedule not found
 *       422:
 *         description: Invalid cron expression
 */
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      throw new ValidationError('Invalid schedule id');
      return;
    }

    const existing = await queryOne<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE id = $1',
      [id]
    );
    if (!existing) {
      throw new NotFoundError('Schedule not found');
      return;
    }

    const { cronExpression, enabled, specId } = req.body;

    if (cronExpression !== undefined) {
      try {
        CronExpressionParser.parse(cronExpression);
      } catch (e: any) {
        throw new UnprocessableError(`Invalid cron expression: ${e.message}`);
        return;
      }
    }

    const newCron = cronExpression ?? existing.cron_expression;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
    const newSpecId = specId ?? existing.spec_id;

    const updated = await queryOne<ScheduleRow>(
      `UPDATE pipeline_schedules SET cron_expression = $1, enabled = $2, spec_id = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [newCron, newEnabled, newSpecId, id]
    );

    // Sync pg-boss schedule: always unschedule first, then re-register if enabled
    try {
      const name = scheduleName(id);
      await getBoss().unschedule(name);
      if (updated!.enabled) {
        // pg-boss v10: createQueue() must precede schedule() — idempotent
        await getBoss().createQueue(name);
        await getBoss().schedule(name, updated!.cron_expression, {
          scheduleId: updated!.id,
          specId: updated!.spec_id,
          workspaceId: updated!.workspace_id,
          agent: null,
          model: null,
        });
        logger.info(`[Schedules] Updated pg-boss schedule ${name}`);
      } else {
        logger.info(`[Schedules] Unregistered pg-boss schedule ${name} (disabled)`);
      }
    } catch (bossErr) {
      logger.warn({ err: bossErr, scheduleId: id }, '[Schedules] pg-boss schedule sync failed (non-fatal)');
    }

    res.json({
      schedule: {
        ...updated,
        enabled: !!updated!.enabled,
        next_run_at: updated!.enabled ? nextRunAt(updated!.cron_expression) : null,
      },
    });
  } catch (error: any) {
    handleRouteError(res, error, '[Schedules] Update');
  }
});

/**
 * @swagger
 * /api/pipeline/schedules/{id}:
 *   delete:
 *     tags: [Pipeline]
 *     summary: Delete a pipeline schedule
 *     operationId: deletePipelineSchedule
 *     description: Permanently removes a pipeline schedule.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Schedule deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400:
 *         description: Invalid schedule ID
 *       404:
 *         description: Schedule not found
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      throw new ValidationError('Invalid schedule id');
      return;
    }

    const existing = await queryOne(
      'SELECT * FROM pipeline_schedules WHERE id = $1',
      [id]
    );
    if (!existing) {
      throw new NotFoundError('Schedule not found');
      return;
    }

    await execute('DELETE FROM pipeline_schedules WHERE id = $1', [id]);

    // Remove from pg-boss scheduling
    try {
      const name = scheduleName(id);
      await getBoss().unschedule(name);
      logger.info(`[Schedules] Unregistered pg-boss schedule ${name}`);
    } catch (bossErr) {
      logger.warn({ err: bossErr, scheduleId: id }, '[Schedules] pg-boss unschedule failed (non-fatal)');
    }

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Schedules] Delete');
  }
});

export default router;
