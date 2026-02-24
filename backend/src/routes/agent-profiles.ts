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

// ─── GET /api/workspaces/:id/agent-profiles ─────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const profiles = db.prepare(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? ORDER BY is_active DESC, name ASC'
  ).all(workspaceId) as AgentProfileRow[];
  res.json({ profiles: profiles.map(formatProfile) });
});

// ─── GET /api/workspaces/:id/agent-profiles/active ──────────────────────────

router.get('/active', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const profile = db.prepare(
    'SELECT * FROM agent_profiles WHERE workspace_id = ? AND is_active = 1 LIMIT 1'
  ).get(workspaceId) as AgentProfileRow | undefined;
  res.json({ profile: profile ? formatProfile(profile) : null });
});

// ─── POST /api/workspaces/:id/agent-profiles ────────────────────────────────

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

// ─── PUT /api/workspaces/:id/agent-profiles/:profileId ──────────────────────

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

// ─── DELETE /api/workspaces/:id/agent-profiles/:profileId ───────────────────

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
