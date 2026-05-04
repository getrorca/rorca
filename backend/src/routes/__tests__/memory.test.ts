/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-memory-test-'));
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
}, 60_000);

beforeEach(async () => {
  authToken = await getAuthToken(app);

  workspaceId = 'ws-memory-test-' + Date.now();
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [workspaceId, 'Memory Test Workspace', tmpDir],
  );
});

afterAll(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

// ─── GET /api/memory ──────────────────────────────────────────────────────

describe('GET /api/memory', () => {
  test('returns empty items when no MEMORY.md exists', async () => {
    const res = await request(app)
      .get('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.items).toBeDefined();
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.categories).toBeDefined();
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/memory')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await request(app)
      .get('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId: 'nonexistent' });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/memory ─────────────────────────────────────────────────────

describe('POST /api/memory', () => {
  test('appends a valid memory entry and writes MEMORY.md', async () => {
    const res = await request(app)
      .post('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        category: 'Architecture',
        title: 'Use SQLite WAL mode',
        rule: 'Always enable WAL mode for concurrent reads.',
        context: 'Prevents read locks during writes.',
        source: 'manual',
      });

    expect(res.status).toBe(201);
    expect(res.body.entry).toBeDefined();
    expect(res.body.entry.title).toBe('Use SQLite WAL mode');

    // MEMORY.md is written to .rorca/memory/MEMORY.md by default
    const memoryPath = path.join(tmpDir, '.rorca', 'memory', 'MEMORY.md');
    expect(fs.existsSync(memoryPath)).toBe(true);
    const content = fs.readFileSync(memoryPath, 'utf-8');
    expect(content).toContain('Use SQLite WAL mode');
  });

  test('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .post('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        category: 'Architecture',
        // missing title and rule
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('returns 400 for invalid category', async () => {
    const res = await request(app)
      .post('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        category: 'NotACategory',
        title: 'Test',
        rule: 'Test rule.',
      });

    expect(res.status).toBe(400);
  });

  test('returns 404 for unknown workspace', async () => {
    const res = await request(app)
      .post('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'nonexistent',
        category: 'Convention',
        title: 'Test',
        rule: 'Test rule.',
      });

    expect(res.status).toBe(404);
  });
});

// ─── GET /api/memory/categories ───────────────────────────────────────────

describe('GET /api/memory/categories', () => {
  test('returns the list of valid categories', async () => {
    const res = await request(app)
      .get('/api/memory/categories')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.categories).toBeDefined();
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories).toContain('Architecture');
    expect(res.body.categories).toContain('Convention');
  });
});

// ─── GET /api/memory/context ──────────────────────────────────────────────

describe('GET /api/memory/context', () => {
  test('returns context snippet for workspace', async () => {
    // First add an entry so there is content
    await request(app)
      .post('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        category: 'Pattern',
        title: 'Test pattern',
        rule: 'Use this pattern.',
        source: 'test',
      });

    const res = await request(app)
      .get('/api/memory/context')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.snippet).toBeDefined();
  });

  test('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/memory/context')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});
