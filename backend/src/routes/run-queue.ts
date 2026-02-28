import { Router, Request, Response } from 'express';
import { db } from '../db/index';

const router = Router();

// ─── GET /api/run-queue?workspaceId=N ───────────────────────────
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
    console.error('[RunQueue] GET error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /api/run-queue/status ──────────────────────────────────
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
    console.error('[RunQueue] GET /status error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/run-queue ────────────────────────────────────────
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
    console.error('[RunQueue] POST error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/run-queue/:id ──────────────────────────────────
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
    console.error('[RunQueue] DELETE error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/run-queue/reorder ─────────────────────────────────
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
    console.error('[RunQueue] PUT /reorder error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
