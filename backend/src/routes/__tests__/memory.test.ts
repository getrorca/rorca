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
import { execute, queryOne } from '../../db/index';

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
  test('appends a valid memory entry, preserves provenance, and emits a graph WAL event', async () => {
    const res = await request(app)
      .post('/api/memory')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        category: 'Architecture',
        title: 'Use SQLite WAL mode',
        rule: 'Always enable WAL mode for concurrent reads.',
        context: 'Prevents read locks during writes.',
        source: 'US-123',
        sourceSpecId: 'spec-memory-test',
        sourceRunId: 42,
        relatedFiles: ['src/db/sqlite.ts', 'src/db/sqlite.ts', 'docs/sqlite.md'],
      });

    expect(res.status).toBe(201);
    expect(res.body.entry).toBeDefined();
    expect(res.body.entry.title).toBe('Use SQLite WAL mode');

    // MEMORY.md is written to .rorca/memory/MEMORY.md by default
    const memoryPath = path.join(tmpDir, '.rorca', 'memory', 'MEMORY.md');
    expect(fs.existsSync(memoryPath)).toBe(true);
    const content = fs.readFileSync(memoryPath, 'utf-8');
    expect(content).toContain('Use SQLite WAL mode');

    // The memory row should retain explicit provenance needed for graph rebuilds.
    const memoryRow = await queryOne<{
      source_type: string;
      source: string | null;
      source_story_id: string | null;
      source_spec_id: string | null;
      source_run_id: number | string | null;
      related_files: string[];
    }>(
      `SELECT source_type, source, source_story_id, source_spec_id, source_run_id, related_files
         FROM memories WHERE workspace_id = $1 AND content LIKE $2 ORDER BY id DESC LIMIT 1`,
      [workspaceId, '%Use SQLite WAL mode%'],
    );
    expect(memoryRow).toBeDefined();
    expect(memoryRow!.source_type).toBe('synthesis');
    expect(memoryRow!.source).toBe('US-123');
    expect(memoryRow!.source_story_id).toBe('US-123');
    expect(memoryRow!.source_spec_id).toBe('spec-memory-test');
    expect(Number(memoryRow!.source_run_id)).toBe(42);
    expect(memoryRow!.related_files).toEqual(['src/db/sqlite.ts', 'docs/sqlite.md']);

    const walRow = await queryOne<{ event_type: string; story_id: string | null; spec_id: string | null; payload: string | Record<string, unknown> }>(
      `SELECT event_type, story_id, spec_id, payload FROM wal_events WHERE workspace_id = $1 AND event_type = 'memory_created' ORDER BY id DESC LIMIT 1`,
      [workspaceId],
    );
    expect(walRow).toBeDefined();
    expect(walRow!.event_type).toBe('memory_created');
    expect(walRow!.story_id).toBe('US-123');
    expect(walRow!.spec_id).toBe('spec-memory-test');
    const walPayload = typeof walRow!.payload === 'string' ? JSON.parse(walRow!.payload) : walRow!.payload;
    expect(walPayload).toMatchObject({
      relatedFiles: ['src/db/sqlite.ts', 'docs/sqlite.md'],
    });
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
