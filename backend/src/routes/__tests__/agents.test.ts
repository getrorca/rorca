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
let workspaceId: string;

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-agents-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);

  workspaceId = 'ws-agents-test-' + Date.now();
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [workspaceId,
    'Agents Test Workspace',
    tmpDir,]);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── GET /api/agents ───────────────────────────────────────────────────────

describe('GET /api/agents', () => {
  test('returns exists=false when AGENTS.md does not exist', async () => {
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(res.body.roles).toBeDefined();
  });

  test('returns exists=true and raw content when AGENTS.md exists', async () => {
    const agentsContent = '# AGENTS.md\n\n## Owner: frontend\n- src/ — frontend\n';
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), agentsContent, 'utf-8');

    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(true);
    expect(res.body.raw).toContain('AGENTS.md');
    expect(res.body.path).toBeDefined();
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 when workspace does not exist', async () => {
    const res = await request(app)
      .get('/api/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: 'nonexistent-workspace' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Workspace not found/i);
  });
});

// ─── PUT /api/agents ───────────────────────────────────────────────────────

describe('PUT /api/agents', () => {
  test('writes raw content to AGENTS.md', async () => {
    const rawContent = '# AGENTS.md\n\nCustom raw content.\n';

    const res = await request(app)
      .put('/api/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId, raw: rawContent });

    expect(res.status).toBe(200);
    expect(res.body.raw).toBe(rawContent);

    const written = fs.readFileSync(path.join(tmpDir, 'AGENTS.md'), 'utf-8');
    expect(written).toBe(rawContent);
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .put('/api/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ raw: '# test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 when workspace does not exist', async () => {
    const res = await request(app)
      .put('/api/agents')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'nonexistent-workspace', raw: '# test' });

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/agents/violations ───────────────────────────────────────────

describe('GET /api/agents/violations', () => {
  test('returns empty array when no violations exist', async () => {
    const res = await request(app)
      .get('/api/agents/violations')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.total).toBe(0);
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/agents/violations')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});
