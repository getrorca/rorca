import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { query, queryOne, execute } from '../db/index';
import { JWT_SECRET, isSuperUser } from '../lib/auth-utils';
import type { AuthUser, WorkspaceRole } from '../lib/auth-utils';
import { chatComplete } from '../lib/llm-client';
import type { ProviderType } from '../lib/llm-client';
import { invalidateProviderCache } from '../lib/embedding-pipeline';
import { AuthError, ForbiddenError, NotFoundError, ValidationError } from '../lib/errors';
import { handleRouteError } from '../lib/async-handler';

const router = Router();

// Derive a 32-byte AES-256 key from JWT_SECRET (same approach as auth.ts for GitHub tokens)
const VAULT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();

async function getEffectiveUser(req: Request): Promise<AuthUser | null> {
  if (req.user) {
    return {
      id: req.user.id,
      email: req.user.email,
      supabaseId: req.user.supabaseId,
      role: req.user.role ?? 'admin',
      plan: req.user.plan,
    };
  }
  return null;
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', VAULT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store as iv:authTag:ciphertext (all hex)
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored: string): string {
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function maskKey(encrypted: string): string {
  try {
    const plain = decrypt(encrypted);
    return plain.length > 4 ? '****' + plain.slice(-4) : '****';
  } catch {
    return '****';
  }
}

interface VaultRow {
  id: string;
  workspace_id: string;
  user_id: string;
  provider: string;
  encrypted_key: string;
  label: string;
  base_url: string | null;
  spend_total_usd: number;
  last_used_at: string | null;
  created_at: string;
}

export interface VaultKeyResult {
  key: string;
  baseUrl: string | null;
}

function getBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice('Bearer '.length).trim() || null;
}

async function assertWorkspaceAccess(req: Request, workspaceId: string, minRole: WorkspaceRole = 'member'): Promise<void> {
  const user = req.user;
  if (!user) {
    throw new AuthError('Authentication required');
  }

  if (isSuperUser(user)) {
    return;
  }

  const membership = await queryOne<{ role: WorkspaceRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_auth_id = $2',
    [workspaceId, user.supabaseId]
  );

  if (!membership) {
    throw new ForbiddenError('Forbidden');
  }

  const rank: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };
  if (rank[membership.role] < rank[minRole]) {
    throw new ForbiddenError('Forbidden');
  }
}

function withUserClient(req: Request) {
  const accessToken = getBearerToken(req);
  if (!accessToken) {
    throw new AuthError('Missing bearer token');
  }

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new AuthError('Supabase anon client is not configured');
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });

  return Promise.resolve(client);
}

/**
 * @swagger
 * /api/vault/keys:
 *   post:
 *     tags: [Vault]
 *     summary: Store a new API key
 *     operationId: createVaultKey
 *     description: Encrypts and stores an API key in the vault using AES-256-GCM. The key is associated with the authenticated user and a specific provider.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider, key]
 *             properties:
 *               provider: { type: string, enum: [anthropic, openai, openrouter, openai-compat] }
 *               key: { type: string, description: "Raw API key to encrypt and store" }
 *               label: { type: string, description: "Optional human-readable label" }
 *               base_url: { type: string, description: "Optional base URL for OpenAI-compatible providers" }
 *     responses:
 *       201:
 *         description: Key stored successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id: { type: string }
 *                 provider: { type: string }
 *                 label: { type: string }
 *                 base_url: { type: string, nullable: true }
 *                 masked_key: { type: string }
 *                 created_at: { type: string, format: date-time }
 *       400: { description: "Missing or invalid provider/key" }
 *       401: { description: "No user found" }
 */
