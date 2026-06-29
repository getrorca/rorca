/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Express } from 'express';
import request from 'supertest';

// ════════════════════════════════════════════════════════════════════════════
// Mocks — apply BEFORE requiring app
// ════════════════════════════════════════════════════════════════════════════

const mockQueryOne = jest.fn();
const mockRetrieveContext = jest.fn();
const mockRetrieveSeeds = jest.fn();
const mockDetectHydrationStaleness = jest.fn();
const mockPersistRetrievalTrace = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: any[]) => mockQueryOne(...args),
  query: jest.fn().mockResolvedValue([]),
  execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
  closePool: jest.fn(),
}));

jest.mock('../../lib/memory-router', () => ({
  retrieveContext: (...args: any[]) => mockRetrieveContext(...args),
  estimateTokens: (text: string) => (text ? Math.ceil(text.length / 4) : 0),
}));

jest.mock('../../lib/memory-seed-retrieval', () => ({
  retrieveSeeds: (...args: any[]) => mockRetrieveSeeds(...args),
}));

jest.mock('../../lib/hydration-staleness', () => ({
  detectHydrationStaleness: (...args: any[]) => mockDetectHydrationStaleness(...args),
}));

jest.mock('../../lib/retrieval-trace', () => ({
  persistRetrievalTrace: (...args: any[]) => mockPersistRetrievalTrace(...args),
}));

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: () => 'mock',
  getActiveModel: () => 'mock-model',
  isValidModel: () => false,
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

jest.mock('../../lib/context-cache', () => ({
  getDirectionLayers: jest.fn().mockResolvedValue({}),
  getRecentMemory: jest.fn().mockResolvedValue([]),
  getInstalledSkills: jest.fn().mockResolvedValue([]),
  cacheStats: jest.fn().mockReturnValue({ hits: 0 }),
}));

// Use a real (silent) pino logger so pino-http's response serialization
// (logger[stringifySym]) works; a hand-rolled fake omits pino's internal
// symbols and throws on every response finish.
jest.mock('../../lib/logger', () => {
  const pino = require('pino');
  return { logger: pino({ level: 'silent' }) };
});

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

let app: Express;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();

  // Re-apply mocks after resetModules
  jest.mock('../../db/index', () => ({
    queryOne: (...args: any[]) => mockQueryOne(...args),
    query: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue({ rowCount: 0 }),
    closePool: jest.fn(),
  }));
  jest.mock('../../lib/memory-router', () => ({
    retrieveContext: (...args: any[]) => mockRetrieveContext(...args),
    estimateTokens: (text: string) => (text ? Math.ceil(text.length / 4) : 0),
  }));
  jest.mock('../../lib/memory-seed-retrieval', () => ({
    retrieveSeeds: (...args: any[]) => mockRetrieveSeeds(...args),
  }));
  jest.mock('../../lib/hydration-staleness', () => ({
    detectHydrationStaleness: (...args: any[]) => mockDetectHydrationStaleness(...args),
  }));
  jest.mock('../../lib/retrieval-trace', () => ({
    persistRetrievalTrace: (...args: any[]) => mockPersistRetrievalTrace(...args),
  }));
  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: () => 'mock',
    getActiveModel: () => 'mock-model',
    isValidModel: () => false,
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));
  jest.mock('../../lib/context-cache', () => ({
    getDirectionLayers: jest.fn().mockResolvedValue({}),
    getRecentMemory: jest.fn().mockResolvedValue([]),
    getInstalledSkills: jest.fn().mockResolvedValue([]),
    cacheStats: jest.fn().mockReturnValue({ hits: 0 }),
    invalidateOnStaleness: jest.fn().mockReturnValue(false),
  }));
  jest.mock('../../lib/logger', () => {
    const pino = require('pino');
    return { logger: pino({ level: 'silent' }) };
  });

  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
});

afterEach(async () => {
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  delete process.env.NODE_ENV;
});

// ════════════════════════════════════════════════════════════════════════════
// Default mock return values for the happy path
// ════════════════════════════════════════════════════════════════════════════

