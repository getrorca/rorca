import { Router, Request, Response } from 'express';
import { db } from '../db/index';

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
    allowed_tools: JSON.parse(row.allowed_tools) as string[],
    is_active: !!row.is_active,
  };
}

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles:
 *   get:
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
router.get('/', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const profiles = db.prepare(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? ORDER BY is_active DESC, name ASC'
  ).all(workspaceId) as AgentProfileRow[];
  res.json({ profiles: profiles.map(formatProfile) });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles/active:
 *   get:
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
router.get('/active', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const profile = db.prepare(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? AND is_active = 1 LIMIT 1'
  ).get(workspaceId) as AgentProfileRow | undefined;
  res.json({ profile: profile ? formatProfile(profile) : null });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles:
 *   post:
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
router.post('/', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { name, system_prompt_override, allowed_tools, model_override, is_active } = req.body;

  if (!name) {
    res.status(400).json({ error: 'Missing required field: name' });
    return;
  }

  // Verify workspace exists
  const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const toolsJson = Array.isArray(allowed_tools) ? JSON.stringify(allowed_tools) : '[]';

  // If setting this profile as active, deactivate others first
  if (is_active) {
    db.prepare('UPDATE agent_profiles SET is_active = 0 WHERE workspace_id = ?').run(workspaceId);
  }

  try {
    const result = db.prepare(
      `INSERT INTO agent_profiles (workspace_id, name, system_prompt_override, allowed_tools, model_override, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      workspaceId,
      name,
      system_prompt_override || null,
      toolsJson,
      model_override || null,
      is_active ? 1 : 0,
    );

    const profile = db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(
      result.lastInsertRowid
    ) as AgentProfileRow;

    db.prepare(
      "INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('agent_profile_created', ?, ?)"
    ).run(workspaceId, JSON.stringify({ profile_id: profile.id, name: profile.name }));

    res.status(201).json({ profile: formatProfile(profile) });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint failed')) {
      res.status(409).json({ error: `Profile '${name}' already exists for this workspace` });
      return;
    }
    throw err;
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles/{profileId}:
 *   put:
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
router.put('/:profileId', (req: Request, res: Response) => {
  const profileId = parseInt(String(req.params.profileId), 10);
  if (isNaN(profileId)) {
    res.status(400).json({ error: 'Invalid profile ID' });
    return;
  }

  const existing = db.prepare(
    'SELECT * FROM agent_profiles WHERE id = ? AND workspace_id = ?'
  ).get(profileId, req.params.id) as AgentProfileRow | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  const { name, system_prompt_override, allowed_tools, model_override, is_active } = req.body;

  // If activating this profile, deactivate others first
  if (is_active) {
    db.prepare('UPDATE agent_profiles SET is_active = 0 WHERE workspace_id = ?').run(req.params.id);
  }

  const newName = name !== undefined ? name : existing.name;
  const newPrompt = system_prompt_override !== undefined ? (system_prompt_override || null) : existing.system_prompt_override;
  const newTools = allowed_tools !== undefined
    ? (Array.isArray(allowed_tools) ? JSON.stringify(allowed_tools) : '[]')
    : existing.allowed_tools;
  const newModel = model_override !== undefined ? (model_override || null) : existing.model_override;
  const newActive = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;

  db.prepare(
    `UPDATE agent_profiles
     SET name = ?, system_prompt_override = ?, allowed_tools = ?, model_override = ?, is_active = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(newName, newPrompt, newTools, newModel, newActive, profileId);

  const updated = db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(profileId) as AgentProfileRow;
  res.json({ profile: formatProfile(updated) });
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/agent-profiles/{profileId}:
 *   delete:
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
router.delete('/:profileId', (req: Request, res: Response) => {
  const profileId = parseInt(String(req.params.profileId), 10);
  if (isNaN(profileId)) {
    res.status(400).json({ error: 'Invalid profile ID' });
    return;
  }

  const existing = db.prepare(
    'SELECT * FROM agent_profiles WHERE id = ? AND workspace_id = ?'
  ).get(profileId, req.params.id) as AgentProfileRow | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  db.prepare('DELETE FROM agent_profiles WHERE id = ?').run(profileId);
  res.status(204).send();
});

export default router;