router.post('/', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { throw new AuthError('No user found'); return; }

  const userClient = await withUserClient(req);

  const { workspaceId, provider, key, label, base_url } = req.body;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('workspaceId is required');
  }
  await assertWorkspaceAccess(req, workspaceId, 'admin');

  if (!provider || typeof provider !== 'string') {
    throw new ValidationError('provider is required');
    return;
  }
  if (!key || typeof key !== 'string') {
    throw new ValidationError('key is required');
    return;
  }

  const validProviders = ['anthropic', 'openai', 'openrouter', 'openai-compat'];
  if (!validProviders.includes(provider)) {
    throw new ValidationError(`Invalid provider. Must be one of: ${validProviders.join(', ')}`);
    return;
  }

  const id = crypto.randomUUID();
  const encryptedKey = encrypt(key);
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safeBaseUrl = typeof base_url === 'string' && base_url.trim() ? base_url.trim() : null;

  const { error } = await userClient
    .from('api_key_vault')
    .insert({
      id,
      workspace_id: workspaceId,
      user_id: user.id,
      provider,
      encrypted_key: encryptedKey,
      label: safeLabel,
      base_url: safeBaseUrl,
    });

  if (error) {
    throw new AuthError(error.message);
  }

  // Invalidate embedding provider cache so auto-detection picks up the new key immediately
  invalidateProviderCache();

  res.status(201).json({
    id,
    provider,
    label: safeLabel,
    base_url: safeBaseUrl,
    masked_key: key.length > 4 ? '****' + key.slice(-4) : '****',
    created_at: new Date().toISOString(),
  });
});

/**
 * @swagger
 * /api/vault/keys:
 *   get:
 *     tags: [Vault]
 *     summary: List stored API keys
 *     operationId: listVaultKeys
 *     description: Returns all API keys stored by the authenticated user. Keys are masked (only last 4 characters visible) for security.
 *     responses:
 *       200:
 *         description: List of stored keys
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 keys:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       provider: { type: string }
 *                       label: { type: string }
 *                       base_url: { type: string, nullable: true }
 *                       masked_key: { type: string }
 *                       spend_total_usd: { type: number }
 *                       last_used_at: { type: string, format: date-time, nullable: true }
 *                       created_at: { type: string, format: date-time }
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const user = await getEffectiveUser(req);
    if (!user) { res.json({ keys: [] }); return; }

    const workspaceId = req.query.workspaceId;
    const hasWorkspaceFilter = typeof workspaceId === 'string' && workspaceId.length > 0;

    if (hasWorkspaceFilter) {
      await assertWorkspaceAccess(req, workspaceId as string, 'member');
    }

    const rows = hasWorkspaceFilter
      ? await query<VaultRow>(
          `SELECT id, workspace_id, user_id, provider, encrypted_key, label, base_url,
                  spend_total_usd, last_used_at, created_at
             FROM api_key_vault
            WHERE workspace_id = $1
            ORDER BY created_at DESC`,
          [workspaceId]
        )
      : isSuperUser(req.user)
        ? await query<VaultRow>(
            `SELECT id, workspace_id, user_id, provider, encrypted_key, label, base_url,
                    spend_total_usd, last_used_at, created_at
               FROM api_key_vault
              ORDER BY created_at DESC`
          )
        : await query<VaultRow>(
            `SELECT akv.id, akv.workspace_id, akv.user_id, akv.provider, akv.encrypted_key, akv.label, akv.base_url,
                    akv.spend_total_usd, akv.last_used_at, akv.created_at
               FROM api_key_vault akv
               JOIN workspace_members wm ON wm.workspace_id = akv.workspace_id
              WHERE wm.user_auth_id = $1
              ORDER BY akv.created_at DESC`,
            [user.supabaseId]
          );

    const keys = rows.map(row => ({
      id: row.id,
      provider: row.provider,
      label: row.label,
      base_url: row.base_url,
      masked_key: maskKey(row.encrypted_key),
      spend_total_usd: row.spend_total_usd,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
    }));

    res.json({ keys });
  } catch (error: any) {
    handleRouteError(res, error, '[Vault] List keys');
  }
});

/**
 * @swagger
 * /api/vault/keys/{id}:
 *   delete:
 *     tags: [Vault]
 *     summary: Delete a stored API key
 *     operationId: deleteVaultKey
 *     description: Permanently deletes an API key from the vault. Only the key owner can delete it. Returns the total spend tracked for the deleted key.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Vault key ID
 *     responses:
 *       200:
 *         description: Key deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *                 spend_total_usd: { type: number }
 *       401: { description: "No user found" }
 *       404: { description: "Key not found" }
 */
