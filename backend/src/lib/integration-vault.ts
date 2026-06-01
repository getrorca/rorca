/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * integration-vault.ts — Workspace-scoped OAuth token management for integrations
 *
 * Stores and retrieves encrypted OAuth tokens (access, refresh), API keys, and
 * webhook secrets for GitHub, Linear, Vercel, and Slack integrations.
 *
 * All tokens encrypted with AES-256-GCM. Key derived from JWT_SECRET (or VAULT_KEY
 * env var override) via SHA-256, matching the existing vault.ts pattern.
 */

import crypto from 'crypto';
import { query, queryOne, execute } from '../db/index';
import { ValidationError } from './errors';

// ─── Types ──────────────────────────────────────────────────────────────────

export type IntegrationProvider = 'github' | 'linear' | 'vercel' | 'slack';
export type TokenType = 'oauth_access' | 'oauth_refresh' | 'api_key' | 'webhook_secret';

export interface TokenData {
  token: string;
  tokenType?: TokenType;
  scopes?: string[];
  expiresAt?: Date | null;
}

export interface StoredToken {
  id: string;
  workspaceId: string;
  provider: IntegrationProvider;
  tokenType: TokenType;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TokenRow {
  id: string;
  workspace_id: string;
  provider: string;
  token_type: string;
  encrypted_token: string;
  scopes: string[];
  expires_at: string | null;
  revoked_at: string | null;
  last_validated_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Encryption ─────────────────────────────────────────────────────────────

const VALID_PROVIDERS: IntegrationProvider[] = ['github', 'linear', 'vercel', 'slack'];
const VALID_TOKEN_TYPES: TokenType[] = ['oauth_access', 'oauth_refresh', 'api_key', 'webhook_secret'];

function getVaultKey(): Buffer {
  // Prefer explicit VAULT_KEY, fall back to JWT_SECRET (same pattern as vault.ts)
  const raw = process.env.VAULT_KEY || process.env.JWT_SECRET;
  if (!raw) {
    throw new ValidationError('VAULT_KEY environment variable required for token encryption');
  }

  // If VAULT_KEY is explicitly set, validate it's a 64-char hex string
  if (process.env.VAULT_KEY) {
    if (!/^[0-9a-fA-F]{64}$/.test(process.env.VAULT_KEY)) {
      throw new ValidationError('VAULT_KEY must be a 64-character hex string');
    }
    return Buffer.from(process.env.VAULT_KEY, 'hex');
  }

  // Derive 32 bytes from JWT_SECRET via SHA-256 (matches vault.ts and auth.ts pattern)
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext: string): string {
  const key = getVaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(stored: string): string {
  const key = getVaultKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function rowToStoredToken(row: TokenRow): StoredToken {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider as IntegrationProvider,
    tokenType: row.token_type as TokenType,
    scopes: row.scopes || [],
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Store an OAuth token (or API key / webhook secret) for a workspace+provider.
 * Upserts on (workspace_id, provider, token_type) — replaces existing token.
 */
export async function storeOAuthToken(
  workspaceId: string,
  provider: IntegrationProvider,
  tokenData: TokenData,
): Promise<StoredToken> {
  if (!VALID_PROVIDERS.includes(provider)) {
    throw new ValidationError(`Invalid provider: ${provider}. Must be one of: ${VALID_PROVIDERS.join(', ')}`);
  }

  const tokenType = tokenData.tokenType || 'oauth_access';
  if (!VALID_TOKEN_TYPES.includes(tokenType)) {
    throw new ValidationError(`Invalid token_type: ${tokenType}. Must be one of: ${VALID_TOKEN_TYPES.join(', ')}`);
  }

  const encryptedToken = encrypt(tokenData.token);
  const id = crypto.randomUUID();
  const scopes = tokenData.scopes || [];
  const expiresAt = tokenData.expiresAt ?? null;

  const row = await queryOne<TokenRow>(`
    INSERT INTO integration_tokens (id, workspace_id, provider, token_type, encrypted_token, scopes, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
    ON CONFLICT (workspace_id, provider, token_type)
    DO UPDATE SET
      encrypted_token = EXCLUDED.encrypted_token,
      scopes = EXCLUDED.scopes,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL,
      updated_at = NOW()
    RETURNING *
  `, [id, workspaceId, provider, tokenType, encryptedToken, scopes, expiresAt]);

  return rowToStoredToken(row!);
}

/**
 * Retrieve and decrypt an OAuth token for a workspace+provider.
 * Returns null if no token exists or if the token has been revoked.
 * Default token_type is 'oauth_access'.
 */
export async function getOAuthToken(
  workspaceId: string,
  provider: IntegrationProvider,
  tokenType: TokenType = 'oauth_access',
): Promise<{ token: string; metadata: StoredToken } | null> {
  const row = await queryOne<TokenRow>(`
    SELECT * FROM integration_tokens
    WHERE workspace_id = $1 AND provider = $2 AND token_type = $3 AND revoked_at IS NULL
    ORDER BY updated_at DESC LIMIT 1
  `, [workspaceId, provider, tokenType]);

  if (!row) return null;

  try {
    const token = decrypt(row.encrypted_token);
    return { token, metadata: rowToStoredToken(row) };
  } catch {
    return null;
  }
}

/**
 * Revoke all tokens for a workspace+provider (soft delete via revoked_at timestamp).
 * Returns the number of tokens revoked.
 */
export async function revokeToken(
  workspaceId: string,
  provider: IntegrationProvider,
): Promise<number> {
  const result = await execute(`
    UPDATE integration_tokens
    SET revoked_at = NOW(), updated_at = NOW()
    WHERE workspace_id = $1 AND provider = $2 AND revoked_at IS NULL
  `, [workspaceId, provider]);

  return result.rowCount;
}

/**
 * List all tokens for a workspace (without decrypted values).
 * Excludes revoked tokens by default.
 */
export async function listTokens(
  workspaceId: string,
  options?: { includeRevoked?: boolean },
): Promise<StoredToken[]> {
  const includeRevoked = options?.includeRevoked ?? false;

  const sql = includeRevoked
    ? `SELECT * FROM integration_tokens WHERE workspace_id = $1 ORDER BY provider, token_type`
    : `SELECT * FROM integration_tokens WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY provider, token_type`;

  const rows = await query<TokenRow>(sql, [workspaceId]);
  return rows.map(rowToStoredToken);
}

/**
 * Update last_validated_at timestamp for a token.
 */
export async function markTokenValidated(
  workspaceId: string,
  provider: IntegrationProvider,
  tokenType: TokenType = 'oauth_access',
): Promise<void> {
  await execute(`
    UPDATE integration_tokens
    SET last_validated_at = NOW(), updated_at = NOW()
    WHERE workspace_id = $1 AND provider = $2 AND token_type = $3 AND revoked_at IS NULL
  `, [workspaceId, provider, tokenType]);
}

export async function getDecryptedProviderKey(
  workspaceId: string,
  provider: string,
): Promise<string | null> {
  const token = await getOAuthToken(workspaceId, provider as IntegrationProvider, 'api_key');
  return token?.token ?? null;
}
