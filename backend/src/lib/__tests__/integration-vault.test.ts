/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';

// Mock DB before importing the module under test
jest.mock('../../db/index', () => {
  const store: Record<string, any> = {};
  return {
    query: jest.fn(async (sql: string, params: any[]) => {
      const workspaceId = params[0];
      return Object.values(store).filter((r: any) => {
        if (r.workspace_id !== workspaceId) return false;
        // Check revoked filter if SQL includes it
        if (sql.includes('revoked_at IS NULL') && r.revoked_at !== null) return false;
        return true;
      });
    }),
    queryOne: jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes('INSERT INTO')) {
        // Simulate UPSERT RETURNING *
        const id = params[0];
        const row = {
          id,
          workspace_id: params[1],
          provider: params[2],
          token_type: params[3],
          encrypted_token: params[4],
          scopes: params[5] || [],
          expires_at: params[6] || null,
          revoked_at: null,
          last_validated_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        const key = `${row.workspace_id}:${row.provider}:${row.token_type}`;
        // Check for existing (simulate ON CONFLICT UPDATE)
        const existing = Object.entries(store).find(
          ([, v]: [string, any]) =>
            v.workspace_id === row.workspace_id &&
            v.provider === row.provider &&
            v.token_type === row.token_type,
        );
        if (existing) {
          const [oldKey] = existing;
          store[oldKey] = {
            ...store[oldKey],
            encrypted_token: row.encrypted_token,
            scopes: row.scopes,
            expires_at: row.expires_at,
            revoked_at: null,
            updated_at: new Date().toISOString(),
          };
          return store[oldKey];
        }
        store[key] = row;
        return row;
      }
      // SELECT for getOAuthToken
      const workspaceId = params[0];
      const provider = params[1];
      const tokenType = params[2];
      const match = Object.values(store).find(
        (r: any) =>
          r.workspace_id === workspaceId &&
          r.provider === provider &&
          r.token_type === tokenType &&
          r.revoked_at === null,
      );
      return match || undefined;
    }),
    execute: jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes('UPDATE') && sql.includes('revoked_at')) {
        // Revoke tokens
        const workspaceId = params[0];
        const provider = params[1];
        let count = 0;
        for (const row of Object.values(store) as any[]) {
          if (row.workspace_id === workspaceId && row.provider === provider && row.revoked_at === null) {
            row.revoked_at = new Date().toISOString();
            row.updated_at = new Date().toISOString();
            count++;
          }
        }
        return { rowCount: count };
      }
      if (sql.includes('UPDATE') && sql.includes('last_validated_at')) {
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    }),
    __store: store,
  };
});

// Set JWT_SECRET before importing the module
process.env.JWT_SECRET = 'test-secret-for-vault-encryption';

import {
  storeOAuthToken,
  getOAuthToken,
  revokeToken,
  listTokens,
  markTokenValidated,
} from '../integration-vault';
import type { IntegrationProvider } from '../integration-vault';
import { ValidationError } from '../errors';

const db = require('../../db/index');

beforeEach(() => {
  // Clear in-memory store
  for (const key of Object.keys(db.__store)) {
    delete db.__store[key];
  }
  jest.clearAllMocks();
});