router.delete('/:id', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { throw new AuthError('No user found'); return; }
  const keyId = req.params.id;
  const workspaceId = req.query.workspaceId;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('workspaceId query param is required');
  }
  await assertWorkspaceAccess(req, workspaceId, 'admin');

  const userClient = await withUserClient(req);

  const { data: existingRows, error: selectError } = await userClient
    .from('api_key_vault')
    .select('id, spend_total_usd')
    .eq('id', keyId)
    .eq('workspace_id', workspaceId)
    .limit(1);

  if (selectError) {
    throw new AuthError(selectError.message);
  }

  const existing = existingRows?.[0] as Pick<VaultRow, 'id' | 'spend_total_usd'> | undefined;

  if (!existing) {
    throw new NotFoundError('Key not found');
    return;
  }

  const { error: deleteError } = await userClient
    .from('api_key_vault')
    .delete()
    .eq('id', keyId)
    .eq('workspace_id', workspaceId);

  if (deleteError) {
    throw new AuthError(deleteError.message);
  }

  // Invalidate embedding provider cache so auto-detection reflects the removed key
  invalidateProviderCache();

  res.json({ deleted: true, spend_total_usd: existing.spend_total_usd });
});

/**
 * @swagger
 * /api/vault/keys/test:
 *   post:
 *     tags: [Vault]
 *     summary: Test provider connection
 *     operationId: testVaultKeyConnection
 *     description: Tests connectivity to an LLM provider by sending a minimal prompt. For non-CLI providers, uses the stored vault key. Returns latency and a truncated response.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [provider]
 *             properties:
 *               provider: { type: string, enum: [claude-cli, anthropic, openai-compat, openrouter] }
 *     responses:
 *       200:
 *         description: Connection test succeeded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 latencyMs: { type: integer }
 *                 response: { type: string }
 *                 usage: { type: object }
 *       400: { description: "Missing or invalid provider, or no API key stored" }
 *       401: { description: "No user found" }
 *       500: { description: "Failed to decrypt stored API key" }
 *       502: { description: "Connection test failed" }
 */
router.post('/test', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { throw new AuthError('No user found'); return; }
  const userClient = await withUserClient(req);
  const { workspaceId, provider } = req.body as { workspaceId?: string; provider?: string };

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('workspaceId is required');
  }
  await assertWorkspaceAccess(req, workspaceId, 'member');

  if (!provider || typeof provider !== 'string') {
    throw new ValidationError('provider is required');
    return;
  }

  const validProviders = ['claude-cli', 'anthropic', 'openai-compat', 'openrouter'];
  if (!validProviders.includes(provider)) {
    throw new ValidationError(`Invalid provider. Must be one of: ${validProviders.join(', ')}`);
    return;
  }

  try {
    // For claude-cli, no vault key needed
    let apiKey: string | undefined;
    let baseUrl: string | undefined;

    if (provider !== 'claude-cli') {
      // Look up vault key for this user + provider
      const { data: rows, error: selectError } = await userClient
        .from('api_key_vault')
        .select('id, encrypted_key, base_url')
        .eq('workspace_id', workspaceId)
        .eq('provider', provider)
        .order('created_at', { ascending: false })
        .limit(1);

      if (selectError) {
        throw new AuthError(selectError.message);
      }

      const row = rows?.[0] as Pick<VaultRow, 'id' | 'encrypted_key' | 'base_url'> | undefined;

      if (!row) {
        throw new ValidationError(`No API key stored for provider "${provider}". Add a key first.`);
        return;
      }

      try {
        apiKey = decrypt(row.encrypted_key);
      } catch (decryptErr) {
        handleRouteError(res, decryptErr, '[Vault] Decrypt stored API key');
        return;
      }
      baseUrl = row.base_url || undefined;
    }

    const startMs = Date.now();
    const result = await chatComplete(
      [{ role: 'user', content: 'Respond with exactly: "ok"' }],
      {
        provider: provider as ProviderType,
        apiKey,
        baseUrl,
        model: provider === 'openrouter' ? 'anthropic/claude-haiku-4-5' : 'claude-haiku-4-5-20251001',
      },
    );
    const latencyMs = Date.now() - startMs;

    res.json({
      ok: true,
      latencyMs,
      response: result.text.slice(0, 100),
      usage: result.usage,
    });
  } catch (err: any) {
    res.status(502).json({
      ok: false,
      error: err.message || 'Connection test failed',
    });
  }
});

/**
 * @swagger
 * /api/vault/keys/default-provider:
 *   get:
 *     tags: [Vault]
 *     summary: Get default provider for a workspace
 *     operationId: getDefaultProvider
 *     description: Returns the default LLM provider configured for a specific workspace. Falls back to 'claude-cli' if no default is set.
 *     parameters:
 *       - in: query
 *         name: workspaceId
 *         required: true
 *         schema: { type: string }
 *         description: Workspace ID
 *     responses:
 *       200:
 *         description: Default provider
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 provider: { type: string }
 *       400: { description: "workspaceId query param is required" }
 */
