/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const query = jest.fn();
const queryOne = jest.fn();
const canonicalQuery = jest.fn();
const canonicalTransaction = jest.fn(async (action: (client: { query: typeof canonicalQuery }) => Promise<unknown>) => (
  action({ query: canonicalQuery })
));

jest.mock('../../db/index', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
  canonicalTransaction: (action: (client: { query: typeof canonicalQuery }) => Promise<unknown>) => canonicalTransaction(action),
}));

jest.mock('../../lib/auth-utils', () => ({
  encryptToken: (value: string) => `encrypted:${value}`,
  decryptToken: (value: string) => value.replace(/^encrypted:/, ''),
}));

import vaultRouter, { getVaultKey } from '../vault';
import { errorHandler } from '../../lib/error-handler';

const vaultRow = {
  id: 'key-1',
  user_id: 'user-1',
  workspace_id: 'workspace-1',
  provider: 'openrouter',
  encrypted_key: 'encrypted:sk-test',
  label: 'Primary',
  spend_total_usd: 0,
  last_used_at: null,
  base_url: null,
  created_at: '2026-08-17T00:00:00.000Z',
};

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = {
      id: 'user-1',
      email: 'user@example.com',
      supabaseId: '00000000-0000-0000-0000-000000000001',
      role: 'admin',
      plan: 'pro',
    };
    next();
  });
  instance.use('/api/vault', vaultRouter);
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('runtime read uses the canonical workspace-scoped vault relation and returns masked settings', async () => {
  query.mockResolvedValue([vaultRow]);

  const response = await request(app()).get('/api/vault/keys?workspaceId=workspace-1');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    keys: [{
      id: 'key-1',
      provider: 'openrouter',
      label: 'Primary',
      masked_key: '****test',
      base_url: null,
      spend_total_usd: 0,
      last_used_at: null,
      created_at: '2026-08-17T00:00:00.000Z',
    }],
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining('FROM rorca.api_key_vault WHERE user_id = $1 AND workspace_id = $2'),
    ['user-1', 'workspace-1'],
  );
  expect(canonicalTransaction).not.toHaveBeenCalled();
});

test('vault insertion checks the workspace at runtime and mutates only through the canonical writer', async () => {
  queryOne.mockResolvedValue({ id: 'workspace-1' });
  canonicalQuery.mockResolvedValue({ rows: [vaultRow], rowCount: 1 });

  const response = await request(app()).post('/api/vault/keys').send({
    workspaceId: 'workspace-1',
    provider: 'openrouter',
    key: 'sk-test',
    label: 'Primary',
  });

  expect(response.status).toBe(201);
  expect(queryOne).toHaveBeenCalledWith(
    'SELECT id FROM rorca.workspaces WHERE id = $1',
    ['workspace-1'],
  );
  expect(canonicalTransaction).toHaveBeenCalledTimes(1);
  expect(canonicalQuery).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO rorca.api_key_vault'),
    expect.arrayContaining(['user-1', 'workspace-1', 'openrouter', 'encrypted:sk-test']),
  );
});

test('default-provider upsert and vault usage timestamp stay on the canonical writer', async () => {
  canonicalQuery.mockResolvedValue({ rows: [], rowCount: 1 });

  const updateResponse = await request(app()).put('/api/vault/keys/default-provider').send({
    workspaceId: 'workspace-1',
    provider: 'openrouter',
  });

  expect(updateResponse.status).toBe(200);
  expect(canonicalQuery).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO rorca.provider_defaults'),
    expect.arrayContaining(['user-1', 'workspace-1', 'openrouter']),
  );

  queryOne.mockResolvedValue(vaultRow);
  await expect(getVaultKey('user-1', 'openrouter')).resolves.toEqual({ key: 'sk-test', baseUrl: null });
  expect(queryOne).toHaveBeenCalledWith(
    expect.stringContaining('FROM rorca.api_key_vault'),
    ['user-1', 'openrouter'],
  );
  expect(canonicalQuery).toHaveBeenCalledWith(
    'UPDATE rorca.api_key_vault SET last_used_at = NOW() WHERE id = $1',
    ['key-1'],
  );
  expect(canonicalTransaction).toHaveBeenCalledTimes(2);
});

test('vault deletion is scoped by user and workspace inside the canonical-writer transaction', async () => {
  canonicalQuery.mockResolvedValue({ rows: [], rowCount: 1 });

  const response = await request(app()).delete('/api/vault/keys/key-1?workspaceId=workspace-1');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ ok: true });
  expect(canonicalQuery).toHaveBeenCalledWith(
    'DELETE FROM rorca.api_key_vault WHERE id = $1 AND user_id = $2 AND workspace_id = $3',
    ['key-1', 'user-1', 'workspace-1'],
  );
  expect(canonicalTransaction).toHaveBeenCalledTimes(1);
});

