import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import { logger } from '../lib/logger';

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
router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId;
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query parameter is required' });
      return;
    }

    const entries = db.prepare(
      `SELECT * FROM run_queue WHERE workspace_id = ? AND status = 'pending' ORDER BY position ASC`
    ).all(Number(workspaceId));

    res.json({ items: entries });
  } catch (error: any) {
    logger.error('[RunQueue] GET error:', error);
    res.status(500).json({ error: error.message });
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
router.get('/status', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId;

    let queueLength: number;
    let nextSpec: any = null;

    if (workspaceId) {
      queueLength = (db.prepare(
        `SELECT COUNT(*) as count FROM run_queue WHERE workspace_id = ? AND status = 'pending'`
      ).get(Number(workspaceId)) as { count: number }).count;

      nextSpec = db.prepare(
        `SELECT * FROM run_queue WHERE workspace_id = ? AND status = 'pending' ORDER BY position ASC LIMIT 1`
      ).get(Number(workspaceId)) || null;
    } else {
      queueLength = (db.prepare(
        `SELECT COUNT(*) as count FROM run_queue WHERE status = 'pending'`
      ).get() as { count: number }).count;

      nextSpec = db.prepare(
        `SELECT * FROM run_queue WHERE status = 'pending' ORDER BY position ASC LIMIT 1`
      ).get() || null;
    }

    // Find any currently running pipeline run
    const runningRun = db.prepare(
      `SELECT id FROM pipeline_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1`
    ).get() as { id: number } | undefined;

    res.json({
      queueLength,
      nextSpec,
      runningRunId: runningRun?.id ?? null,
    });
  } catch (error: any) {
    logger.error('[RunQueue] GET /status error:', error);
    res.status(500).json({ error: error.message });
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
router.post('/', (req: Request, res: Response) => {
  try {
    const { workspaceId, specId, specPath, parallelism, autoWorktree } = req.body;

    if (!workspaceId || !specId || !specPath) {
      res.status(400).json({ error: 'workspaceId, specId, and specPath are required' });
      return;
    }

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    // Get max position for this workspace
    const maxRow = db.prepare(
      `SELECT MAX(position) as maxPos FROM run_queue WHERE workspace_id = ?`
    ).get(workspaceId) as { maxPos: number | null };
    const nextPosition = (maxRow.maxPos ?? 0) + 1;

    const result = db.prepare(`
      INSERT INTO run_queue (workspace_id, spec_id, spec_path, parallelism, auto_worktree, position)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      specId,
      specPath,
      parallelism ?? 1,
      autoWorktree ? 1 : 0,
      nextPosition
    );

    const entry = db.prepare('SELECT * FROM run_queue WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(entry);
  } catch (error: any) {
    logger.error('[RunQueue] POST error:', error);
    res.status(500).json({ error: error.message });
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
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const idParam = req.params.id;
    const idStr = Array.isArray(idParam) ? idParam[0] : idParam;
    const id = parseInt(idStr, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid queue entry ID' });
      return;
    }

    const existing = db.prepare('SELECT id FROM run_queue WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Queue entry not found' });
      return;
    }

    db.prepare('DELETE FROM run_queue WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (error: any) {
    logger.error('[RunQueue] DELETE error:', error);
    res.status(500).json({ error: error.message });
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
router.put('/reorder', (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      res.status(400).json({ error: 'orderedIds must be a non-empty array of queue entry IDs' });
      return;
    }

    const updateStmt = db.prepare('UPDATE run_queue SET position = ? WHERE id = ?');
    const reorder = db.transaction((ids: number[]) => {
      for (let i = 0; i < ids.length; i++) {
        updateStmt.run(i + 1, ids[i]);
      }
    });
    reorder(orderedIds);

    res.json({ success: true });
  } catch (error: any) {
    logger.error('[RunQueue] PUT /reorder error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
