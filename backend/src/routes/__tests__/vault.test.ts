/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { execute, queryOne, closePool } from '../../db/index';

jest.mock('@supabase/supabase-js', () => {
  class VaultQueryBuilder {
    private filters: Record<string, unknown> = {};
    private deleteMode = false;
    private orderBy: string | null = null;
    private orderAscending = true;
    private limitCount: number | null = null;

    constructor(private readonly table: string, private readonly selected: string | null = null) {}

    eq(column: string, value: unknown) {
      this.filters[column] = value;
      return this;
    }

    order(column: string, opts?: { ascending?: boolean }) {
      this.orderBy = column;
      this.orderAscending = opts?.ascending !== false;
      return this;
    }

    delete() {
      this.deleteMode = true;
      return this;
    }

    async limit(count: number) {
      this.limitCount = count;
      return this.execute();
    }

    then(resolve: (value: any) => void, reject?: (reason?: any) => void) {
      return this.execute().then(resolve, reject);
    }

    private async execute() {
      const { query, execute } = require('../../db/index');
      if (this.table !== 'api_key_vault') {
        throw new Error(`Unsupported test table: ${this.table}`);
      }

      const where: string[] = [];
      const params: unknown[] = [];
      for (const [column, value] of Object.entries(this.filters)) {
        params.push(value);
        where.push(`${column} = $${params.length}`);
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

      if (this.deleteMode) {
        await execute(`DELETE FROM api_key_vault${whereSql}`, params);
        return { error: null };
      }

      let sql = `SELECT ${this.selected ?? '*'} FROM api_key_vault${whereSql}`;
      if (this.orderBy) {
        sql += ` ORDER BY ${this.orderBy} ${this.orderAscending ? 'ASC' : 'DESC'}`;
      }
      if (this.limitCount !== null) {
        sql += ` LIMIT ${this.limitCount}`;
      }
      const data = await query(sql, params);
      return { data, error: null };
    }
  }

  return {
    createClient: jest.fn(() => ({
      from: (table: string) => ({
        insert: async (payload: any) => {
          const { execute } = require('../../db/index');
          await execute(
            `INSERT INTO api_key_vault (id, workspace_id, user_id, provider, encrypted_key, label, base_url)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [payload.id, payload.workspace_id, payload.user_id, payload.provider, payload.encrypted_key, payload.label, payload.base_url]
          );
          return { error: null };
        },
        select: (columns: string) => new VaultQueryBuilder(table, columns),
        delete: () => new VaultQueryBuilder(table).delete(),
      }),
    })),
  };
});

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn().mockResolvedValue({ text: 'ok', usage: {} }),
}));

const vaultRouter = require('../vault').default;

let app: express.Express;
let workspaceId: string;
let userId: string;
let userAuthId: string;

beforeEach(async () => {
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_ANON_KEY = 'test-anon-key';
  workspaceId = `vault-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  userId = `user-${Date.now()}`;
  userAuthId = crypto.randomUUID();

  await execute(
    `INSERT INTO users (id, email, display_name, auth_id, role, plan)
     VALUES ($1, $2, 'Vault Tester', $3, 'user', 'free')`,
    [userId, 'vault-test@example.com', userAuthId]
  );
  await execute(
    `INSERT INTO workspaces (id, label, path, domains)
     VALUES ($1, 'Vault Workspace', $2, '[]')`,
    [workspaceId, `/tmp/${workspaceId}`]
  );
  await execute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2, 'owner')`,
    [workspaceId, userAuthId]
  );

  app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      id: userId,
      email: 'vault-test@example.com',
      supabaseId: userAuthId,
      role: 'user',
      plan: 'free',
    };
    next();
  });
  app.use('/api/vault/keys', vaultRouter);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode || err.status || 500).json({ error: err.message || 'error' });
  });
});

afterEach(async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  await execute('DELETE FROM api_key_vault');
  await execute('DELETE FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await execute('DELETE FROM users WHERE id = $1', [userId]);
});

afterAll(async () => {
  await closePool();
});

describe('POST /api/vault/keys', () => {
  test('stores a key and returns masked version', async () => {
    const res = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, provider: 'anthropic', key: 'sk-ant-api03-test1234', label: 'My Anthropic Key' });

    expect(res.status).toBe(201);
    expect(res.body.provider).toBe('anthropic');
    expect(res.body.label).toBe('My Anthropic Key');
    expect(res.body.masked_key).toBe('****1234');
  });

  test('rejects missing provider', async () => {
    const res = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, key: 'sk-test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider/i);
  });

  test('plaintext key is never stored in DB', async () => {
    const plainKey = 'sk-ant-api03-plaintext-check';
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, provider: 'anthropic', key: plainKey, label: 'Check' });

    const row = await queryOne(`SELECT encrypted_key FROM api_key_vault LIMIT 1`) as { encrypted_key: string };
    expect(row.encrypted_key).not.toBe(plainKey);
    expect(row.encrypted_key).toContain(':');
  });
});

describe('GET /api/vault/keys', () => {
  test('lists stored keys with masked values', async () => {
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, provider: 'anthropic', key: 'sk-ant-key-abcd', label: 'Key 1' });
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, provider: 'openrouter', key: 'sk-or-key-wxyz', label: 'Key 2' });

    const res = await request(app)
      .get(`/api/vault/keys?workspaceId=${encodeURIComponent(workspaceId)}`)
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(2);
    expect(res.body.keys.map((k: any) => k.provider).sort()).toEqual(['anthropic', 'openrouter']);
  });
});

describe('DELETE /api/vault/keys/:id', () => {
  test('deletes a key and returns spend total', async () => {
    const createRes = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, provider: 'anthropic', key: 'sk-ant-delete-me', label: 'Temp' });

    const res = await request(app)
      .delete(`/api/vault/keys/${createRes.body.id}?workspaceId=${encodeURIComponent(workspaceId)}`)
      .set('Authorization', 'Bearer test-token');

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

describe('getVaultKey', () => {
  test('returns decrypted key for matching provider', async () => {
    const plainKey = 'sk-ant-api03-vault-test-key';
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', 'Bearer test-token')
      .send({ workspaceId, provider: 'anthropic', key: plainKey, label: 'SDK' });

    const { getVaultKey } = require('../vault');
    const result = await getVaultKey(userId, 'anthropic');
    expect(result).not.toBeNull();
    expect(result.key).toBe(plainKey);
    expect(result.baseUrl).toBeNull();
  });
});
