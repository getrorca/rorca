import { Router } from 'express';
import * as fs from 'fs';
import { db } from '../db/index';

const router = Router();

interface WorkspaceRow {
  id: string;
  label: string;
  path: string;
  domains: string;
  created_at: string;
}

function parseWorkspace(row: WorkspaceRow) {
  return {
    ...row,
    domains: JSON.parse(row.domains) as string[],
  };
}

// POST /api/workspaces
router.post('/', (req, res) => {
  const { id, label, path, domains } = req.body;

  if (!id || !label || !path || !domains) {
    res.status(400).json({ error: 'Missing required fields: id, label, path, domains' });
    return;
  }

  if (!fs.existsSync(path)) {
    res.status(400).json({ error: `Path does not exist on filesystem: ${path}` });
    return;
  }

  db.prepare(
    'INSERT INTO workspaces (id, label, path, domains) VALUES (?, ?, ?, ?)'
  ).run(id, label, path, JSON.stringify(domains));

  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_create', ?)"
  ).run(id);

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;
  res.status(201).json({ workspace: parseWorkspace(row) });
});

// GET /api/workspaces
router.get('/', (_req, res) => {
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[];
  res.json({ workspaces: rows.map(parseWorkspace) });
});

// GET /api/workspaces/:id
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id) as WorkspaceRow | undefined;
  if (!row) {
    res.status(404).json({ error: 'Workspace not found' });
    return;
  }
  res.json({ workspace: parseWorkspace(row) });
});

// DELETE /api/workspaces/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);

  db.prepare(
    "INSERT INTO wal_events (event_type, workspace_id) VALUES ('workspace_delete', ?)"
  ).run(req.params.id);

  res.status(204).send();
});

export default router;