router.get('/default-provider', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  const { workspaceId } = req.query;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('workspaceId query param is required');
    return;
  }

  if (!user) { res.json({ provider: 'claude-cli' }); return; }
  await assertWorkspaceAccess(req, workspaceId, 'member');

  const row = await queryOne<{ provider: string }>(
    'SELECT provider FROM provider_defaults WHERE user_id = $1 AND workspace_id = $2',
    [user.id, workspaceId]
  );

  res.json({ provider: row?.provider ?? 'claude-cli' });
});

/**
 * @swagger
 * /api/vault/keys/default-provider:
 *   put:
 *     tags: [Vault]
 *     summary: Set default provider for a workspace
 *     operationId: setDefaultProvider
 *     description: Sets or updates the default LLM provider for a specific workspace. Emits a WAL event on change.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workspaceId, provider]
 *             properties:
 *               workspaceId: { type: string }
 *               provider: { type: string, enum: [claude-cli, anthropic, openai-compat, openrouter] }
 *     responses:
 *       200:
 *         description: Default provider updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 provider: { type: string }
 *       400: { description: "Missing workspaceId or invalid provider" }
 *       401: { description: "No user found" }
 */
router.put('/default-provider', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  if (!user) { throw new AuthError('No user found'); return; }
  const { workspaceId, provider } = req.body;

  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new ValidationError('workspaceId is required');
    return;
  }
  await assertWorkspaceAccess(req, workspaceId, 'admin');
  if (!provider || typeof provider !== 'string') {
    throw new ValidationError('provider is required');
    return;
  }

  const validProviders = ['claude-cli', 'anthropic', 'openai-compat', 'openrouter'];
  if (!validProviders.includes(provider)) {
    throw new ValidationError(`Invalid provider. Must be one of: ${validProviders.join(', ')}`);
    return;
  }

  const id = crypto.randomUUID();
  await execute(`
    INSERT INTO provider_defaults (id, user_id, workspace_id, provider)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (user_id, workspace_id)
    DO UPDATE SET provider = excluded.provider, updated_at = NOW()
  `, [id, user.id, workspaceId, provider]);

  // WAL event
  await execute(
    `INSERT INTO wal_events (event_type, workspace_id, payload) VALUES ('provider_default_changed', $1, $2)`,
    [workspaceId, JSON.stringify({ provider, userId: user.id })]
  );

  res.json({ ok: true, provider });
});

/**
 * @swagger
 * /api/vault/keys/providers:
 *   get:
 *     tags: [Vault]
 *     summary: List provider status overview
 *     operationId: listProviderStatus
 *     description: Returns a list of all supported LLM providers with their configuration status, indicating whether a vault key or environment variable is present.
 *     responses:
 *       200:
 *         description: Provider status list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 providers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       configured: { type: boolean }
 *                       hasKey: { type: boolean }
 *                       baseUrl: { type: string, nullable: true }
 */
