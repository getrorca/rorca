/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import '../../lib/async-handler';

const mockQueryOne = jest.fn();
const mockGraphOverview = jest.fn();
const mockGraphNeighborhood = jest.fn();

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  query: jest.fn(),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../../lib/memory-ledger', () => ({
  readMemory: jest.fn(),
  append: jest.fn(),
  query: jest.fn(),
  recent: jest.fn(),
  deleteEntry: jest.fn(),
  updateEntry: jest.fn(),
  logRejected: jest.fn(),
  readRejected: jest.fn(),
  getContextSnippet: jest.fn(),
  rotateMemory: jest.fn(),
  countArchiveEntries: jest.fn(),
  MEMORY_CATEGORIES: ['Architecture', 'Convention', 'Bug Fix', 'Decision', 'Pattern', 'Gotcha'],
}));

jest.mock('../../lib/wal-feedback', () => ({ analyzeRunEvents: jest.fn() }));
jest.mock('../../lib/sse-hub', () => ({ broadcastAll: jest.fn() }));
jest.mock('../../lib/context-cache', () => ({ invalidateMemory: jest.fn() }));
jest.mock('../../lib/memory-dedup', () => ({ deduplicateMemory: jest.fn() }));
jest.mock('../../lib/embedding-pipeline', () => ({ embedText: jest.fn(), prepareText: jest.fn((_: string, value: string) => value) }));
jest.mock('../../lib/memory-provenance', () => ({ resolveStoryMemoryProvenance: jest.fn().mockResolvedValue({ sourceSpecId: null, relatedFiles: [] }) }));
jest.mock('../../lib/memory-graph', () => ({
  getMemoryGraphOverview: (...args: unknown[]) => mockGraphOverview(...args),
  getMemoryGraphNeighborhood: (...args: unknown[]) => mockGraphNeighborhood(...args),
}));

import memoryRouter from '../memory';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/memory', memoryRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? 'error' });
  });
  return app;
}

describe('memory graph routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('SELECT path FROM workspaces')) {
        return params[0] === 'ws-1' ? { path: '/tmp/ws-1' } : undefined;
      }
      if (sql.includes('SELECT id FROM memories')) {
        return params[0] === 7 && params[1] === 'ws-1' ? { id: 7 } : undefined;
      }
      return undefined;
    });
    mockGraphOverview.mockResolvedValue({
      available: false,
      nodes: [],
      edges: [],
      scope: { workspaceId: 'ws-1', view: 'overview', memoryId: null },
      summary: {
        nodeCount: 0,
        edgeCount: 0,
        countsByType: { Memory: 0, Story: 0, Spec: 0, File: 0 },
        countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 0, CONFLICTS_WITH: 0 },
        caps: { memories: 12, stories: 18, files: 24, specs: 8, edges: 72, dependencies: 8 },
        truncated: { nodes: false, edges: false },
      },
      selection: { selectedMemoryId: null, suggestedMemoryIds: [], relatedStoryIds: [], relatedSpecIds: [], relatedFilePaths: [] },
      error: 'Apache AGE extension not available',
      code: 'AGE_NOT_AVAILABLE',
      mode: 'lite',
      hint: 'Run `rorca db start` to enable graph memory (requires Docker)',
    });
    mockGraphNeighborhood.mockResolvedValue({
      available: true,
      nodes: [],
      edges: [],
      scope: { workspaceId: 'ws-1', view: 'neighborhood', memoryId: '7' },
      summary: {
        nodeCount: 0,
        edgeCount: 0,
        countsByType: { Memory: 0, Story: 0, Spec: 0, File: 0 },
        countsByEdgeType: { ABOUT: 0, LEARNED_FROM: 0, FROM_SPEC: 0, TOUCHES: 0, BELONGS_TO: 0, DEPENDS_ON: 0, SUPERSEDES: 0, CONFLICTS_WITH: 0 },
        caps: { memories: 1, stories: 10, files: 12, specs: 6, edges: 40, dependencies: 10 },
        truncated: { nodes: false, edges: false },
      },
      selection: { selectedMemoryId: '7', suggestedMemoryIds: ['7'], relatedStoryIds: [], relatedSpecIds: [], relatedFilePaths: [] },
    });
  });

  it('validates overview workspaceId and returns graceful fallback payloads', async () => {
    const app = buildApp();

    const bad = await request(app).get('/api/memory/graph/overview');
    expect(bad.status).toBe(400);

    const ok = await request(app).get('/api/memory/graph/overview').query({ workspaceId: 'ws-1' });
    expect(ok.status).toBe(200);
    expect(ok.body.available).toBe(false);
    expect(mockGraphOverview).toHaveBeenCalledWith('ws-1');
  });

  it('validates neighborhood memoryId at the route boundary', async () => {
    const app = buildApp();

    const bad = await request(app)
      .get('/api/memory/graph/neighborhood')
      .query({ workspaceId: 'ws-1', memoryId: 'abc' });

    expect(bad.status).toBe(400);
    expect(mockGraphNeighborhood).not.toHaveBeenCalled();
  });

  it('requires the memory to belong to the workspace before querying its neighborhood', async () => {
    const app = buildApp();

    const missing = await request(app)
      .get('/api/memory/graph/neighborhood')
      .query({ workspaceId: 'ws-1', memoryId: '999' });
    expect(missing.status).toBe(404);

    const ok = await request(app)
      .get('/api/memory/graph/neighborhood')
      .query({ workspaceId: 'ws-1', memoryId: '7' });
    expect(ok.status).toBe(200);
    expect(ok.body.available).toBe(true);
    expect(mockGraphNeighborhood).toHaveBeenCalledWith('ws-1', '7');
  });
});
