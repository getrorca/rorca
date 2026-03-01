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

/**
 * @swagger
 * /api/workspaces/{workspaceId}/env-vars:
 *   get:
 *     tags: [Environment Variables]
 *     summary: List environment variables for a workspace
 *     operationId: listEnvVars
 *     description: Returns all environment variables for the specified workspace. Secret values are masked with dots.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of environment variables
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 envVars:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       key: { type: string }
 *                       value: { type: string }
 *                       isSecret: { type: boolean }
 *                       createdAt: { type: string }
 *                       updatedAt: { type: string }
 *       404:
 *         description: Workspace not found
 */
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

/**
 * @swagger
 * /api/workspaces/{workspaceId}/env-vars:
 *   post:
 *     tags: [Environment Variables]
 *     summary: Create or update an environment variable
 *     operationId: upsertEnvVar
 *     description: Creates a new environment variable or updates an existing one if the key already exists. Values are stored AES-256-GCM encrypted.
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
 *             required: [key, value]
 *             properties:
 *               key: { type: string, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }
 *               value: { type: string }
 *               isSecret: { type: boolean, default: true }
 *     responses:
 *       200:
 *         description: Environment variable updated
 *       201:
 *         description: Environment variable created
 *       400:
 *         description: Missing or invalid key/value
 *       404:
 *         description: Workspace not found
 */
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

/**
 * @swagger
 * /api/workspaces/{workspaceId}/env-vars/{key}:
 *   delete:
 *     tags: [Environment Variables]
 *     summary: Delete an environment variable
 *     operationId: deleteEnvVar
 *     description: Permanently removes an environment variable from the workspace by its key name.
 *     parameters:
 *       - in: path
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: key
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Environment variable deleted
 *       404:
 *         description: Environment variable not found
 */
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
