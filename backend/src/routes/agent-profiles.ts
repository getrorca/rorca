/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { query, queryOne, execute } from '../db/index';
import { ConflictError, NotFoundError, ValidationError } from '../lib/errors';

const router = Router({ mergeParams: true });

export interface AgentProfileRow {
  id: number;
  workspace_id: string;
  name: string;
  system_prompt_override: string | null;
  allowed_tools: string;   // JSON array
  model_override: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function formatProfile(row: AgentProfileRow) {
  return {
    ...row,
    // pg driver returns jsonb columns as parsed JS objects, not strings
    allowed_tools: (Array.isArray(row.allowed_tools) ? row.allowed_tools : JSON.parse(row.allowed_tools as unknown as string)) as string[],
    is_active: !!row.is_active,
  };
}

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Agent Profiles]
 *     summary: List agent profiles for a workspace
 *     operationId: listAgentProfiles
 *     description: Returns all named agent configurations for the specified workspace, ordered by active status and name.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of agent profiles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 profiles:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: integer }
 *                       workspace_id: { type: string }
 *                       name: { type: string }
 *                       system_prompt_override: { type: string, nullable: true }
 *                       allowed_tools: { type: array, items: { type: string } }
 *                       model_override: { type: string, nullable: true }
 *                       is_active: { type: boolean }
 *                       created_at: { type: string }
 *                       updated_at: { type: string }
 */
router.get('/', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const profiles = await query<AgentProfileRow>(
    'SELECT * FROM agent_profiles WHERE workspace_id = $1 ORDER BY is_active DESC, name ASC',
    [workspaceId]
  );
  res.json({ profiles: profiles.map(formatProfile) });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles/active:
 *   get:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Agent Profiles]
 *     summary: Get the active agent profile for a workspace
 *     operationId: getActiveAgentProfile
 *     description: Returns the currently active agent profile for the specified workspace, or null if none is active.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Active agent profile or null
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 profile: { type: object, nullable: true }
 */
router.get('/active', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const profile = await queryOne<AgentProfileRow>(
    'SELECT * FROM agent_profiles WHERE workspace_id = $1 AND is_active = true LIMIT 1',
    [workspaceId]
  );
  res.json({ profile: profile ? formatProfile(profile) : null });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Agent Profiles]
 *     summary: Create a new agent profile
 *     operationId: createAgentProfile
 *     description: Creates a new named agent configuration for the workspace. If is_active is true, all other profiles are deactivated first.
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
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               system_prompt_override: { type: string }
 *               allowed_tools: { type: array, items: { type: string } }
 *               model_override: { type: string }
 *               is_active: { type: boolean, default: false }
 *     responses:
 *       201:
 *         description: Profile created
 *       400:
 *         description: Missing required field name
 *       404:
 *         description: Workspace not found
 *       409:
 *         description: Profile name already exists for this workspace
 */
router.post('/', async (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { name, system_prompt_override, allowed_tools, model_override, is_active } = req.body;

  if (!name) {
    throw new ValidationError('Missing required field: name');
    return;
  }

  // Verify workspace exists
  const workspace = await queryOne<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (!workspace) {
    throw new NotFoundError('Workspace not found');
    return;
  }

  const toolsJson = Array.isArray(allowed_tools) ? JSON.stringify(allowed_tools) : '[]';

  // If setting this profile as active, deactivate others first
  if (is_active) {
    await execute('UPDATE agent_profiles SET is_active = false WHERE workspace_id = $1', [workspaceId]);
  }

  try {
    const profile = await queryOne<AgentProfileRow>(
      `INSERT INTO agent_profiles (workspace_id, name, system_prompt_override, allowed_tools, model_override, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        workspaceId,
        name,
        system_prompt_override || null,
        toolsJson,
        model_override || null,
        is_active ? 1 : 0,
      ]
    );

    await execute(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('agent_profile_created', $1, $2)",
      [workspaceId, JSON.stringify({ profile_id: profile!.id, name: profile!.name })]
    );

    res.status(201).json({ profile: formatProfile(profile!) });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed') || err.message?.includes('duplicate key value')) {
      throw new ConflictError(`Profile '${name}' already exists for this workspace`);
      return;
    }
    throw err;
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles/{profileId}:
 *   put:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Agent Profiles]
 *     summary: Update an agent profile
 *     operationId: updateAgentProfile
 *     description: Updates an existing agent profile. If is_active is set to true, all other profiles in the workspace are deactivated.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: profileId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               system_prompt_override: { type: string }
 *               allowed_tools: { type: array, items: { type: string } }
 *               model_override: { type: string }
 *               is_active: { type: boolean }
 *     responses:
 *       200:
 *         description: Profile updated
 *       400:
 *         description: Invalid profile ID
 *       404:
 *         description: Profile not found
 */
router.put('/:profileId', async (req: Request, res: Response) => {
  const profileId = parseInt(String(req.params.profileId), 10);
  if (isNaN(profileId)) {
    throw new ValidationError('Invalid profile ID');
    return;
  }

  const existing = await queryOne<AgentProfileRow>(
    'SELECT * FROM agent_profiles WHERE id = $1 AND workspace_id = $2',
    [profileId, req.params.id]
  );

  if (!existing) {
    throw new NotFoundError('Profile not found');
    return;
  }

  const { name, system_prompt_override, allowed_tools, model_override, is_active } = req.body;

  // If activating this profile, deactivate others first
  if (is_active) {
    await execute('UPDATE agent_profiles SET is_active = false WHERE workspace_id = $1', [req.params.id]);
  }

  const newName = name !== undefined ? name : existing.name;
  const newPrompt = system_prompt_override !== undefined ? (system_prompt_override || null) : existing.system_prompt_override;
  const newTools = allowed_tools !== undefined
    ? (Array.isArray(allowed_tools) ? JSON.stringify(allowed_tools) : '[]')
    : existing.allowed_tools;
  const newModel = model_override !== undefined ? (model_override || null) : existing.model_override;
  const newActive = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;

  const updated = await queryOne<AgentProfileRow>(
    `UPDATE agent_profiles
     SET name = $1, system_prompt_override = $2, allowed_tools = $3, model_override = $4, is_active = $5, updated_at = NOW()
     WHERE id = $6 RETURNING *`,
    [newName, newPrompt, newTools, newModel, newActive, profileId]
  );

  res.json({ profile: formatProfile(updated!) });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles/{profileId}:
 *   delete:
 *     x-rorca-native-api: true
 *     x-rorca-rationale: "Intentional dashboard/native API operation; authenticated local-admin access only and never MCP-exposed by default."
 *     tags: [Agent Profiles]
 *     summary: Delete an agent profile
 *     operationId: deleteAgentProfile
 *     description: Permanently removes an agent profile from the workspace.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: profileId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       204:
 *         description: Profile deleted
 *       400:
 *         description: Invalid profile ID
 *       404:
 *         description: Profile not found
 */
router.delete('/:profileId', async (req: Request, res: Response) => {
  const profileId = parseInt(String(req.params.profileId), 10);
  if (isNaN(profileId)) {
    throw new ValidationError('Invalid profile ID');
    return;
  }

  const existing = await queryOne<AgentProfileRow>(
    'SELECT * FROM agent_profiles WHERE id = $1 AND workspace_id = $2',
    [profileId, req.params.id]
  );

  if (!existing) {
    throw new NotFoundError('Profile not found');
    return;
  }

  await execute('DELETE FROM agent_profiles WHERE id = $1', [profileId]);
  res.status(204).send();
});

export default router;
