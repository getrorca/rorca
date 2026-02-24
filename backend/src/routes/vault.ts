import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { JWT_SECRET } from './auth';
import type { AuthUser } from './auth';

const router = Router();

// Derive a 32-byte AES-256 key from JWT_SECRET (same approach as auth.ts for GitHub tokens)
const VAULT_KEY = crypto.createHash('sha256').update(JWT_SECRET).digest();

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

// ─── POST /api/vault/keys ───────────────────────────────────────────────────

router.post('/', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;

  const { provider, key, label, base_url } = req.body;

  if (!provider || typeof provider !== 'string') {
    res.status(400).json({ error: 'provider is required' });
    return;
  }
  if (!key || typeof key !== 'string') {
    res.status(400).json({ error: 'key is required' });
    return;
  }

  const validProviders = ['anthropic', 'openai', 'openrouter', 'openai-compat'];
  if (!validProviders.includes(provider)) {
    res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` });
    return;
  }

  const id = crypto.randomUUID();
  const encryptedKey = encrypt(key);
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safeBaseUrl = typeof base_url === 'string' && base_url.trim() ? base_url.trim() : null;

  db.prepare(
    'INSERT INTO api_key_vault (id, user_id, provider, encrypted_key, label, base_url) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, user.id, provider, encryptedKey, safeLabel, safeBaseUrl);

  res.status(201).json({
    id,
    provider,
    label: safeLabel,
    base_url: safeBaseUrl,
    masked_key: key.length > 4 ? '****' + key.slice(-4) : '****',
    created_at: new Date().toISOString(),
  });
});

// ─── GET /api/vault/keys ────────────────────────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;

  const rows = db.prepare(
    'SELECT id, provider, encrypted_key, label, base_url, spend_total_usd, last_used_at, created_at FROM api_key_vault WHERE user_id = ? ORDER BY created_at DESC'
  ).all(user.id) as VaultRow[];

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
});

// ─── DELETE /api/vault/keys/:id ─────────────────────────────────────────────

router.delete('/:id', (req: Request, res: Response) => {
  const user = (req as Request & { user: AuthUser }).user;
  const keyId = req.params.id;

  // Verify ownership before deleting
  const existing = db.prepare(
    'SELECT id, spend_total_usd FROM api_key_vault WHERE id = ? AND user_id = ?'
  ).get(keyId, user.id) as VaultRow | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }

  db.prepare('DELETE FROM api_key_vault WHERE id = ? AND user_id = ?').run(keyId, user.id);

  res.json({ deleted: true, spend_total_usd: existing.spend_total_usd });
});

// ─── Exported helper: resolve a user's vault key for a provider ─────────────

export function getVaultKey(userId: string, provider: string): VaultKeyResult | null {
  const row = db.prepare(
    'SELECT id, encrypted_key, base_url FROM api_key_vault WHERE user_id = ? AND provider = ? ORDER BY created_at DESC LIMIT 1'
  ).get(userId, provider) as Pick<VaultRow, 'id' | 'encrypted_key' | 'base_url'> | undefined;

  if (!row) return null;

  // Update last_used_at
  db.prepare('UPDATE api_key_vault SET last_used_at = datetime(\'now\') WHERE id = ?').run(row.id);

  try {
    return { key: decrypt(row.encrypted_key), baseUrl: row.base_url };
  } catch {
    return null;
  }
}

export default router;