router.get('/providers', async (req: Request, res: Response) => {
  const user = await getEffectiveUser(req);
  const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
    ? req.query.workspaceId.trim()
    : null;

  if (workspaceId) {
    await assertWorkspaceAccess(req, workspaceId, 'member');
  }

  const providers: Array<{
    id: string;
    name: string;
    configured: boolean;
    hasKey: boolean;
    baseUrl: string | null;
  }> = [
    { id: 'claude-cli', name: 'Claude (Subscription)', configured: true, hasKey: false, baseUrl: null },
    { id: 'anthropic', name: 'Anthropic API', configured: false, hasKey: false, baseUrl: null },
    { id: 'openai-compat', name: 'OpenAI Compatible', configured: false, hasKey: false, baseUrl: null },
    { id: 'openrouter', name: 'OpenRouter', configured: false, hasKey: false, baseUrl: null },
  ];

  // Check vault for keys visible in the current workspace scope.
  const vaultRows = user
    ? workspaceId
      ? await query<{ provider: string; base_url: string | null }>(
          'SELECT provider, base_url FROM api_key_vault WHERE workspace_id = $1 ORDER BY created_at DESC',
          [workspaceId]
        )
      : isSuperUser(user)
        ? await query<{ provider: string; base_url: string | null }>(
            'SELECT provider, base_url FROM api_key_vault ORDER BY created_at DESC'
          )
        : await query<{ provider: string; base_url: string | null }>(
            `SELECT akv.provider, akv.base_url
               FROM api_key_vault akv
               JOIN workspace_members wm ON wm.workspace_id = akv.workspace_id
              WHERE wm.user_auth_id = $1
              ORDER BY akv.created_at DESC`,
            [user.supabaseId]
          )
    : [];

  for (const row of vaultRows) {
    const p = providers.find(p => p.id === row.provider);
    if (p) {
      p.configured = true;
      p.hasKey = true;
      if (row.base_url) p.baseUrl = row.base_url;
    }
  }

  // Also check env vars
  if (process.env.ANTHROPIC_API_KEY) {
    const p = providers.find(p => p.id === 'anthropic');
    if (p) p.configured = true;
  }
  if (process.env.OPENROUTER_API_KEY) {
    const p = providers.find(p => p.id === 'openrouter');
    if (p) p.configured = true;
  }
  if (process.env.OPENAI_API_KEY) {
    const p = providers.find(p => p.id === 'openai-compat');
    if (p) p.configured = true;
  }

  res.json({ providers });
});

// ─── Exported helper: resolve a user's vault key for a provider ─────────────

export async function getVaultKey(userId: string, provider: string): Promise<VaultKeyResult | null> {
  const row = await queryOne<Pick<VaultRow, 'id' | 'encrypted_key' | 'base_url'>>(
    'SELECT id, encrypted_key, base_url FROM api_key_vault WHERE user_id = $1 AND provider = $2 ORDER BY created_at DESC LIMIT 1',
    [userId, provider]
  );

  if (!row) return null;

  // Update last_used_at
  await execute('UPDATE api_key_vault SET last_used_at = NOW() WHERE id = $1', [row.id]);

  try {
    return { key: decrypt(row.encrypted_key), baseUrl: row.base_url };
  } catch {
    return null;
  }
}

// ─── OpenRouter Provider Preferences ─────────────────────────────────────────

/**
 * @swagger
 * /api/vault/openrouter-provider-prefs:
 *   get:
 *     tags: [Vault]
 *     summary: List all OpenRouter provider routing preferences
 *     operationId: getOpenRouterProviderPrefs
 *     responses:
 *       200:
 *         description: Array of per-model provider routing preferences
 */
router.get('/openrouter-provider-prefs', async (req: Request, res: Response) => {
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
      ? req.query.workspaceId.trim()
      : null;

    if (workspaceId) {
      await assertWorkspaceAccess(req, workspaceId, 'member');
    } else if (!isSuperUser(req.user)) {
      throw new ForbiddenError('Forbidden');
    }

    const rows = await query<{
      id: string; workspace_id: string | null; model_id: string; pref_order: string[] | null;
      ignore_list: string[] | null; allow_fallbacks: boolean;
    }>(
      workspaceId
        ? 'SELECT * FROM openrouter_provider_prefs WHERE workspace_id = $1 OR workspace_id IS NULL ORDER BY workspace_id NULLS LAST, model_id'
        : 'SELECT * FROM openrouter_provider_prefs ORDER BY workspace_id NULLS LAST, model_id',
      workspaceId ? [workspaceId] : []
    );
    res.json(rows.map(r => ({
      id: r.id,
      workspaceId: r.workspace_id,
      modelId: r.model_id,
      order: r.pref_order ?? [],
      ignore: r.ignore_list ?? [],
      allowFallbacks: r.allow_fallbacks,
    })));
  } catch (err) { handleRouteError(res, err); }
});

/**
 * @swagger
 * /api/vault/openrouter-provider-prefs:
 *   put:
 *     tags: [Vault]
 *     summary: Upsert OpenRouter provider routing preferences for a model
 *     operationId: putOpenRouterProviderPrefs
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [modelId]
 *             properties:
 *               modelId:
 *                 type: string
 *               order:
 *                 type: array
 *                 items: { type: string }
 *               ignore:
 *                 type: array
 *                 items: { type: string }
 *               allowFallbacks:
 *                 type: boolean
 */
