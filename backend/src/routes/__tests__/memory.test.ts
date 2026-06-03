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

async function insertMemory(overrides: Partial<{
  workspaceId: string;
  category: string;
  content: string;
  sourceStoryId: string | null;
}> = {}): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO memories (workspace_id, category, content, source_story_id, confidence, related_files, source_type, source)
     VALUES ($1, $2, $3, $4, 'high', '[]'::jsonb, 'manual', 'test-suite')
     RETURNING id`,
    [
      overrides.workspaceId ?? workspaceId,
      overrides.category ?? 'Decision',
      overrides.content ?? `Memory ${Date.now()}`,
      overrides.sourceStoryId ?? null,
    ],
  );

  return Number(row!.id);
}

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

// ─── GET /api/memory/graph/* ─────────────────────────────────────────────

describe('GET /api/memory/graph endpoints', () => {
  test('overview returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/memory/graph/overview')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  test('neighborhood validates memoryId at the route boundary', async () => {
    const res = await request(app)
      .get('/api/memory/graph/neighborhood')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId, memoryId: 'abc' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/memoryId/i);
  });

  test('returns graceful available=false overview payload when graph helper cannot query AGE', async () => {
    const memoryGraph = require('../../lib/memory-graph');
    const spy = jest.spyOn(memoryGraph, 'getMemoryGraphOverview').mockResolvedValue({
      available: false,
      scope: { workspaceId, view: 'overview', memoryId: null },
      nodes: [],
      edges: [],
      summary: {
        nodeCount: 0,
        edgeCount: 0,
        countsByType: { Memory: 0, Story: 0, Spec: 0, File: 0 },
        countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 0, CONFLICTS_WITH: 0 },
        caps: { memories: 12, stories: 18, files: 24, specs: 8, edges: 72, dependencies: 8 },
        truncated: { nodes: false, edges: false },
      },
      selection: {
        selectedMemoryId: null,
        suggestedMemoryIds: [],
        relatedStoryIds: [],
        relatedSpecIds: [],
        relatedFilePaths: [],
      },
      error: 'Apache AGE extension not available',
      code: 'AGE_NOT_AVAILABLE',
      mode: 'lite',
      hint: 'Run `rorca db start` to enable graph memory (requires Docker)',
    });

    const res = await request(app)
      .get('/api/memory/graph/overview')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId });

    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.code).toBe('AGE_NOT_AVAILABLE');
    spy.mockRestore();
  });
});

// ─── /api/memory/relations ───────────────────────────────────────────────

describe('memory ontology relation routes', () => {
  test('creates a canonical CONFLICTS_WITH relation, suppresses duplicates, and exposes semantics', async () => {
    const memoryA = await insertMemory({ content: 'A: Prefer local-first auth defaults.' });
    const memoryB = await insertMemory({ content: 'B: External auth redirect is required.' });

    const first = await request(app)
      .post('/api/memory/relations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        sourceMemoryId: memoryB,
        targetMemoryId: memoryA,
        relationType: 'CONFLICTS_WITH',
        note: 'Conflicting deployment assumptions.',
      });

    expect(first.status).toBe(201);
    expect(first.body.relation.relationType).toBe('CONFLICTS_WITH');
    expect(first.body.relation.sourceMemoryId).toBe(Math.min(memoryA, memoryB));
    expect(first.body.relation.targetMemoryId).toBe(Math.max(memoryA, memoryB));
    expect(first.body.relation.canonicalKey).toContain(`memory-relation:${workspaceId}::CONFLICTS_WITH::${Math.min(memoryA, memoryB)}::${Math.max(memoryA, memoryB)}`);
    expect(first.body.semantics.summary).toMatch(/cannot both be applied/i);

    const second = await request(app)
      .post('/api/memory/relations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        sourceMemoryId: memoryA,
        targetMemoryId: memoryB,
        relationType: 'CONFLICTS_WITH',
      });

    expect(second.status).toBe(201);
    expect(second.body.relation.id).toBe(first.body.relation.id);

    const countRow = await queryOne<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM memory_relations WHERE workspace_id = $1 AND relation_type = 'CONFLICTS_WITH'`,
      [workspaceId],
    );
    expect(Number(countRow!.cnt)).toBe(1);

    const listRes = await request(app)
      .get('/api/memory/relations')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId, memoryId: memoryA });

    expect(listRes.status).toBe(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].semantics.summary).toMatch(/cannot both be applied/i);
  });

  test('tracks deleted, restored, and superseded relation lifecycle states', async () => {
    const newerMemory = await insertMemory({ content: 'New: Use scoped relation keys for replay safety.' });
    const olderMemory = await insertMemory({ content: 'Old: Use raw relation labels without canonical keys.' });

    const created = await request(app)
      .post('/api/memory/relations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        sourceMemoryId: newerMemory,
        targetMemoryId: olderMemory,
        relationType: 'SUPERSEDES',
      });

    expect(created.status).toBe(201);
    const relationId = created.body.relation.id as number;

    const deleted = await request(app)
      .patch(`/api/memory/relations/${relationId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId, status: 'deleted' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.relation.status).toBe('deleted');
    expect(deleted.body.relation.deletedAt).toBeTruthy();

    const restored = await request(app)
      .patch(`/api/memory/relations/${relationId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId, status: 'active' });
    expect(restored.status).toBe(200);
    expect(restored.body.relation.status).toBe('active');
    expect(restored.body.relation.restoredAt).toBeTruthy();

    const superseded = await request(app)
      .patch(`/api/memory/relations/${relationId}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId, status: 'superseded' });
    expect(superseded.status).toBe(200);
    expect(superseded.body.relation.status).toBe('superseded');
    expect(superseded.body.relation.supersededAt).toBeTruthy();

    const inactiveList = await request(app)
      .get('/api/memory/relations')
      .set('Authorization', `Bearer ${authToken}`)
      .query({ workspaceId, includeInactive: true });
    expect(inactiveList.status).toBe(200);
    expect(inactiveList.body.items.some((item: { id: number; status: string }) => item.id === relationId && item.status === 'superseded')).toBe(true);
  });

  test('rejects cross-workspace memory relations', async () => {
    const localMemory = await insertMemory({ content: 'Local memory.' });
    const foreignWorkspaceId = `ws-memory-foreign-${Date.now()}`;
    await execute(
      `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [foreignWorkspaceId, 'Foreign Memory Workspace', tmpDir],
    );
    const foreignMemory = await insertMemory({
      workspaceId: foreignWorkspaceId,
      content: 'Foreign memory.',
    });

    const res = await request(app)
      .post('/api/memory/relations')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId,
        sourceMemoryId: localMemory,
        targetMemoryId: foreignMemory,
        relationType: 'SUPERSEDES',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/single workspace/i);
  });
});
