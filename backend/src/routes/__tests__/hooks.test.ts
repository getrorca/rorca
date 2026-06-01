/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hooks-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Seed a workspace and clean up any leftover hooks from previous test
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-hooks', 'Hooks WS', $1) ON CONFLICT (id) DO NOTHING`, [tmpDir]);
  await execute(`DELETE FROM pipeline_hooks WHERE workspace_id = 'ws-hooks'`);

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── POST /api/pipeline/hooks ─────────────────────────────────────────────────

describe('POST /api/pipeline/hooks', () => {
  test('creates a hook and returns 201', async () => {
    const res = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-hooks',
        hookType: 'pre_run',
        command: 'echo "hello"',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.workspace_id).toBe('ws-hooks');
    expect(res.body.hook_type).toBe('pre_run');
    expect(res.body.command).toBe('echo "hello"');
    expect(res.body.enabled).toBe(true);
  });

  test('creates a disabled hook', async () => {
    const res = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-hooks',
        hookType: 'post_run',
        command: 'echo "done"',
        enabled: false,
      });

    expect(res.status).toBe(201);
    expect(res.body.enabled).toBe(false);
  });

  test('rejects invalid hook type', async () => {
    const res = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-hooks',
        hookType: 'invalid_type',
        command: 'echo "bad"',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid hookType');
  });

  test('rejects missing required fields', async () => {
    const res = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing required fields');
  });
});

// ─── GET /api/pipeline/hooks ──────────────────────────────────────────────────

describe('GET /api/pipeline/hooks', () => {
  test('returns empty array when no hooks exist', async () => {
    const res = await request(app)
      .get('/api/pipeline/hooks?workspaceId=ws-hooks')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  test('lists hooks for a workspace', async () => {
    await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks', hookType: 'pre_run', command: 'echo pre' });
    await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks', hookType: 'post_run', command: 'echo post' });

    const res = await request(app)
      .get('/api/pipeline/hooks?workspaceId=ws-hooks')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  test('requires workspaceId query param', async () => {
    const res = await request(app)
      .get('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('workspaceId');
  });
});

// ─── PUT /api/pipeline/hooks/:id ──────────────────────────────────────────────

describe('PUT /api/pipeline/hooks/:id', () => {
  test('updates hook command', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks', hookType: 'pre_run', command: 'echo old' });

    const res = await request(app)
      .put(`/api/pipeline/hooks/${createRes.body.id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ command: 'echo new' });

    expect(res.status).toBe(200);
    expect(res.body.command).toBe('echo new');
    expect(res.body.hook_type).toBe('pre_run');
  });

  test('updates hook enabled status', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks', hookType: 'pre_run', command: 'echo x' });

    const res = await request(app)
      .put(`/api/pipeline/hooks/${createRes.body.id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  test('returns 404 for nonexistent hook', async () => {
    const res = await request(app)
      .put('/api/pipeline/hooks/9999')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ command: 'echo x' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Hook not found');
  });

  test('rejects invalid hook type on update', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks', hookType: 'pre_run', command: 'echo x' });

    const res = await request(app)
      .put(`/api/pipeline/hooks/${createRes.body.id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ hookType: 'bad_type' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid hookType');
  });
});

// ─── DELETE /api/pipeline/hooks/:id ───────────────────────────────────────────

describe('DELETE /api/pipeline/hooks/:id', () => {
  test('deletes hook and returns 204', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/hooks')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-hooks', hookType: 'pre_run', command: 'echo x' });

    const deleteRes = await request(app)
      .delete(`/api/pipeline/hooks/${createRes.body.id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const listRes = await request(app)
      .get('/api/pipeline/hooks?workspaceId=ws-hooks')
      .set('Authorization', `Bearer ${authToken}`);

    expect(listRes.body.items).toHaveLength(0);
  });

  test('returns 404 for nonexistent hook', async () => {
    const res = await request(app)
      .delete('/api/pipeline/hooks/9999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Hook not found');
  });
});
