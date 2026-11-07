/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { canonicalTransaction, query, queryOne } from '../db/index';
import { decryptToken, encryptToken } from '../lib/auth-utils';
import { NotFoundError, UnprocessableError, ValidationError } from '../lib/errors';

const router = Router();
const VALID_PROVIDERS = ['anthropic', 'openai-compat', 'openrouter'] as const;

interface VaultRow {
  id: string;
  user_id: string;
  provider: string;
  encrypted_key: string;
  label: string;
  spend_total_usd: number;
  last_used_at: string | null;
  base_url: string | null;
  created_at: string;
  workspace_id: string | null;
}

export interface VaultKeyResult {
  key: string;
  baseUrl: string | null;
}

function currentUserId(req: Request): string {
  if (!req.user?.id) throw new ValidationError('Authenticated local user is required');
  return req.user.id;
}

function maskKey(encryptedKey: string): string {
  try {
    const plain = decryptToken(encryptedKey);
    return plain.length > 4 ? `****${plain.slice(-4)}` : '****';
  } catch {
    return '****';
  }
}

function publicKey(row: VaultRow) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    masked_key: maskKey(row.encrypted_key),
    base_url: row.base_url,
    spend_total_usd: Number(row.spend_total_usd ?? 0),
    last_used_at: row.last_used_at,
    created_at: row.created_at,
  };
}

/**
 * @swagger
 * /api/vault/keys:
 *   get:
 *     summary: List encrypted provider keys visible to the local user
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Returns masked metadata for user-owned local provider credentials; raw secret material is never returned."
 *     responses:
 *       200: { description: Masked key list }
 */
router.get('/keys', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
    ? req.query.workspaceId.trim()
    : null;
  const rows = await query<VaultRow>(
    workspaceId
      ? 'SELECT * FROM rorca.api_key_vault WHERE user_id = $1 AND workspace_id = $2 ORDER BY created_at DESC'
      : 'SELECT * FROM rorca.api_key_vault WHERE user_id = $1 ORDER BY created_at DESC',
    workspaceId ? [userId, workspaceId] : [userId],
  );
  res.json({ keys: rows.map(publicKey) });
});

/**
 * @swagger
 * /api/vault/keys:
 *   post:
 *     summary: Store an encrypted local provider key
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Stores a user-supplied provider credential encrypted at rest for that user's selected workspace."
 *     responses:
 *       201: { description: Key stored }
 */
