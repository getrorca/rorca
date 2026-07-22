/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { query } from '../db/index';
import { encryptToken, decryptToken } from '../lib/auth-utils';
import { NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';
import { withUserClient } from '../db/user-client';

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
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Dashboard-only local-administrator environment configuration; excluded from autonomous/MCP exposure and protected by the native human-authority gate."
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
router.get('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;

    const rows = await withUserClient(req, async (client) => {
      const workspace = await client.query<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
      if (workspace.rows.length === 0) {
        throw new NotFoundError('Workspace not found');
      }
      const result = await client.query<EnvVarRow>(
        'SELECT * FROM workspace_env_vars WHERE workspace_id = $1 ORDER BY key ASC',
        [workspaceId]
      );
      return result.rows;
    });

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
    handleRouteError(res, error, '[EnvVars] List');
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/env-vars:
 *   post:
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Dashboard-only local-administrator environment configuration; excluded from autonomous/MCP exposure and protected by the native human-authority gate."
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
router.post('/', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const { key, value, isSecret } = req.body;

    if (!key || typeof key !== 'string') {
      throw new ValidationError('Missing required field: key');
      return;
    }
    if (value === undefined || value === null || typeof value !== 'string') {
      throw new ValidationError('Missing required field: value');
      return;
    }

    // Validate key format: alphanumeric + underscores, typical env var name
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new ValidationError('Invalid key format. Use letters, numbers, and underscores only (must start with letter or underscore).');
      return;
    }

    const secret = isSecret !== false ? 1 : 0; // default to secret
    const encryptedValue = encryptToken(value);
    const row = await withUserClient(req, async (client) => {
      const workspace = await client.query<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
      if (workspace.rows.length === 0) {
        throw new NotFoundError('Workspace not found');
      }
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM workspace_env_vars WHERE workspace_id = $1 AND key = $2',
        [workspaceId, key]
      );
      if (existing.rows[0]) {
        const updated = await client.query<EnvVarRow>(
          `UPDATE workspace_env_vars SET encrypted_value = $1, is_secret = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
          [encryptedValue, secret, existing.rows[0].id]
        );
        return { row: updated.rows[0], created: false };
      }
      const id = randomUUID();
      const inserted = await client.query<EnvVarRow>(
        `INSERT INTO workspace_env_vars (id, workspace_id, key, encrypted_value, is_secret) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, workspaceId, key, encryptedValue, secret]
      );
      return { row: inserted.rows[0], created: true };
    });

    res.status(row.created ? 201 : 200).json({
      id: row.row.id,
      key: row.row.key,
      value: row.row.is_secret ? SECRET_MASK : value,
      isSecret: !!row.row.is_secret,
      createdAt: row.row.created_at,
      updatedAt: row.row.updated_at,
    });
  } catch (error: any) {
    handleRouteError(res, error, '[EnvVars] Create/update');
  }
});

/**
 * @swagger
 * /api/workspaces/{workspaceId}/env-vars/{key}:
 *   delete:
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Dashboard-only local-administrator environment configuration; excluded from autonomous/MCP exposure and protected by the native human-authority gate."
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
router.delete('/:key', async (req: Request, res: Response) => {
  try {
    const workspaceId = req.params.id;
    const key = req.params.key;

    const result = await withUserClient(req, async (client) => {
      const workspace = await client.query<{ id: string }>('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
      if (workspace.rows.length === 0) {
        throw new NotFoundError('Workspace not found');
      }
      const deletion = await client.query(
        'DELETE FROM workspace_env_vars WHERE workspace_id = $1 AND key = $2',
        [workspaceId, key]
      );
      return { rowCount: deletion.rowCount ?? 0 };
    });

    if (result.rowCount === 0) {
      throw new NotFoundError('Env var not found');
      return;
    }

    res.status(204).send();
  } catch (error: any) {
    handleRouteError(res, error, '[EnvVars] Delete');
  }
});

// ─── Helper: get decrypted env vars for pipeline injection ──────────────────

export async function getWorkspaceEnvVars(workspaceId: string): Promise<Record<string, string>> {
  const rows = await query<Pick<EnvVarRow, 'key' | 'encrypted_value'>>(
    'SELECT key, encrypted_value FROM workspace_env_vars WHERE workspace_id = $1',
    [workspaceId]
  );

  const vars: Record<string, string> = {};
  for (const row of rows) {
    vars[row.key] = decryptToken(row.encrypted_value);
  }
  return vars;
}

export default router;