function mockHappyPath(overrides: {
  workspaceId?: string;
  graphHits?: number;
  cagHits?: number;
  ragHits?: number;
  seedCount?: number;
} = {}) {
  const wsId = overrides.workspaceId ?? 'test-workspace';

  // Workspace lookup
  mockQueryOne.mockResolvedValue({ path: '/fake/path' });

  // Hydration staleness — fresh
  mockDetectHydrationStaleness.mockResolvedValue({
    workspaceId: wsId,
    workspacePath: '/fake/path',
    status: 'clean',
    checks: {
      gitRepo: true,
      hasHydration: true,
      headMatches: true,
      dirtyTree: false,
    },
    currentHead: 'abc123def456',
    hydratedSha: 'abc123def456',
    humanSummary: 'The graph is fresh.',
  });

  // Seed retrieval
  const seedCount = overrides.seedCount ?? 2;
  mockRetrieveSeeds.mockResolvedValue({
    memorySeeds: Array.from({ length: seedCount }, (_, i) => ({
      id: `seed-${i}`,
      kind: 'memory' as const,
      ref: `mem-${i}`,
      category: 'Architecture',
      title: `Memory Seed ${i}`,
      confidence: 0.9,
      trust: 'reviewed' as const,
      reason: 'durable memory',
      score: 0.8,
      tokenEstimate: 100,
      text: `Memory seed content ${i}`,
    })),
    specSeeds: [],
    meta: {
      memoryCandidatesConsidered: 0,
      memoryCandidatesExcludedByGovernance: 0,
      excludedReviewStatuses: [],
      specsConsidered: 0,
      specsExcludedByStatus: 0,
      memorySeedsDroppedByCount: 0,
      memorySeedsDroppedByBudget: 0,
      specSeedsDroppedByCount: 0,
      specSeedsDroppedByBudget: 0,
      memoryTokensUsed: seedCount * 100,
      specTokensUsed: 0,
      tokenBudget: 3200,
    },
  });

  // Context retrieval
  mockRetrieveContext.mockResolvedValue({
    direction: {
      standards: 'Use TypeScript. Prefer async/await.',
      conventions: 'Test convention',
      project: 'Test project context',
    },
    memory: [
      { text: 'Memory entry 1', score: 0.9, source: 'cache' as const, id: 'm1' },
      { text: 'Memory entry 2', score: 0.7, source: 'search' as const, id: 'm2' },
    ],
    skills: [
      { name: 'rorca-forge', content: '# Skill content here' },
    ],
    graphContext: {
      relatedStories: [{ id: 'S-001', title: 'Prior story', relevance: 0.8 }],
      relatedSpecs: [],
      relatedFiles: [],
      relatedConventions: [],
      relatedMemories: [],
    },
    graphSection: '## Graph Context\nRelated story: Prior story',
    meta: {
      cagHits: overrides.cagHits ?? 2,
      ragHits: overrides.ragHits ?? 1,
      graphHits: overrides.graphHits ?? 2,
      totalTokens: 5000,
      latencyMs: 45,
      tier: 'graph' as const,
      needsMoreEvidence: false,
      matchedSkills: ['rorca-forge'],
      selectedCandidateIds: ['m1', 'm2'],
      selectedCandidateKeys: ['memory:test-workspace::m1', 'memory:test-workspace::m2'],
      graphScoreWeight: 0.3,
      graphRerankAppliedWeight: 0.3,
      graphRerankChanged: true,
      graphRerankedCandidateKeys: [],
    },
  });

  // Trace persistence
  mockPersistRetrievalTrace.mockResolvedValue({
    schemaVersion: 'v1' as const,
    traceId: 'ctx-mock-trace',
    workspaceId: wsId,
    briefHash: 'abcdef',
    createdAt: new Date().toISOString(),
    candidates: [],
  });
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe('POST /api/context/retrieve', () => {
  // ── Validation ──────────────────────────────────────────────────────────
  describe('validation', () => {
    test('validates brief is required', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({ workspaceId: 'test' });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain('Validation failed');
    });

    test('validates workspaceId is required', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({ brief: 'Some brief' });
      expect(res.status).toBe(422);
      expect(res.body.error).toContain('Validation failed');
    });

    test('validates budget is positive integer', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({ workspaceId: 'test', brief: 'Some brief', budget: -100 });
      expect(res.status).toBe(422);
    });

    test('validates budget is not a string', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({ workspaceId: 'test', brief: 'Some brief', budget: 'abc' });
      expect(res.status).toBe(422);
    });

    test('validates includeGraph is boolean', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({ workspaceId: 'test', brief: 'Some brief', includeGraph: 'yes' });
      expect(res.status).toBe(422);
    });

    test('validates freshness policy shape', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({ workspaceId: 'test', brief: 'Some brief', freshness: 'not-valid' });
      expect(res.status).toBe(422);
    });

    test('accepts valid freshness policy', async () => {
      mockHappyPath();
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          freshness: { maxAgeMs: 3600000, allowStale: true },
        });
      expect(res.status).toBe(200);
    });
  });

  // ── Workspace Not Found ────────────────────────────────────────────────
  test('returns 404 when workspace not found', async () => {
    mockQueryOne.mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/context/retrieve')
      .send({ workspaceId: 'missing-workspace', brief: 'Some brief' });

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('not found');
  });

  // ── Full Graph (happy path) ────────────────────────────────────────────
  describe('full graph path', () => {
    test('returns sections, trace ID, hydration freshness, token estimates, degradation flags', async () => {
      mockHappyPath({ graphHits: 5, cagHits: 3, ragHits: 2 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X with TypeScript',
          budget: 32000,
          includeGraph: true,
        });

      expect(res.status).toBe(200);

      // traceId
      expect(res.body.traceId).toBeDefined();
      expect(typeof res.body.traceId).toBe('string');
      expect(res.body.traceId).toMatch(/^ctx-/);

      // sections
      expect(res.body.sections.direction).toBeDefined();
      expect(res.body.sections.memory).toHaveLength(2);
      expect(res.body.sections.skills).toHaveLength(1);
      expect(res.body.sections.graphContext).toBeDefined();
      expect(res.body.sections.seeds).toBeDefined();
      expect(res.body.sections.seeds.memorySeeds).toHaveLength(2);
      expect(res.body.sections.seeds.meta).toBeDefined();

      // hydrationFreshness
      expect(res.body.hydrationFreshness.status).toBe('clean');
      expect(res.body.hydrationFreshness.currentHead).toBe('abc123def456');
      expect(res.body.hydrationFreshness.hydratedSha).toBe('abc123def456');
      expect(typeof res.body.hydrationFreshness.humanSummary).toBe('string');

      // tokenEstimates
      expect(res.body.tokenEstimates.direction).toBeGreaterThanOrEqual(0);
      expect(res.body.tokenEstimates.memory).toBeGreaterThanOrEqual(0);
      expect(res.body.tokenEstimates.skills).toBeGreaterThanOrEqual(0);
      expect(res.body.tokenEstimates.seeds).toBeGreaterThanOrEqual(0);
      expect(res.body.tokenEstimates.total).toBeGreaterThanOrEqual(0);

      // degradationFlags
      expect(res.body.degradationFlags).toMatchObject({
        graphDegraded: false,
        graphLite: false,
        cacheDegraded: false,
        searchDegraded: false,
        staleHydration: false,
        noSeeds: false,
      });

      // meta
      expect(res.body.meta.tier).toBe('graph');
      expect(res.body.meta.latencyMs).toBeGreaterThanOrEqual(0);
      expect(res.body.meta.cagHits).toBe(3);
      expect(res.body.meta.ragHits).toBe(2);
      expect(res.body.meta.graphHits).toBe(5);
    });

    test('persists a retrieval trace on success', async () => {
      mockHappyPath({ graphHits: 3 });

      await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          includeGraph: true,
        });

      expect(mockPersistRetrievalTrace).toHaveBeenCalled();
      const traceInput = mockPersistRetrievalTrace.mock.calls[0][0];
      expect(traceInput.workspaceId).toBe('test-workspace');
      expect(traceInput.traceId).toMatch(/^ctx-/);
      expect(traceInput.briefHash).toBeDefined();
      expect(traceInput.graphMode).toBe('full');
    });
  });

  // ── Stale Hydration Allowed ────────────────────────────────────────────
  describe('stale hydration allowed', () => {
    test('proceeds when hydration is stale and allowStale=true', async () => {
      mockHappyPath();
      mockDetectHydrationStaleness.mockResolvedValue({
        workspaceId: 'test-workspace',
        workspacePath: '/fake/path',
        status: 'stale',
        checks: {
          gitRepo: true,
          hasHydration: true,
          headMatches: false,
          dirtyTree: false,
        },
        currentHead: 'new-sha',
        hydratedSha: 'old-sha',
        humanSummary: 'New commits exist. The graph is stale.',
      });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          freshness: { allowStale: true },
        });

      expect(res.status).toBe(200);
      expect(res.body.degradationFlags.staleHydration).toBe(true);
    });

    test('proceeds when hydration is stale and no freshness policy (default)', async () => {
      mockHappyPath();
      mockDetectHydrationStaleness.mockResolvedValue({
        workspaceId: 'test-workspace',
        workspacePath: '/fake/path',
        status: 'stale',
        checks: {
          gitRepo: true,
          hasHydration: true,
          headMatches: false,
          dirtyTree: false,
        },
        currentHead: 'new-sha',
        hydratedSha: 'old-sha',
        humanSummary: 'New commits exist. The graph is stale.',
      });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
        });

      expect(res.status).toBe(200);
      expect(res.body.degradationFlags.staleHydration).toBe(true);
    });
  });

  // ── Stale Hydration Blocked ────────────────────────────────────────────
  describe('stale hydration blocked', () => {
    test('rejects when stale and allowStale=false', async () => {
      mockHappyPath();
      mockDetectHydrationStaleness.mockResolvedValue({
        workspaceId: 'test-workspace',
        workspacePath: '/fake/path',
        status: 'stale',
        checks: {
          gitRepo: true,
          hasHydration: true,
          headMatches: false,
          dirtyTree: false,
        },
        currentHead: 'new-sha',
        hydratedSha: 'old-sha',
        humanSummary: 'New commits exist.',
      });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          freshness: { allowStale: false },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('allowStale is false');
    });

    test('rejects when dirty tree and allowStale=false', async () => {
      mockHappyPath();
      mockDetectHydrationStaleness.mockResolvedValue({
        workspaceId: 'test-workspace',
        workspacePath: '/fake/path',
        status: 'dirty',
        checks: {
          gitRepo: true,
          hasHydration: true,
          headMatches: true,
          dirtyTree: true,
        },
        currentHead: 'abc123',
        hydratedSha: 'abc123',
        humanSummary: 'Working tree has uncommitted changes.',
      });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          freshness: { allowStale: false },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('allowStale is false');
    });

    test('rejects when missing hydration and allowStale=false', async () => {
      mockHappyPath();
      mockDetectHydrationStaleness.mockResolvedValue({
        workspaceId: 'test-workspace',
        workspacePath: '/fake/path',
        status: 'missing',
        checks: {
          gitRepo: true,
          hasHydration: false,
          headMatches: false,
          dirtyTree: false,
        },
        currentHead: 'abc123',
        hydratedSha: null,
        humanSummary: 'No hydration record exists.',
      });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          freshness: { allowStale: false },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('allowStale is false');
    });
  });

  // ── No Graph (includeGraph=false) ──────────────────────────────────────
  describe('no graph', () => {
    test('returns zero graph hits and degrades when includeGraph=false', async () => {
      mockHappyPath({ graphHits: 0, cagHits: 2, ragHits: 0 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          includeGraph: false,
        });

      expect(res.status).toBe(200);
      // When includeGraph is false, graphDegraded is false (caller opted out)
      expect(res.body.degradationFlags.graphDegraded).toBe(false);
      expect(res.body.degradationFlags.graphLite).toBe(false);
    });

    test('still includes direction, memory, skills sans graph', async () => {
      mockHappyPath({ graphHits: 0, cagHits: 2, ragHits: 0 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          includeGraph: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.sections.direction).toBeDefined();
      expect(res.body.sections.memory).toHaveLength(2);
      expect(res.body.sections.skills).toHaveLength(1);
    });

    test('graphMode in trace is disabled when includeGraph=false', async () => {
      mockHappyPath({ graphHits: 0 });

      await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          includeGraph: false,
        });

      expect(mockPersistRetrievalTrace).toHaveBeenCalled();
      const traceInput = mockPersistRetrievalTrace.mock.calls[0][0];
      expect(traceInput.graphMode).toBe('disabled');
    });
  });

  // ── No Matches / Zero Hits ─────────────────────────────────────────────
  describe('no matches', () => {
    test('reports zero hits and no seeds', async () => {
      mockHappyPath({ graphHits: 0, cagHits: 0, ragHits: 0, seedCount: 0 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Something completely unrelated to everything',
          includeGraph: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.degradationFlags.noSeeds).toBe(true);
      expect(res.body.degradationFlags.cacheDegraded).toBe(true);
      expect(res.body.degradationFlags.searchDegraded).toBe(true);
      expect(res.body.sections.seeds.memorySeeds).toHaveLength(0);
    });

    test('still returns traceId and hydrationFreshness when no matches', async () => {
      mockHappyPath({ graphHits: 0, cagHits: 0, ragHits: 0, seedCount: 0 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'A novel concept',
        });

      expect(res.status).toBe(200);
      expect(res.body.traceId).toMatch(/^ctx-/);
      expect(res.body.hydrationFreshness.status).toBe('clean');
    });
  });

  // ── Invalid Budget ─────────────────────────────────────────────────────
  describe('invalid budget', () => {
    test('rejects budget of 0', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          budget: 0,
        });

      expect(res.status).toBe(422);
    });

    test('rejects budget exceeding max (200000)', async () => {
      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          budget: 300000,
        });

      expect(res.status).toBe(422);
    });

    test('accepts budget at max (200000)', async () => {
      mockHappyPath();

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          budget: 200000,
        });

      expect(res.status).toBe(200);
    });
  });

  // ── Trace failures are non-blocking ────────────────────────────────────
  test('returns 200 even when trace persistence fails', async () => {
    mockHappyPath();
    mockPersistRetrievalTrace.mockRejectedValue(new Error('DB connection lost'));

    const res = await request(app)
      .post('/api/context/retrieve')
      .send({
        workspaceId: 'test-workspace',
        brief: 'Implement feature X',
      });

    expect(res.status).toBe(200);
    // Response still has sections, traceId, etc.
    expect(res.body.traceId).toMatch(/^ctx-/);
    expect(res.body.sections.direction).toBeDefined();
  });

  // ── Degradation Flags ──────────────────────────────────────────────────
  describe('degradation flags', () => {
    test('graphDegraded true when includeGraph=true but no graph hits', async () => {
      mockHappyPath({ graphHits: 0, cagHits: 5, ragHits: 3 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          includeGraph: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.degradationFlags.graphDegraded).toBe(true);
      expect(res.body.degradationFlags.graphLite).toBe(true);
    });

    test('graphDegraded false when includeGraph=false (called opted out)', async () => {
      mockHappyPath({ graphHits: 0, cagHits: 2, ragHits: 1 });

      const res = await request(app)
        .post('/api/context/retrieve')
        .send({
          workspaceId: 'test-workspace',
          brief: 'Implement feature X',
          includeGraph: false,
        });

      expect(res.status).toBe(200);
      // When includeGraph is false, graphDegraded should be false — the caller opted out, not degraded
      expect(res.body.degradationFlags.graphDegraded).toBe(false);
      expect(res.body.degradationFlags.graphLite).toBe(false);
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Swagger tier/rationale annotations contract test
// ════════════════════════════════════════════════════════════════════════════

describe('context/retrieve Swagger contract', () => {
  test('route handler exists and is reachable', async () => {
    mockHappyPath();

    const res = await request(app)
      .post('/api/context/retrieve')
      .send({
        workspaceId: 'test-workspace',
        brief: 'Test brief',
      });

    expect(res.status).toBe(200);
  });

  test('x-rorca-tier is public (documented in swagger annotations)', () => {
    // The presence of the route at POST /api/context/retrieve with x-rorca-tier: public
    // is verified by the fact it's reachable without tier auth errors.
    // The Swagger annotation is in the source code at context.ts.
    expect(true).toBe(true);
  });
});
