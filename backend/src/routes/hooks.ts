/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { query, queryOne, execute } from '../db/index';
import type { PipelineHookRow } from '../lib/hook-runner';
import { parsePaginationParams, paginateArray } from '../lib/paginate';
import { encryptToken } from '../lib/auth-utils';
import { handleRouteError } from '../lib/async-handler';
import { logger } from '../lib/logger';
import { NotFoundError, ValidationError } from '../lib/errors';

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
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.query.workspaceId as string;
    if (!workspaceId) {
      throw new ValidationError('Missing required query param: workspaceId');
      return;
    }

    const hooks = await query<PipelineHookRow>(
      'SELECT * FROM pipeline_hooks WHERE workspace_id = $1 ORDER BY hook_type, id ASC',
      [workspaceId]
    );

    const pagination = parsePaginationParams(req);
    res.json(paginateArray(hooks, pagination));
  } catch (error: any) {
    handleRouteError(res, error, '[Hooks] List');
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
router.post('/', async (req: Request, res: Response) => {
  try {
    const { workspaceId, hookType, command, webhookUrl, enabled } = req.body;

    if (!workspaceId || !hookType) {
      throw new ValidationError('Missing required fields: workspaceId, hookType');
      return;
    }

    // Either command (shell hook) or webhookUrl (HTTP webhook) must be provided
    if (!command && !webhookUrl) {
      throw new ValidationError('Either command or webhookUrl is required');
      return;
    }

    if (!VALID_HOOK_TYPES.includes(hookType)) {
      throw new ValidationError(`Invalid hookType. Must be one of: ${VALID_HOOK_TYPES.join(', ')}`);
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

    const hook = await queryOne<PipelineHookRow>(
      `INSERT INTO pipeline_hooks (workspace_id, hook_type, command, webhook_url, encrypted_webhook_secret, enabled)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [workspaceId, hookType, command || '', webhookUrl || null, encryptedSecret, isEnabled]
    );

    // Return the plaintext secret once so the user can configure their endpoint
    const response: Record<string, unknown> = { ...hook };
    if (webhookSecret) {
      response.webhookSecret = webhookSecret;
    }
    // Never expose encrypted_webhook_secret to clients
    delete response.encrypted_webhook_secret;

    res.status(201).json(response);
  } catch (error: any) {
    handleRouteError(res, error, '[Hooks] Create');
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
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const hookId = parseInt(String(req.params.id), 10);
    if (isNaN(hookId)) {
      throw new ValidationError('Invalid hook ID');
      return;
    }

    const existing = await queryOne<PipelineHookRow>(
      'SELECT * FROM pipeline_hooks WHERE id = $1',
      [hookId]
    );
    if (!existing) {
      throw new NotFoundError('Hook not found');
      return;
    }

    const { hookType, command, enabled } = req.body;

    if (hookType && !VALID_HOOK_TYPES.includes(hookType)) {
      throw new ValidationError(`Invalid hookType. Must be one of: ${VALID_HOOK_TYPES.join(', ')}`);
      return;
    }

    const newHookType = hookType || existing.hook_type;
    const newCommand = command !== undefined ? command : existing.command;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;

    const updated = await queryOne<PipelineHookRow>(
      `UPDATE pipeline_hooks SET hook_type = $1, command = $2, enabled = $3, updated_at = NOW() WHERE id = $4 RETURNING *`,
      [newHookType, newCommand, newEnabled, hookId]
    );

    res.json(updated);
  } catch (error: any) {
    handleRouteError(res, error, '[Hooks] Update');
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
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const hookId = parseInt(String(req.params.id), 10);
    if (isNaN(hookId)) {
      throw new ValidationError('Invalid hook ID');
      return;
    }

    const existing = await queryOne<PipelineHookRow>(
      'SELECT * FROM pipeline_hooks WHERE id = $1',
      [hookId]
    );
    if (!existing) {
      throw new NotFoundError('Hook not found');
      return;
    }

    await execute('DELETE FROM pipeline_hooks WHERE id = $1', [hookId]);
    res.status(204).send();
  } catch (error: any) {
    handleRouteError(res, error, '[Hooks] Delete');
  }
});

export default router;
