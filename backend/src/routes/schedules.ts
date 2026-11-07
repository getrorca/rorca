/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { CronExpressionParser } from 'cron-parser';
import { query, queryOne, transaction } from '../db/index';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { assertReleaseOneCapabilityEnabled } from '../lib/release-one-capability-profile';

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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Schedule configuration is workspace-owned execution metadata and requires an authenticated operator."
 *     x-rorca-mcp: false
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
 *     summary: Retired Release-1 pipeline schedule creation
 *     operationId: createPipelineSchedule
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Creating durable unattended execution requires an authenticated operator and remains outside autonomous MCP tools."
 *     x-rorca-mcp: false
 *     description: Release-1 disables unattended scheduled execution. This stable compatibility route returns a typed fail-closed response before workspace or schedule mutation.
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
    assertReleaseOneCapabilityEnabled('scheduled_autonomy', { operation: 'create_schedule' });

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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Changing durable unattended execution requires an authenticated operator and remains outside autonomous MCP tools."
 *     x-rorca-mcp: false
 *     description: Release-1 permits only fail-safe disabling of an existing schedule. Enabling or reconfiguring scheduled autonomy returns a typed rejection before mutation.
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

    const { cronExpression, enabled, specId } = req.body;
    if (enabled !== false || cronExpression !== undefined || specId !== undefined) {
      assertReleaseOneCapabilityEnabled('scheduled_autonomy', { operation: 'update_schedule' });
    }

    const existing = await queryOne<ScheduleRow>(
      'SELECT * FROM pipeline_schedules WHERE id = $1',
      [id]
    );
    if (!existing) {
      throw new NotFoundError('Schedule not found');
      return;
    }

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

    const updated = await transaction(async (client) => {
      const locked = (await client.query<ScheduleRow>(
        'SELECT * FROM pipeline_schedules WHERE id = $1 FOR UPDATE',
        [id],
      )).rows[0];
      if (!locked) throw new NotFoundError('Schedule not found');
      await client.query(
        `UPDATE pipeline_schedule_occurrences
            SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = 'schedule_configuration_changed'
          WHERE schedule_id = $1 AND status = 'claimed'`,
        [id],
      );
      return (await client.query<ScheduleRow>(
        `UPDATE pipeline_schedules
            SET last_triggered_at = CASE WHEN cron_expression <> $1 THEN NULL ELSE last_triggered_at END,
                cron_expression = $1, enabled = $2, spec_id = $3, updated_at = NOW()
          WHERE id = $4 RETURNING *`,
        [newCron, newEnabled, newSpecId, id],
      )).rows[0];
    });

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
 *     x-rorca-tier: auth
 *     x-rorca-rationale: "Deleting durable unattended execution requires an authenticated operator and remains outside autonomous MCP tools."
 *     x-rorca-mcp: false
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

    await transaction(async (client) => {
      const existing = (await client.query(
        'SELECT id FROM pipeline_schedules WHERE id = $1 FOR UPDATE',
        [id],
      )).rows[0];
      if (!existing) throw new NotFoundError('Schedule not found');
      const inFlight = (await client.query(
        `SELECT id FROM pipeline_schedule_occurrences
          WHERE schedule_id = $1 AND status = 'dispatching' FOR UPDATE`,
        [id],
      )).rows[0];
      if (inFlight) {
        throw new UnprocessableError('Schedule has an in-flight occurrence; retry deletion after dispatch reconciliation');
      }
      await client.query('DELETE FROM pipeline_schedules WHERE id = $1', [id]);
    });

    res.json({ ok: true });
  } catch (error: any) {
    handleRouteError(res, error, '[Schedules] Delete');
  }
});

export default router;
