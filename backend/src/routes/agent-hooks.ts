/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db/index';
import type { AgentHookRow } from '../lib/agent-hook-runner';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router({ mergeParams: true });

const VALID_EVENT_TYPES = [
  'on_generate', 'on_approve', 'on_reject',
  'on_run_start', 'on_run_complete',
  'on_story_pass', 'on_story_fail',
];

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-hooks:
 *   get:
 *     tags: [Agent Hooks]
 *     summary: List agent hooks for a workspace
 *     operationId: listAgentHooks
 *     description: Returns all agent lifecycle hooks configured for the specified workspace, ordered by event type and ID.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of agent hooks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       workspace_id: { type: string }
 *                       event_type: { type: string }
 *                       command: { type: string }
 *                       enabled: { type: integer }
 *                       timeout_seconds: { type: integer }
 */
router.get('/', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const hooks = await query<AgentHookRow>(
    'SELECT * FROM agent_hooks WHERE workspace_id = $1 ORDER BY event_type, id ASC',
    [workspaceId]
  );
  res.json({ hooks });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-hooks:
 *   post:
 *     tags: [Agent Hooks]
 *     summary: Create a new agent hook
 *     operationId: createAgentHook
 *     description: Creates a new agent lifecycle hook for the specified workspace. Hooks fire shell commands on specific pipeline events.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [event_type, command]
 *             properties:
 *               event_type: { type: string, enum: [on_generate, on_approve, on_reject, on_run_start, on_run_complete, on_story_pass, on_story_fail] }
 *               command: { type: string }
 *               enabled: { type: boolean, default: true }
 *               timeout_seconds: { type: integer, minimum: 1, maximum: 300, default: 30 }
 *     responses:
 *       201:
 *         description: Hook created
 *       400:
 *         description: Missing required fields or invalid event_type
 *       404:
 *         description: Workspace not found
 */
router.post('/', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { event_type, command, enabled, timeout_seconds } = req.body;

  if (!event_type || !command) {
    throw new ValidationError('Missing required fields: event_type, command');
    return;
  }

  if (!VALID_EVENT_TYPES.includes(event_type)) {
    throw new ValidationError(`Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
    return;
  }

  // Verify workspace exists
  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;
  const timeout = timeout_seconds !== undefined ? Math.max(1, Math.min(300, Number(timeout_seconds))) : 30;

  const hook = await queryOne<AgentHookRow>(
    `INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [workspaceId, event_type, command, isEnabled, timeout]
  );

  res.status(201).json({ hook });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-hooks/{hookId}:
 *   put:
 *     tags: [Agent Hooks]
 *     summary: Update an agent hook
 *     operationId: updateAgentHook
 *     description: Updates an existing agent lifecycle hook. Only provided fields are updated; others retain current values.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: hookId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               event_type: { type: string, enum: [on_generate, on_approve, on_reject, on_run_start, on_run_complete, on_story_pass, on_story_fail] }
 *               command: { type: string }
 *               enabled: { type: boolean }
 *               timeout_seconds: { type: integer, minimum: 1, maximum: 300 }
 *     responses:
 *       200:
 *         description: Hook updated
 *       400:
 *         description: Invalid hook ID or invalid event_type
 *       404:
 *         description: Hook not found
 */
router.put('/:hookId', async (req: Request, res: Response) => {
  const hookId = parseInt(String(req.params.hookId), 10);
  if (isNaN(hookId)) {
    throw new ValidationError('Invalid hook ID');
    return;
  }

  const existing = await queryOne<AgentHookRow>(
    'SELECT * FROM agent_hooks WHERE id = $1 AND workspace_id = $2',
    [hookId, req.params.id]
  );

  if (!existing) {
    throw new NotFoundError('Hook not found');
    return;
  }

  const { event_type, command, enabled, timeout_seconds } = req.body;

  if (event_type && !VALID_EVENT_TYPES.includes(event_type)) {
    throw new ValidationError(`Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}`);
    return;
  }

  const newEventType = event_type || existing.event_type;
  const newCommand = command !== undefined ? command : existing.command;
  const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
  const newTimeout = timeout_seconds !== undefined
    ? Math.max(1, Math.min(300, Number(timeout_seconds)))
    : existing.timeout_seconds;

  const updated = await queryOne<AgentHookRow>(
    `UPDATE agent_hooks SET event_type = $1, command = $2, enabled = $3, timeout_seconds = $4 WHERE id = $5 RETURNING *`,
    [newEventType, newCommand, newEnabled, newTimeout, hookId]
  );

  res.json({ hook: updated });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-hooks/{hookId}:
 *   delete:
 *     tags: [Agent Hooks]
 *     summary: Delete an agent hook
 *     operationId: deleteAgentHook
 *     description: Permanently removes an agent lifecycle hook from the workspace.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: hookId
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
router.delete('/:hookId', async (req: Request, res: Response) => {
  const hookId = parseInt(String(req.params.hookId), 10);
  if (isNaN(hookId)) {
    throw new ValidationError('Invalid hook ID');
    return;
  }

  const existing = await queryOne<AgentHookRow>(
    'SELECT * FROM agent_hooks WHERE id = $1 AND workspace_id = $2',
    [hookId, req.params.id]
  );

  if (!existing) {
    throw new NotFoundError('Hook not found');
    return;
  }

  await execute('DELETE FROM agent_hooks WHERE id = $1', [hookId]);
  res.status(204).send();
});

export default router;
