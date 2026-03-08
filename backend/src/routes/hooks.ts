import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db/index';
import type { PipelineHookRow } from '../lib/hook-runner';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { encryptToken } from './auth';
import { logger } from '../lib/logger';

const router = Router();

const VALID_HOOK_TYPES = ['pre_run', 'post_run', 'pre_story', 'post_story'];

/**
 * @swagger
 * /api/pipeline/hooks:
 *   get:
 *     tags: [Pipeline]
 *     summary: List pipeline hooks for a workspace
 *     operationId: listPipelineHooks
 *     description: Returns all pipeline lifecycle hooks (pre_run, post_run, pre_story, post_story) for the specified workspace.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of pipeline hooks
 *       400:
 *         description: Missing workspaceId query parameter
 */
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
    logger.error('[Hooks] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pipeline/hooks:
 *   post:
 *     tags: [Pipeline]
 *     summary: Create a new pipeline hook
 *     operationId: createPipelineHook
 *     description: Creates a new pipeline lifecycle hook that runs a shell command at specific points in the pipeline execution.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, hookType, command]
 *             properties:
 *               workspaceId: { type: string }
 *               hookType: { type: string, enum: [pre_run, post_run, pre_story, post_story] }
 *               command: { type: string }
 *               enabled: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: Hook created
 *       400:
 *         description: Missing required fields or invalid hookType
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const { workspaceId, hookType, command, webhookUrl, enabled } = req.body;

    if (!workspaceId || !hookType) {
      res.status(400).json({ error: 'Missing required fields: workspaceId, hookType' });
      return;
    }

    // Either command (shell hook) or webhookUrl (HTTP webhook) must be provided
    if (!command && !webhookUrl) {
      res.status(400).json({ error: 'Either command or webhookUrl is required' });
      return;
    }

    if (!VALID_HOOK_TYPES.includes(hookType)) {
      res.status(400).json({ error: `Invalid hookType. Must be one of: ${VALID_HOOK_TYPES.join(', ')}` });
      return;
    }

    const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

    // For webhook hooks, auto-generate a signing secret (stored encrypted)
    let encryptedSecret: string | null = null;
    let webhookSecret: string | null = null;
    if (webhookUrl) {
      webhookSecret = crypto.randomBytes(32).toString('hex');
      encryptedSecret = encryptToken(webhookSecret);
    }

    const result = db.prepare(
      `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, webhook_url, encrypted_webhook_secret, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(workspaceId, hookType, command || '', webhookUrl || null, encryptedSecret, isEnabled);

    const hook = db.prepare('SELECT * FROM pipeline_hooks WHERE id = ?').get(
      result.lastInsertRowid
    ) as PipelineHookRow;

    // Return the plaintext secret once so the user can configure their endpoint
    const response: Record<string, unknown> = { ...hook };
    if (webhookSecret) {
      response.webhookSecret = webhookSecret;
    }
    // Never expose encrypted_webhook_secret to clients
    delete response.encrypted_webhook_secret;

    res.status(201).json(response);
  } catch (error: any) {
    logger.error('[Hooks] Create error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pipeline/hooks/{id}:
 *   put:
 *     tags: [Pipeline]
 *     summary: Update a pipeline hook
 *     operationId: updatePipelineHook
 *     description: Updates an existing pipeline hook. Only provided fields are modified.
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
 *               hookType: { type: string, enum: [pre_run, post_run, pre_story, post_story] }
 *               command: { type: string }
 *               enabled: { type: boolean }
 *     responses:
 *       200:
 *         description: Hook updated
 *       400:
 *         description: Invalid hook ID or hookType
 *       404:
 *         description: Hook not found
 */
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
    logger.error('[Hooks] Update error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pipeline/hooks/{id}:
 *   delete:
 *     tags: [Pipeline]
 *     summary: Delete a pipeline hook
 *     operationId: deletePipelineHook
 *     description: Permanently removes a pipeline hook.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Hook deleted
 *       400:
 *         description: Invalid hook ID
 *       404:
 *         description: Hook not found
 */
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
    logger.error('[Hooks] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
