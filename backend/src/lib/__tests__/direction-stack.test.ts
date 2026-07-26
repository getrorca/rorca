/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { synthesize, synthesizeDirectionStack } from '../direction-stack';

// ─── Mock context-cache to avoid in-memory cache state between tests ─────────

const mockGetDirectionLayers = jest.fn();
const mockGetRecentMemory = jest.fn();
const mockGetInstalledSkills = jest.fn();
const mockCacheStats = jest.fn().mockReturnValue({ hits: 0, misses: 0, hitRate: 0, entries: 0, memoryBytes: 0 });

jest.mock('../context-cache', () => ({
  getDirectionLayers: (...args: unknown[]) => mockGetDirectionLayers(...args),
  getRecentMemory: (...args: unknown[]) => mockGetRecentMemory(...args),
  getInstalledSkills: (...args: unknown[]) => mockGetInstalledSkills(...args),
  cacheStats: () => mockCacheStats(),
}));

// ─── Mock DB for pinned memories query (memory-router.ts queries DB directly) ─

const mockDbQuery = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  query: (...args: unknown[]) => mockDbQuery(...args),
}));

// ─── Mock hybridSearch ────────────────────────────────────────────────────────

const mockHybridSearch = jest.fn();
jest.mock('../search', () => ({
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Preserve canonical graph identity helpers used by retrieval while replacing
// only external graph reads that are outside this unit's scope.
jest.mock('../knowledge-graph', () => ({
  ...jest.requireActual('../knowledge-graph'),
  queryRelated: jest.fn().mockResolvedValue([]),
  queryImpact: jest.fn().mockResolvedValue({ stories: [], conventions: [] }),
  graphStats: jest.fn().mockResolvedValue({ available: false, vertexCount: 0 }),
}));

// Mock graph-context (not needed for these tests)
jest.mock('../graph-context', () => ({
  getGraphContext: jest.fn().mockResolvedValue({
    fileHistory: [],
    relatedMemories: [],
    relatedConventions: [],
  }),
  formatGraphContext: jest.fn().mockReturnValue(''),
}));

// ─── Sync synthesize() tests (backward compat) ──────────────────────────────

describe('synthesize', () => {
  it('includes all section headers when all layers provided', () => {
    const result = synthesize({
      l1: 'global standards content',
      l2: 'domain profile content',
      l3: 'project context content',
      specBrief: 'spec brief content',
      storyAnnotations: 'story annotations content',
    });

    expect(result).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result).toContain('=== DOMAIN PROFILE (L2) ===');
    expect(result).toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
    expect(result).toContain('=== STORY ANNOTATIONS (L5) ===');
  });

  it('omits L2 section when l2 is missing', () => {
    const result = synthesize({
      l1: 'global standards',
      l3: 'project brief',
      specBrief: 'the spec',
    });

    expect(result).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result).not.toContain('=== DOMAIN PROFILE (L2) ===');
    expect(result).toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
  });

  it('outputs only L4 when brief only (no l1/l2/l3)', () => {
    const result = synthesize({ specBrief: 'just the brief' });

    expect(result).not.toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result).not.toContain('=== DOMAIN PROFILE (L2) ===');
    expect(result).not.toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
    expect(result).toContain('just the brief');
    expect(result).not.toContain('=== STORY ANNOTATIONS (L5) ===');
  });

  it('skips layers with empty/whitespace strings', () => {
    const result = synthesize({
      l1: '   ',
      l2: '',
      l3: undefined,
      specBrief: 'content',
    });

    expect(result).not.toContain('L1');
    expect(result).not.toContain('L2');
    expect(result).not.toContain('L3');
    expect(result).toContain('=== SPEC BRIEF (L4) ===');
  });

  it('includes DATABASE SCHEMA section when schemaSnapshot provided', () => {
    const result = synthesize({
      specBrief: 'build feature',
      schemaSnapshot: 'CREATE TABLE users (id TEXT PRIMARY KEY);',
    });

    expect(result).toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
    expect(result).toContain('CREATE TABLE users (id TEXT PRIMARY KEY);');
  });

  it('omits DATABASE SCHEMA section when schemaSnapshot is empty', () => {
    const result = synthesize({
      specBrief: 'build feature',
      schemaSnapshot: '',
    });

    expect(result).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  });

  it('omits DATABASE SCHEMA section when schemaSnapshot is undefined', () => {
    const result = synthesize({
      specBrief: 'build feature',
    });

    expect(result).not.toContain('=== DATABASE SCHEMA (Auto-Hydrated) ===');
  });

  it('never includes PROJECT MEMORY (Git History) section', () => {
    const result = synthesize({
      specBrief: 'build feature',
      l1: 'global',
      schemaSnapshot: 'CREATE TABLE t (id TEXT);',
    });

    expect(result).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });

  it('section order: L1 then L2 then L3 then Schema then L4 then L5', () => {
    const result = synthesize({
      l1: 'global',
      l2: 'domain',
      l3: 'project',
      schemaSnapshot: 'CREATE TABLE t (id TEXT);',
      specBrief: 'the spec',
      storyAnnotations: 'annotations',
    });

    const l1Idx = result.indexOf('=== GLOBAL STANDARDS (L1) ===');
    const l2Idx = result.indexOf('=== DOMAIN PROFILE (L2) ===');
    const l3Idx = result.indexOf('=== PROJECT CONTEXT (L3) ===');
    const schemaIdx = result.indexOf('=== DATABASE SCHEMA (Auto-Hydrated) ===');
    const l4Idx = result.indexOf('=== SPEC BRIEF (L4) ===');
    const l5Idx = result.indexOf('=== STORY ANNOTATIONS (L5) ===');

    expect(l1Idx).toBeGreaterThanOrEqual(0);
    expect(l2Idx).toBeGreaterThan(l1Idx);
    expect(l3Idx).toBeGreaterThan(l2Idx);
    expect(schemaIdx).toBeGreaterThan(l3Idx);
    expect(l4Idx).toBeGreaterThan(schemaIdx);
    expect(l5Idx).toBeGreaterThan(l4Idx);
    expect(result).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });
});

