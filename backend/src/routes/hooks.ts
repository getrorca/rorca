import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import type { PipelineHookRow } from '../lib/hook-runner';
import { parsePaginationParams, paginateArray } from '../lib/paginate';

const router = Router();

const VALID_HOOK_TYPES = ['pre_run', 'post_run', 'pre_story', 'post_story'];

// ─── GET /api/pipeline/hooks — List hooks for a workspace ─────────────────────

router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      res.status(400).json({ error: 'Missing required query param: workspaceId' });
      return;
    }

    const hooks = db.prepare(
      'SELECT * FROM pipeline_hooks WHERE workspace_id = ? ORDER BY hook_type, id ASC'
    ).all(workspaceId) as PipelineHookRow[];

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(hooks, pagination));
  } catch (error: any) {
    console.error('[Hooks] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/pipeline/hooks — Create a new hook ─────────────────────────────

router.post('/', (req: Request, res: Response) => {
  try {
    const { workspaceId, hookType, command, enabled } = req.body;

    if (!workspaceId || !hookType || !command) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, hookType, command' });
      return;
    }

    if (!VALID_HOOK_TYPES.includes(hookType)) {
      res.status(400).json({ error: `Invalid hookType. Must be one of: ${VALID_HOOK_TYPES.join(', ')}` });
      return;
    }

    const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

    const result = db.prepare(
      `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, enabled) VALUES (?, ?, ?, ?)`
    ).run(workspaceId, hookType, command, isEnabled);

    const hook = db.prepare('SELECT * FROM pipeline_hooks WHERE id = ?').get(
      result.lastInsertRowid
    ) as PipelineHookRow;

    res.status(201).json(hook);
  } catch (error: any) {
    console.error('[Hooks] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /api/pipeline/hooks/:id — Update a hook ─────────────────────────────

router.put('/:id', (req: Request, res: Response) => {
  try {
    const hookId = parseInt(String(req.params.id), 10);
    if (isNaN(hookId)) {
      res.status(400).json({ error: 'Invalid hook ID' });
      return;
    }

    const existing = db.prepare('SELECT * FROM pipeline_hooks WHERE id = ?').get(hookId) as PipelineHookRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Hook not found' });
      return;
    }

    const { hookType, command, enabled } = req.body;

    if (hookType && !VALID_HOOK_TYPES.includes(hookType)) {
      res.status(400).json({ error: `Invalid hookType. Must be one of: ${VALID_HOOK_TYPES.join(', ')}` });
      return;
    }

    const newHookType = hookType || existing.hook_type;
    const newCommand = command !== undefined ? command : existing.command;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;

    db.prepare(
      `UPDATE pipeline_hooks SET hook_type = ?, command = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(newHookType, newCommand, newEnabled, hookId);

    const updated = db.prepare('SELECT * FROM pipeline_hooks WHERE id = ?').get(hookId) as PipelineHookRow;
    res.json(updated);
  } catch (error: any) {
    console.error('[Hooks] Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/pipeline/hooks/:id — Delete a hook ───────────────────────────

router.delete('/:id', (req: Request, res: Response) => {
  try {
    const hookId = parseInt(String(req.params.id), 10);
    if (isNaN(hookId)) {
      res.status(400).json({ error: 'Invalid hook ID' });
      return;
    }

    const existing = db.prepare('SELECT * FROM pipeline_hooks WHERE id = ?').get(hookId) as PipelineHookRow | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Hook not found' });
      return;
    }

    db.prepare('DELETE FROM pipeline_hooks WHERE id = ?').run(hookId);
    res.status(204).send();
  } catch (error: any) {
    console.error('[Hooks] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
