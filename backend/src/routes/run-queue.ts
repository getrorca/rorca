/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { query, queryOne, execute, transaction } from '../db/index';
import { handleRouteError } from '../lib/async-handler';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

// ─── GET /api/run-queue?workspaceId=N ───────────────────────────

/**
 * @swagger
 * /api/run-queue:
 *   get:
 *     tags: [Pipeline]
 *     summary: List pending run queue entries for a workspace
 *     operationId: listRunQueue
 *     description: Returns all pending run queue entries for the specified workspace, ordered by position ascending.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID to filter queue entries
 *     responses:
 *       200:
 *         description: List of pending queue entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       workspace_id: { type: string }
 *                       spec_id: { type: string }
 *                       spec_path: { type: string }
 *                       position: { type: integer }
 *                       status: { type: string }
 *       400: { description: "Missing workspaceId query parameter" }
 *       500: { description: "Internal server error" }
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) {
      throw new ValidationError('workspaceId query parameter is required');
      return;
    }

    const entries = await query(
      `SELECT * FROM run_queue WHERE workspace_id = $1 AND status = 'pending' ORDER BY position ASC`,
      [Number(workspaceId)]
    );

    res.json({ items: entries });
  } catch (error: any) {
    handleRouteError(res, error, '[RunQueue] GET');
  }
});

// ─── GET /api/run-queue/status ──────────────────────────────────

/**
 * @swagger
 * /api/run-queue/status:
 *   get:
 *     tags: [Pipeline]
 *     summary: Get run queue status summary
 *     operationId: getRunQueueStatus
 *     description: Returns the number of pending entries in the queue, the next spec to run, and the ID of any currently running pipeline run. Optionally filtered by workspace.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         schema: { type: string }
 *         description: Optional workspace ID to scope the status
 *     responses:
 *       200:
 *         description: Queue status summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queueLength: { type: integer, description: "Number of pending entries" }
 *                 nextSpec: { type: object, nullable: true, description: "Next pending queue entry" }
 *                 runningRunId: { type: integer, nullable: true, description: "ID of currently running pipeline run" }
 *       500: { description: "Internal server error" }
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId;

    let queueLength: number;
    let nextSpec: any = null;

    if (workspaceId) {
      const countRow = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM run_queue WHERE workspace_id = $1 AND status = 'pending'`,
        [Number(workspaceId)]
      );
      queueLength = countRow?.count ?? 0;

      nextSpec = (await queryOne(
        `SELECT * FROM run_queue WHERE workspace_id = $1 AND status = 'pending' ORDER BY position ASC LIMIT 1`,
        [Number(workspaceId)]
      )) || null;
    } else {
      const countRow = await queryOne<{ count: number }>(
        `SELECT COUNT(*)::int as count FROM run_queue WHERE status = 'pending'`
      );
      queueLength = countRow?.count ?? 0;

      nextSpec = (await queryOne(
        `SELECT * FROM run_queue WHERE status = 'pending' ORDER BY position ASC LIMIT 1`
      )) || null;
    }

    // Find any currently running pipeline run
    const runningRun = await queryOne<{ id: number }>(
      `SELECT id FROM pipeline_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`
    );

    res.json({
      queueLength,
      nextSpec,
      runningRunId: runningRun?.id ?? null,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[RunQueue] GET /status');
  }
});

// ─── POST /api/run-queue ────────────────────────────────────────

/**
 * @swagger
 * /api/run-queue:
 *   post:
 *     tags: [Pipeline]
 *     summary: Add a spec to the run queue
 *     operationId: enqueueRun
 *     description: Adds a new entry to the run queue for a workspace. The entry is appended at the end of the queue (max position + 1).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, specId, specPath]
 *             properties:
 *               workspaceId: { type: string, description: "Workspace ID" }
 *               specId: { type: string, description: "Spec slug identifier" }
 *               specPath: { type: string, description: "Relative spec path within the workspace" }
 *               parallelism: { type: integer, default: 1, description: "Number of parallel story executions" }
 *               autoWorktree: { type: boolean, default: false, description: "Create git worktree for isolated run" }
 *     responses:
 *       201:
 *         description: Queue entry created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: integer }
 *                 workspace_id: { type: string }
 *                 spec_id: { type: string }
 *                 spec_path: { type: string }
 *                 position: { type: integer }
 *                 status: { type: string }
 *       400: { description: "Missing required fields (workspaceId, specId, specPath)" }
 *       404: { description: "Workspace not found" }
 *       500: { description: "Internal server error" }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { workspaceId, specId, specPath, parallelism, autoWorktree } = req.body;

    if (!workspaceId || !specId || !specPath) {
      throw new ValidationError('workspaceId, specId, and specPath are required');
      return;
    }

    const workspace = await queryOne('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
    if (!workspace) {
      throw new NotFoundError('Workspace not found');
      return;
    }

    // Get max position for this workspace
    const maxRow = await queryOne<{ maxpos: number | null }>(
      `SELECT MAX(position) as maxPos FROM run_queue WHERE workspace_id = $1`,
      [workspaceId]
    );
    const nextPosition = (maxRow?.maxpos ?? 0) + 1;

    const inserted = await queryOne<{ id: number }>(
      `INSERT INTO run_queue (workspace_id, spec_id, spec_path, parallelism, auto_worktree, position)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [workspaceId, specId, specPath, parallelism ?? 1, autoWorktree ? 1 : 0, nextPosition]
    );

    const entry = await queryOne('SELECT * FROM run_queue WHERE id = $1', [inserted?.id]);
    res.status(201).json(entry);
  } catch (error: any) {
    handleRouteError(res, error, '[RunQueue] POST');
  }
});

// ─── DELETE /api/run-queue/:id ──────────────────────────────────

/**
 * @swagger
 * /api/run-queue/{id}:
 *   delete:
 *     tags: [Pipeline]
 *     summary: Remove an entry from the run queue
 *     operationId: dequeueRun
 *     description: Deletes a pending run queue entry by its ID. Returns success if the entry was found and removed.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Queue entry ID
 *     responses:
 *       200:
 *         description: Queue entry removed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *       400: { description: "Invalid queue entry ID" }
 *       404: { description: "Queue entry not found" }
 *       500: { description: "Internal server error" }
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const idParam = req.params.id;
    const idStr = Array.isArray(idParam) ? idParam[0] : idParam;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      throw new ValidationError('Invalid queue entry ID');
      return;
    }

    const existing = await queryOne('SELECT id FROM run_queue WHERE id = $1', [id]);
    if (!existing) {
      throw new NotFoundError('Queue entry not found');
      return;
    }

    await execute('DELETE FROM run_queue WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (error: any) {
    handleRouteError(res, error, '[RunQueue] DELETE');
  }
});

// ─── PUT /api/run-queue/reorder ─────────────────────────────────

/**
 * @swagger
 * /api/run-queue/reorder:
 *   put:
 *     tags: [Pipeline]
 *     summary: Reorder run queue entries
 *     operationId: reorderRunQueue
 *     description: Updates the position of run queue entries based on the provided ordered array of IDs. The first ID gets position 1, second gets position 2, etc.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [orderedIds]
 *             properties:
 *               orderedIds:
 *                 type: array
 *                 items: { type: integer }
 *                 description: Queue entry IDs in desired order
 *     responses:
 *       200:
 *         description: Queue reordered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *       400: { description: "orderedIds must be a non-empty array" }
 *       500: { description: "Internal server error" }
 */
router.put('/reorder', async (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      throw new ValidationError('orderedIds must be a non-empty array of queue entry IDs');
      return;
    }

    await transaction(async (client) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await client.query('UPDATE run_queue SET position = $1 WHERE id = $2', [i + 1, orderedIds[i]]);
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    handleRouteError(res, error, '[RunQueue] PUT /reorder');
  }
});

export default router;