describe('integration-vault', () => {
  describe('storeOAuthToken', () => {
    it('encrypts and stores a token', async () => {
      const result = await storeOAuthToken('ws-1', 'github', {
        token: 'gho_abc123',
        scopes: ['repo', 'user:email'],
        expiresAt: new Date('2026-12-31T00:00:00Z'),
      });

      expect(result.workspaceId).toBe('ws-1');
      expect(result.provider).toBe('github');
      expect(result.tokenType).toBe('oauth_access');
      expect(result.scopes).toEqual(['repo', 'user:email']);
      expect(new Date(result.expiresAt!).toISOString()).toBe('2026-12-31T00:00:00.000Z');
      expect(result.revokedAt).toBeNull();

      // Verify DB was called with encrypted (not plaintext) token
      const insertCall = db.queryOne.mock.calls[0];
      const encryptedToken = insertCall[1][4];
      expect(encryptedToken).not.toBe('gho_abc123');
      expect(encryptedToken).toContain(':'); // iv:authTag:ciphertext format
    });

    it('defaults token_type to oauth_access', async () => {
      const result = await storeOAuthToken('ws-1', 'linear', {
        token: 'lin_token',
      });
      expect(result.tokenType).toBe('oauth_access');
    });

    it('accepts explicit token_type', async () => {
      const result = await storeOAuthToken('ws-1', 'github', {
        token: 'whsec_123',
        tokenType: 'webhook_secret',
      });
      expect(result.tokenType).toBe('webhook_secret');
    });

    it('throws ValidationError for invalid provider', async () => {
      await expect(
        storeOAuthToken('ws-1', 'invalid' as IntegrationProvider, { token: 'x' }),
      ).rejects.toThrow(ValidationError);
    });

    it('completes within 50ms for a single token', async () => {
      const start = performance.now();
      await storeOAuthToken('ws-1', 'github', { token: 'gho_perf_test' });
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('getOAuthToken', () => {
    it('retrieves and decrypts a stored token', async () => {
      await storeOAuthToken('ws-1', 'github', {
        token: 'gho_secret_value',
        scopes: ['repo'],
      });

      const result = await getOAuthToken('ws-1', 'github');
      expect(result).not.toBeNull();
      expect(result!.token).toBe('gho_secret_value');
      expect(result!.metadata.provider).toBe('github');
      expect(result!.metadata.scopes).toEqual(['repo']);
    });

    it('returns null when no token exists', async () => {
      const result = await getOAuthToken('ws-nonexistent', 'github');
      expect(result).toBeNull();
    });

    it('returns null for revoked tokens', async () => {
      await storeOAuthToken('ws-1', 'slack', { token: 'xoxb-revoked' });
      await revokeToken('ws-1', 'slack');

      const result = await getOAuthToken('ws-1', 'slack');
      expect(result).toBeNull();
    });

    it('returns token for specific token_type', async () => {
      await storeOAuthToken('ws-1', 'github', {
        token: 'gho_access',
        tokenType: 'oauth_access',
      });
      await storeOAuthToken('ws-1', 'github', {
        token: 'ghr_refresh',
        tokenType: 'oauth_refresh',
      });

      const access = await getOAuthToken('ws-1', 'github', 'oauth_access');
      expect(access!.token).toBe('gho_access');

      const refresh = await getOAuthToken('ws-1', 'github', 'oauth_refresh');
      expect(refresh!.token).toBe('ghr_refresh');
    });
  });

  describe('revokeToken', () => {
    it('soft-revokes all tokens for a workspace+provider', async () => {
      await storeOAuthToken('ws-1', 'github', { token: 'access', tokenType: 'oauth_access' });
      await storeOAuthToken('ws-1', 'github', { token: 'refresh', tokenType: 'oauth_refresh' });

      const count = await revokeToken('ws-1', 'github');
      expect(count).toBe(2);
    });

    it('returns 0 when no tokens to revoke', async () => {
      const count = await revokeToken('ws-empty', 'vercel');
      expect(count).toBe(0);
    });
  });

  describe('listTokens', () => {
    it('returns empty array when no tokens stored', async () => {
      const tokens = await listTokens('ws-empty');
      expect(tokens).toEqual([]);
    });

    it('lists all active tokens for a workspace', async () => {
      await storeOAuthToken('ws-1', 'github', { token: 'gh_tok' });
      await storeOAuthToken('ws-1', 'linear', { token: 'lin_tok' });

      const tokens = await listTokens('ws-1');
      expect(tokens).toHaveLength(2);
      // Should not contain decrypted token values
      for (const t of tokens) {
        expect(t).not.toHaveProperty('token');
        expect(t).toHaveProperty('provider');
        expect(t).toHaveProperty('tokenType');
      }
    });

    it('excludes revoked tokens by default', async () => {
      await storeOAuthToken('ws-1', 'github', { token: 'gh_tok' });
      await storeOAuthToken('ws-1', 'slack', { token: 'slack_tok' });
      await revokeToken('ws-1', 'slack');

      const tokens = await listTokens('ws-1');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].provider).toBe('github');
    });
  });

  describe('VAULT_KEY validation', () => {
    it('throws when neither VAULT_KEY nor JWT_SECRET is set', async () => {
      const origJwt = process.env.JWT_SECRET;
      const origVault = process.env.VAULT_KEY;
      delete process.env.JWT_SECRET;
      delete process.env.VAULT_KEY;

      await expect(
        storeOAuthToken('ws-1', 'github', { token: 'test' }),
      ).rejects.toThrow('VAULT_KEY environment variable required for token encryption');

      process.env.JWT_SECRET = origJwt;
      if (origVault) process.env.VAULT_KEY = origVault;
    });

    it('throws when VAULT_KEY is not a valid 64-char hex string', async () => {
      const origJwt = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      process.env.VAULT_KEY = 'not-a-hex-string';

      await expect(
        storeOAuthToken('ws-1', 'github', { token: 'test' }),
      ).rejects.toThrow('VAULT_KEY must be a 64-character hex string');

      delete process.env.VAULT_KEY;
      process.env.JWT_SECRET = origJwt;
    });

    it('works with a valid 64-char hex VAULT_KEY', async () => {
      const origJwt = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      process.env.VAULT_KEY = crypto.randomBytes(32).toString('hex');

      const result = await storeOAuthToken('ws-1', 'github', { token: 'test_token' });
      expect(result.provider).toBe('github');

      // Verify round-trip decryption works
      const retrieved = await getOAuthToken('ws-1', 'github');
      expect(retrieved!.token).toBe('test_token');

      delete process.env.VAULT_KEY;
      process.env.JWT_SECRET = origJwt;
    });
  });

  describe('markTokenValidated', () => {
    it('calls execute with correct params', async () => {
      await storeOAuthToken('ws-1', 'github', { token: 'tok' });
      await markTokenValidated('ws-1', 'github');

      expect(db.execute).toHaveBeenCalledWith(
        expect.stringContaining('last_validated_at'),
        ['ws-1', 'github', 'oauth_access'],
      );
    });
  });

  describe('encryption round-trip', () => {
    it('different tokens produce different ciphertext', async () => {
      await storeOAuthToken('ws-1', 'github', { token: 'token_a' });
      await storeOAuthToken('ws-2', 'github', { token: 'token_b' });

      const calls = db.queryOne.mock.calls;
      const encrypted1 = calls[0][1][4];
      const encrypted2 = calls[1][1][4];
      expect(encrypted1).not.toBe(encrypted2);
    });

    it('same token encrypted twice produces different ciphertext (random IV)', async () => {
      await storeOAuthToken('ws-1', 'github', { token: 'same_token' });
      // Store with different token_type to avoid upsert
      await storeOAuthToken('ws-1', 'github', {
        token: 'same_token',
        tokenType: 'oauth_refresh',
      });

      const calls = db.queryOne.mock.calls;
      const encrypted1 = calls[0][1][4];
      const encrypted2 = calls[1][1][4];
      expect(encrypted1).not.toBe(encrypted2);
    });
  });
});