// ─── synthesizeDirectionStack (PG-012) ───────────────────────────────────────

describe('synthesizeDirectionStack', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDirectionLayers.mockResolvedValue({});
    mockGetRecentMemory.mockResolvedValue([]);
    mockGetInstalledSkills.mockResolvedValue([]);
    mockDbQuery.mockResolvedValue([]);
    mockHybridSearch.mockResolvedValue([]);
    mockCacheStats.mockReturnValue({ hits: 0, misses: 0, hitRate: 0, entries: 0, memoryBytes: 0 });
  });

  function setupMocks(opts: {
    l1?: string;
    l2?: string;
    l3?: string;
    schemaSnapshot?: string;
    memories?: Array<{ text: string; ts: string }>;
  } = {}) {
    mockGetDirectionLayers.mockResolvedValue({
      l1: opts.l1,
      l2: opts.l2,
      l3: opts.l3,
      schemaSnapshot: opts.schemaSnapshot,
    });
    const memories = opts.memories ?? [];
    mockGetRecentMemory.mockResolvedValue(memories);
    mockDbQuery.mockImplementation(async (sql: string) => sql.includes('FROM memories')
      ? memories.map((memory, index) => ({
          id: String(index + 1),
          category: 'Pattern',
          content: memory.text,
          confidence: 'medium',
          related_files: [],
          source_type: 'test-fixture',
          source: null,
          pinned: false,
          created_at: memory.ts,
          updated_at: memory.ts,
          source_story_id: null,
          source_spec_id: null,
          source_run_id: null,
        }))
      : []);
  }

  it('returns SynthesizedContext with metadata when no memory entries', async () => {
    setupMocks({ l1: 'Standards content', l3: 'Project context' });

    const result = await synthesizeDirectionStack('ws-1');

    expect(result.text).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result.text).toContain('Standards content');
    expect(result.text).toContain('=== PROJECT CONTEXT (L3) ===');
    expect(result.metadata.layers.standards).toBe(true);
    expect(result.metadata.layers.project).toBe(true);
    expect(result.metadata.layers.conventions).toBe(false);
    expect(result.metadata.memoryEntries.included).toBe(0);
    expect(result.metadata.searchMode).toBe('full-dump');
    expect(result.metadata.droppedItems).toHaveLength(0);
  });

  it('uses recency-based memory when no storyText provided', async () => {
    setupMocks({
      l1: 'Standards',
      memories: [
        { text: 'Always use TypeScript', ts: '2026-01-01T00:00:00Z' },
        { text: 'Use pg Pool for DB', ts: '2026-01-02T00:00:00Z' },
      ],
    });

    const result = await synthesizeDirectionStack('ws-1');

    expect(result.text).toContain('RELEVANT MEMORY');
    expect(result.text).toContain('Always use TypeScript');
    expect(result.text).toContain('Use pg Pool for DB');
    expect(result.metadata.memoryEntries.included).toBe(2);
    expect(result.metadata.searchMode).toBe('full-dump');
  });

  it('uses hybridSearch when storyText provided and cache coverage is low', async () => {
    setupMocks({ l1: 'Standards' });

    mockHybridSearch.mockResolvedValue([
      { sourceType: 'memory', sourceId: 'm1', title: 'Auth pattern', snippet: 'Use JWT for auth', score: 0.8, matchType: 'semantic' },
      { sourceType: 'memory', sourceId: 'm2', title: 'DB pattern', snippet: 'Use pg Pool', score: 0.5, matchType: 'hybrid' },
    ]);

    const result = await synthesizeDirectionStack('1', { storyText: 'Add authentication endpoint' });

    expect(mockHybridSearch).toHaveBeenCalledWith('Add authentication endpoint', {
      sourceTypes: ['memory'],
      workspaceId: '1',
      limit: 15,
    });
    expect(result.metadata.searchMode).toBe('semantic');
    expect(result.metadata.memoryEntries.included).toBeGreaterThanOrEqual(1);
    expect(result.metadata.memoryEntries.relevanceRange[1]).toBeGreaterThan(result.metadata.memoryEntries.relevanceRange[0]);
    expect(result.text).toContain('Use JWT for auth');
  });

  it('includes RAG results in synthesized context', async () => {
    setupMocks({ l1: 'Standards' });

    mockHybridSearch.mockResolvedValue([
      { sourceType: 'memory', sourceId: 'm1', title: 'Relevant', snippet: 'Very relevant entry', score: 0.8, matchType: 'semantic' },
    ]);

    const result = await synthesizeDirectionStack('1', { storyText: 'Some story about something' });

    expect(result.text).toContain('Very relevant entry');
    expect(result.metadata.memoryEntries.included).toBeGreaterThanOrEqual(1);
  });

  it('enforces token budget drops memory entries when over budget', async () => {
    setupMocks({
      l1: 'a'.repeat(40),
      memories: [
        { text: 'b'.repeat(200), ts: '2026-01-01T00:00:00Z' },
        { text: 'c'.repeat(200), ts: '2026-01-02T00:00:00Z' },
      ],
    });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 30 });

    expect(result.metadata.layers.standards).toBe(true);
    expect(result.metadata.totalTokens).toBeLessThanOrEqual(30);
  });

  it('direction layers are NEVER dropped even if over budget', async () => {
    setupMocks({ l1: 'a'.repeat(200) });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 30 });

    expect(result.text).toContain('=== GLOBAL STANDARDS (L1) ===');
    expect(result.metadata.layers.standards).toBe(true);
  });

  it('drops schema when token budget exceeded', async () => {
    setupMocks({
      l1: 'a'.repeat(400),
      schemaSnapshot: 'b'.repeat(400),
    });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 110 });

    expect(result.metadata.layers.standards).toBe(true);
    expect(result.text).not.toContain('=== DATABASE SCHEMA');
    expect(result.text).not.toContain('=== PROJECT MEMORY (Git History) ===');
    expect(result.metadata.droppedItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'schema_snapshot', reason: 'token_budget_exceeded' }),
      ]),
    );
  });

  it('falls back to full-dump cache when storyText not provided', async () => {
    setupMocks({
      l1: 'Standards',
      memories: [
        { text: 'Entry 1', ts: '2026-01-01T00:00:00Z' },
        { text: 'Entry 2', ts: '2026-01-02T00:00:00Z' },
      ],
    });

    const result = await synthesizeDirectionStack('ws-1');

    expect(result.metadata.searchMode).toBe('full-dump');
    expect(mockHybridSearch).not.toHaveBeenCalled();
    expect(result.metadata.memoryEntries.included).toBeGreaterThanOrEqual(1);
  });

  it('defaults maxTokens to 32000', async () => {
    setupMocks({ l1: 'Standards' });

    const result = await synthesizeDirectionStack('ws-1');

    expect(result.metadata.totalTokens).toBeLessThan(32000);
  });

  it('output stays under maxTokens for large memory sets', async () => {
    const manyEntries = Array.from({ length: 50 }, (_, i) => ({
      text: `Memory rule ${i}: ${'x'.repeat(100)}`,
      ts: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    setupMocks({
      l1: 'Standards text',
      memories: manyEntries,
    });

    const result = await synthesizeDirectionStack('ws-1', { maxTokens: 500 });

    expect(result.metadata.totalTokens).toBeLessThanOrEqual(500);
    expect(result.metadata.memoryEntries.included).toBeLessThan(50);
  });
});
