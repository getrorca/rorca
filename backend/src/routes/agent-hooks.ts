import { Router, Request, Response } from 'express';
import { db } from '../db/index';
import type { AgentHookRow } from '../lib/agent-hook-runner';

const router = Router({ mergeParams: true });

const VALID_EVENT_TYPES = [
  'on_generate', 'on_approve', 'on_reject',
  'on_run_start', 'on_run_complete',
  'on_story_pass', 'on_story_fail',
];

// ─── GET /api/workspaces/:id/agent-hooks ─────────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const hooks = db.prepare(
    'SELECT * FROM agent_hooks WHERE workspace_id = ? ORDER BY event_type, id ASC'
  ).all(workspaceId) as AgentHookRow[];
  res.json({ hooks });
});

// ─── POST /api/workspaces/:id/agent-hooks ────────────────────────────────────

router.post('/', (req: Request, res: Response) => {
  const workspaceId = req.params.id;
  const { event_type, command, enabled, timeout_seconds } = req.body;

  if (!event_type || !command) {
    res.status(400).json({ error: 'Missing required fields: event_type, command' });
    return;
  }

  if (!VALID_EVENT_TYPES.includes(event_type)) {
    res.status(400).json({ error: `Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}` });
    return;
  }

  // Verify workspace exists
  const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }

  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;
  const timeout = timeout_seconds !== undefined ? Math.max(1, Math.min(300, Number(timeout_seconds))) : 30;

  const result = db.prepare(
    `INSERT INTO agent_hooks (workspace_id, event_type, command, enabled, timeout_seconds) VALUES (?, ?, ?, ?, ?)`
  ).run(workspaceId, event_type, command, isEnabled, timeout);

  const hook = db.prepare('SELECT * FROM agent_hooks WHERE id = ?').get(
    result.lastInsertRowid
  ) as AgentHookRow;

  res.status(201).json({ hook });
});

// ─── PUT /api/workspaces/:id/agent-hooks/:hookId ─────────────────────────────

router.put('/:hookId', (req: Request, res: Response) => {
  const hookId = parseInt(String(req.params.hookId), 10);
  if (isNaN(hookId)) {
    res.status(400).json({ error: 'Invalid hook ID' });
    return;
  }

  const existing = db.prepare(
    'SELECT * FROM agent_hooks WHERE id = ? AND workspace_id = ?'
  ).get(hookId, req.params.id) as AgentHookRow | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Hook not found' });
    return;
  }

  const { event_type, command, enabled, timeout_seconds } = req.body;

  if (event_type && !VALID_EVENT_TYPES.includes(event_type)) {
    res.status(400).json({ error: `Invalid event_type. Must be one of: ${VALID_EVENT_TYPES.join(', ')}` });
    return;
  }

  const newEventType = event_type || existing.event_type;
  const newCommand = command !== undefined ? command : existing.command;
  const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
  const newTimeout = timeout_seconds !== undefined
    ? Math.max(1, Math.min(300, Number(timeout_seconds)))
    : existing.timeout_seconds;

  db.prepare(
    `UPDATE agent_hooks SET event_type = ?, command = ?, enabled = ?, timeout_seconds = ? WHERE id = ?`
  ).run(newEventType, newCommand, newEnabled, newTimeout, hookId);

  const updated = db.prepare('SELECT * FROM agent_hooks WHERE id = ?').get(hookId) as AgentHookRow;
  res.json({ hook: updated });
});

// ─── DELETE /api/workspaces/:id/agent-hooks/:hookId ──────────────────────────

router.delete('/:hookId', (req: Request, res: Response) => {
  const hookId = parseInt(String(req.params.hookId), 10);
  if (isNaN(hookId)) {
    res.status(400).json({ error: 'Invalid hook ID' });
    return;
  }

  const existing = db.prepare(
    'SELECT * FROM agent_hooks WHERE id = ? AND workspace_id = ?'
  ).get(hookId, req.params.id) as AgentHookRow | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Hook not found' });
    return;
  }

  db.prepare('DELETE FROM agent_hooks WHERE id = ?').run(hookId);
  res.status(204).send();
});

export default router;