router.put('/openrouter-provider-prefs', async (req: Request, res: Response) => {
  try {
    const { workspaceId, modelId, order, ignore, allowFallbacks } = req.body;
    if (!modelId || typeof modelId !== 'string') throw new ValidationError('modelId is required');

    if (workspaceId && typeof workspaceId !== 'string') {
      throw new ValidationError('workspaceId must be a string when provided');
    }

    if (workspaceId) {
      await assertWorkspaceAccess(req, workspaceId, 'admin');
    } else if (!isSuperUser(req.user)) {
      throw new ForbiddenError('Forbidden');
    }

    const existing = await queryOne<{ id: string }>(
      workspaceId
        ? 'SELECT id FROM openrouter_provider_prefs WHERE workspace_id = $1 AND model_id = $2'
        : 'SELECT id FROM openrouter_provider_prefs WHERE workspace_id IS NULL AND model_id = $1',
      workspaceId ? [workspaceId, modelId] : [modelId],
    );

    let recordId = existing?.id;
    if (existing) {
      await execute(
        workspaceId
          ? `UPDATE openrouter_provider_prefs
                SET pref_order = $3, ignore_list = $4, allow_fallbacks = $5, updated_at = NOW()
              WHERE workspace_id = $1 AND model_id = $2`
          : `UPDATE openrouter_provider_prefs
                SET pref_order = $2, ignore_list = $3, allow_fallbacks = $4, updated_at = NOW()
              WHERE workspace_id IS NULL AND model_id = $1`,
        workspaceId
          ? [workspaceId, modelId, order ?? [], ignore ?? [], allowFallbacks ?? true]
          : [modelId, order ?? [], ignore ?? [], allowFallbacks ?? true],
      );
    } else {
      recordId = crypto.randomUUID();
      await execute(
        `INSERT INTO openrouter_provider_prefs (id, workspace_id, model_id, pref_order, ignore_list, allow_fallbacks)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [recordId, workspaceId ?? null, modelId, order ?? [], ignore ?? [], allowFallbacks ?? true],
      );
    }

    res.json({ ok: true, id: recordId, workspaceId: workspaceId ?? null, modelId });
  } catch (err) { handleRouteError(res, err); }
});

/**
 * @swagger
 * /api/vault/openrouter-provider-prefs/{modelId}:
 *   delete:
 *     tags: [Vault]
 *     summary: Delete OpenRouter provider routing preferences for a model
 *     operationId: deleteOpenRouterProviderPrefs
 */
router.delete('/openrouter-provider-prefs/:modelId', async (req: Request, res: Response) => {
  try {
    const { modelId } = req.params;
    const workspaceId = typeof req.query.workspaceId === 'string' && req.query.workspaceId.trim()
      ? req.query.workspaceId.trim()
      : null;

    if (workspaceId) {
      await assertWorkspaceAccess(req, workspaceId, 'admin');
      await execute('DELETE FROM openrouter_provider_prefs WHERE workspace_id = $1 AND model_id = $2', [workspaceId, modelId]);
    } else {
      if (!isSuperUser(req.user)) {
        throw new ForbiddenError('Forbidden');
      }
      await execute('DELETE FROM openrouter_provider_prefs WHERE workspace_id IS NULL AND model_id = $1', [modelId]);
    }

    res.json({ ok: true });
  } catch (err) { handleRouteError(res, err); }
});

/** Look up DB-stored provider prefs for a model, returns null if none saved. */
export async function getOpenRouterPrefs(modelId: string, workspaceId?: string | null): Promise<{ order?: string[]; ignore?: string[]; allow_fallbacks?: boolean } | null> {
  const row = await queryOne<{ pref_order: string[] | null; ignore_list: string[] | null; allow_fallbacks: boolean }>(
    workspaceId
      ? `SELECT pref_order, ignore_list, allow_fallbacks
           FROM openrouter_provider_prefs
          WHERE model_id = $1
            AND (workspace_id = $2 OR workspace_id IS NULL)
          ORDER BY CASE WHEN workspace_id = $2 THEN 0 ELSE 1 END
          LIMIT 1`
      : 'SELECT pref_order, ignore_list, allow_fallbacks FROM openrouter_provider_prefs WHERE workspace_id IS NULL AND model_id = $1',
    workspaceId ? [modelId, workspaceId] : [modelId],
  );
  if (!row) return null;
  return {
    order: row.pref_order ?? undefined,
    ignore: row.ignore_list ?? undefined,
    allow_fallbacks: row.allow_fallbacks,
  };
}

export default router;
