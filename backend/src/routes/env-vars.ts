import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { db } from '../db/index';
import { encryptToken, decryptToken } from './auth';

const router = Router({ mergeParams: true });

interface EnvVarRow {
  id: string;
  workspace_id: string;
  key: string;
  encrypted_value: string;
  is_secret: number;
  created_at: string;
  updated_at: string;
}

const SECRET_MASK = '••••••';

// ─── GET /api/workspaces/:id/env-vars — List env vars (secrets masked) ──────

router.get('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const rows = db.prepare(
      'SELECT * FROM workspace_env_vars WHERE workspace_id = ? ORDER BY key ASC'
    ).all(workspaceId) as EnvVarRow[];

    const envVars = rows.map(row => ({
      id: row.id,
      key: row.key,
      value: row.is_secret ? SECRET_MASK : decryptToken(row.encrypted_value),
      isSecret: !!row.is_secret,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.json({ envVars });
  } catch (error: any) {
    console.error('[EnvVars] List error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/workspaces/:id/env-vars — Create or update an env var ────────

router.post('/', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { key, value, isSecret } = req.body;

    if (!key || typeof key !== 'string') {
      res.status(400).json({ error: 'Missing required field: key' });
      return;
    }
    if (value === undefined || value === null || typeof value !== 'string') {
      res.status(400).json({ error: 'Missing required field: value' });
      return;
    }

    // Validate key format: alphanumeric + underscores, typical env var name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      res.status(400).json({ error: 'Invalid key format. Use letters, numbers, and underscores only (must start with letter or underscore).' });
      return;
    }

    const workspace = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    const secret = isSecret !== false ? 1 : 0; // default to secret
    const encryptedValue = encryptToken(value);

    // Upsert: update if key exists for this workspace, otherwise insert
    const existing = db.prepare(
      'SELECT id FROM workspace_env_vars WHERE workspace_id = ? AND key = ?'
    ).get(workspaceId, key) as { id: string } | undefined;

    if (existing) {
      db.prepare(
        `UPDATE workspace_env_vars SET encrypted_value = ?, is_secret = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(encryptedValue, secret, existing.id);

      const row = db.prepare('SELECT * FROM workspace_env_vars WHERE id = ?').get(existing.id) as EnvVarRow;
      res.json({
        id: row.id,
        key: row.key,
        value: row.is_secret ? SECRET_MASK : value,
        isSecret: !!row.is_secret,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } else {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO workspace_env_vars (id, workspace_id, key, encrypted_value, is_secret) VALUES (?, ?, ?, ?, ?)`
      ).run(id, workspaceId, key, encryptedValue, secret);

      const row = db.prepare('SELECT * FROM workspace_env_vars WHERE id = ?').get(id) as EnvVarRow;
      res.status(201).json({
        id: row.id,
        key: row.key,
        value: row.is_secret ? SECRET_MASK : value,
        isSecret: !!row.is_secret,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
  } catch (error: any) {
    console.error('[EnvVars] Create/update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── DELETE /api/workspaces/:id/env-vars/:key — Remove an env var ───────────

router.delete('/:key', (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const key = req.params.key;

    const result = db.prepare(
      'DELETE FROM workspace_env_vars WHERE workspace_id = ? AND key = ?'
    ).run(workspaceId, key);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Env var not found' });
      return;
    }

    res.status(204).send();
  } catch (error: any) {
    console.error('[EnvVars] Delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Helper: get decrypted env vars for pipeline injection ──────────────────

export function getWorkspaceEnvVars(workspaceId: string): Record<string, string> {
  const rows = db.prepare(
    'SELECT key, encrypted_value FROM workspace_env_vars WHERE workspace_id = ?'
  ).all(workspaceId) as Pick<EnvVarRow, 'key' | 'encrypted_value'>[];

  const vars: Record<string, string> = {};
  for (const row of rows) {
    vars[row.key] = decryptToken(row.encrypted_value);
  }
  return vars;
}

export default router;