router.post('/keys', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const { workspaceId, provider, key, label, base_url: baseUrl } = req.body ?? {};
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new ValidationError('workspaceId is required');
  if (!VALID_PROVIDERS.includes(provider)) throw new ValidationError(`provider must be one of: ${VALID_PROVIDERS.join(', ')}`);
  if (typeof key !== 'string' || !key.trim()) throw new ValidationError('key is required');
  if (baseUrl != null && typeof baseUrl !== 'string') throw new ValidationError('base_url must be a string');
  const workspace = await queryOne<{ id: string }>('SELECT id FROM rorca.workspaces WHERE id = $1', [workspaceId.trim()]);
  if (!workspace) throw new NotFoundError('Workspace not found');

  const id = crypto.randomUUID();
  const row = await canonicalTransaction(async (client) => {
    const result = await client.query<VaultRow>(
      `INSERT INTO rorca.api_key_vault (id, user_id, workspace_id, provider, encrypted_key, label, base_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [id, userId, workspaceId.trim(), provider, encryptToken(key.trim()), typeof label === 'string' ? label.trim() : '', baseUrl?.trim() || null],
    );
    return result.rows[0]!;
  });
  res.status(201).json(publicKey(row));
});

/**
 * @swagger
 * /api/vault/keys/default-provider:
 *   get:
 *     summary: Get the workspace's default provider
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Reads a user-owned workspace execution preference with no external side effects."
 *     responses:
 *       200: { description: Default provider }
 */
router.get('/keys/default-provider', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  if (!workspaceId) throw new ValidationError('workspaceId query param is required');
  const row = await queryOne<{ provider: string }>(
    'SELECT provider FROM rorca.provider_defaults WHERE user_id = $1 AND workspace_id = $2',
    [userId, workspaceId],
  );
  res.json({ provider: row?.provider ?? 'claude-cli' });
});

/**
 * @swagger
 * /api/vault/keys/default-provider:
 *   put:
 *     summary: Set the workspace's default provider
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Updates a user-owned local workspace execution preference."
 *     responses:
 *       200: { description: Default provider updated }
 */
router.put('/keys/default-provider', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const { workspaceId, provider } = req.body ?? {};
  const valid = ['claude-cli', ...VALID_PROVIDERS];
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new ValidationError('workspaceId is required');
  if (typeof provider !== 'string' || !valid.includes(provider as typeof valid[number])) {
    throw new ValidationError(`provider must be one of: ${valid.join(', ')}`);
  }
  await canonicalTransaction(async (client) => {
    await client.query(
      `INSERT INTO rorca.provider_defaults (id, user_id, workspace_id, provider)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, workspace_id) DO UPDATE SET provider = EXCLUDED.provider, updated_at = NOW()`,
      [crypto.randomUUID(), userId, workspaceId.trim(), provider],
    );
  });
  res.json({ ok: true, provider });
});

/**
 * @swagger
 * /api/vault/keys/providers:
 *   get:
 *     summary: List local provider configuration status
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Returns masked configuration status for local provider selection."
 *     responses:
 *       200: { description: Provider status list }
 */
router.get('/keys/providers', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
    ? req.query.workspaceId.trim()
    : null;
  const rows = await query<Pick<VaultRow, 'provider' | 'base_url'>>(
    workspaceId
      ? 'SELECT provider, base_url FROM rorca.api_key_vault WHERE user_id = $1 AND workspace_id = $2 ORDER BY created_at DESC'
      : 'SELECT provider, base_url FROM rorca.api_key_vault WHERE user_id = $1 ORDER BY created_at DESC',
    workspaceId ? [userId, workspaceId] : [userId],
  );
  const definitions = [
    { id: 'claude-cli', name: 'Claude (Subscription)' },
    { id: 'anthropic', name: 'Anthropic API' },
    { id: 'openai-compat', name: 'OpenAI Compatible' },
    { id: 'openrouter', name: 'OpenRouter' },
  ];
  res.json({
    providers: definitions.map((definition) => {
      const key = rows.find((row) => row.provider === definition.id);
      return {
        ...definition,
        configured: definition.id === 'claude-cli' || Boolean(key),
        hasKey: Boolean(key),
        baseUrl: key?.base_url ?? null,
      };
    }),
  });
});

/**
 * @swagger
 * /api/vault/keys/{id}:
 *   delete:
 *     summary: Delete a user-owned encrypted provider key
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Deletes only the authenticated user's selected local credential."
 *     responses:
 *       200: { description: Key deleted }
 */
router.delete('/keys/:id', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  const rowCount = await canonicalTransaction(async (client) => {
    const result = await client.query(
      workspaceId
        ? 'DELETE FROM rorca.api_key_vault WHERE id = $1 AND user_id = $2 AND workspace_id = $3'
        : 'DELETE FROM rorca.api_key_vault WHERE id = $1 AND user_id = $2',
      workspaceId ? [req.params.id, userId, workspaceId] : [req.params.id, userId],
    );
    return result.rowCount ?? 0;
  });
  if (rowCount === 0) throw new NotFoundError('API key not found');
  res.json({ ok: true });
});

/**
 * @swagger
 * /api/vault/keys/test:
 *   post:
 *     summary: Report local key test availability
 *     x-rorca-native-api: true
 *     x-rorca-native-authority: local-admin
 *     x-rorca-rationale: "Validates whether an encrypted local provider key exists without exposing it or making an unbounded provider request."
 *     responses:
 *       200: { description: Key is available for provider use }
 */
router.post('/keys/test', async (req: Request, res: Response) => {
  const userId = currentUserId(req);
  const { workspaceId, provider } = req.body ?? {};
  if (typeof workspaceId !== 'string' || typeof provider !== 'string') throw new ValidationError('workspaceId and provider are required');
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM rorca.api_key_vault WHERE user_id = $1 AND workspace_id = $2 AND provider = $3 ORDER BY created_at DESC LIMIT 1',
    [userId, workspaceId, provider],
  );
  if (!row) throw new UnprocessableError('No provider key is configured for this workspace', 'PROVIDER_KEY_NOT_CONFIGURED');
  res.json({ ok: true, latencyMs: 0, response: 'Encrypted credential is available' });
});

export async function getVaultKey(userId: string | number, provider: string): Promise<VaultKeyResult | null> {
  const row = await queryOne<Pick<VaultRow, 'id' | 'encrypted_key' | 'base_url'>>(
    'SELECT id, encrypted_key, base_url FROM rorca.api_key_vault WHERE user_id = $1 AND provider = $2 ORDER BY created_at DESC LIMIT 1',
    [String(userId), provider],
  );
  if (!row) return null;
  await canonicalTransaction(async (client) => {
    await client.query('UPDATE rorca.api_key_vault SET last_used_at = NOW() WHERE id = $1', [row.id]);
  });
  try {
    return { key: decryptToken(row.encrypted_key), baseUrl: row.base_url };
  } catch {
    return null;
  }
}

export async function getOpenRouterPrefs(modelId: string, workspaceId?: string | null): Promise<Record<string, unknown> | null> {
  const row = await queryOne<{ pref_order: string[] | null; ignore_list: string[] | null; allow_fallbacks: boolean }>(
    workspaceId
      ? `SELECT pref_order, ignore_list, allow_fallbacks FROM rorca.openrouter_provider_prefs
         WHERE model_id = $1 AND (workspace_id = $2 OR workspace_id IS NULL)
         ORDER BY CASE WHEN workspace_id = $2 THEN 0 ELSE 1 END LIMIT 1`
      : 'SELECT pref_order, ignore_list, allow_fallbacks FROM rorca.openrouter_provider_prefs WHERE workspace_id IS NULL AND model_id = $1',
    workspaceId ? [modelId, workspaceId] : [modelId],
  );
  if (!row) return null;
  return { order: row.pref_order ?? undefined, ignore: row.ignore_list ?? undefined, allow_fallbacks: row.allow_fallbacks };
}

export default router;
