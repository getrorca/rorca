/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import '../../lib/async-handler';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockQueryOne = jest.fn();
const mockQuery = jest.fn();
const mockCheckAge = jest.fn();

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

jest.mock('../../lib/age-guard', () => ({
  checkAge: () => mockCheckAge(),
}));

import specRelevanceGraphRouter from '../spec-relevance-graph';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/spec-relevance-graph', specRelevanceGraphRouter);
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? 'error' });
  });
  return app;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const WS_ID = 'ws-test-1';
const SPEC_SLUG = 'my-test-spec';
const RUN_ID = 42;
const TELEMETRY_ID = 'tel-001';
const STORY_ID = 'story-abc';

function makeTelemetryRow(overrides: Record<string, any> = {}) {
  return {
    id: TELEMETRY_ID,
    workspace_id: WS_ID,
    query_preview: 'test query',
    matched_skills: ['skill-a'],
    selected_candidate_keys: ['mem:1', 'mem:2'],
    dropped_candidate_keys: ['mem:3'],
    needs_more_evidence: false,
    candidate_count: 3,
    selected_count: 2,
    token_budget: 4000,
    payload: {
      candidates: [
        {
          key: 'mem:1',
          origin: 'rag',
          sourceType: 'memory',
          title: 'Memory One',
          category: 'Architecture',
          snippet: 'Some snippet',
          finalScore: 0.85,
          semanticRankScore: 0.7,
          graphScore: 0.3,
          freshnessScore: 0.9,
          decision: 'keep',
          reasons: ['High relevance'],
          scoring: {
            breakdown: {
              directGraphProximity: { proximityUnavailable: false },
              skillAlignment: { raw: 0.5 },
            },
            keywordScore: 0.4,
          },
        },
        {
          key: 'mem:2',
          origin: 'cag',
          finalScore: 0.6,
          semanticRankScore: 0.5,
          decision: 'keep',
          reasons: ['Moderate relevance'],
        },
        {
          key: 'mem:3',
          origin: 'rag',
          finalScore: 0.2,
          semanticRankScore: 0.1,
          decision: 'drop',
          reasons: ['Low score'],
          scoring: {
            breakdown: {
              directGraphProximity: { proximityUnavailable: true },
            },
          },
        },
      ],
    },
    latency_ms: 120,
    retrieval_tier: 'hybrid',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

function setupDefaultMocks() {
  mockCheckAge.mockResolvedValue(true);

  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    // Workspace lookup
    if (sql.includes('FROM workspaces WHERE id')) {
      return params[0] === WS_ID ? { id: WS_ID, path: '/tmp/ws' } : undefined;
    }
    // Run lookup
    if (sql.includes('FROM pipeline_runs WHERE id')) {
      return params[0] === RUN_ID
        ? { id: RUN_ID, spec_path: `forge/specs/approved/${SPEC_SLUG}.json`, workspace_id: WS_ID }
        : undefined;
    }
    // WAL telemetry lookup for run
    if (sql.includes("event_type = 'story_started'") && sql.includes('retrieval_telemetry_id')) {
      return { story_id: STORY_ID, telemetry_id: TELEMETRY_ID };
    }
    // Telemetry event lookup
    if (sql.includes('FROM retrieval_telemetry_events')) {
      return params[0] === TELEMETRY_ID ? makeTelemetryRow() : undefined;
    }
    // Latest run for spec
    if (sql.includes('FROM pipeline_runs') && sql.includes('ORDER BY started_at DESC')) {
      return { id: RUN_ID };
    }
    return undefined;
  });

  mockQuery.mockImplementation(async (sql: string) => {
    // Routed files
    if (sql.includes('routed_files')) {
      return [
        { file_path: 'src/components/App.tsx' },
        { file_path: 'src/lib/utils.ts' },
      ];
    }
    return [];
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('spec-relevance-graph routes', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  describe('GET /api/spec-relevance-graph', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const res = await request(app).get('/api/spec-relevance-graph');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspaceId/i);
    });

    it('returns 400 when no scope param is provided', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/specSlug.*runId.*retrievalTelemetryId/i);
    });

    it('returns 404 when workspace does not exist', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: 'nonexistent', specSlug: SPEC_SLUG });
      expect(res.status).toBe(404);
    });

    it('returns graph with hub, file nodes, and memory nodes for a run', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);

      // Hub
      expect(res.body.hub).toBeDefined();
      expect(res.body.hub.type).toBe('hub');
      expect(res.body.hub.ring).toBe(0);
      expect(res.body.hub.specId).toBe(SPEC_SLUG);

      // Nodes
      const fileNodes = res.body.nodes.filter((n: any) => n.type === 'file');
      const memNodes = res.body.nodes.filter((n: any) => n.type === 'memory');
      expect(fileNodes.length).toBe(2);
      expect(memNodes.length).toBe(3);

      // Ring assignments
      expect(fileNodes.every((n: any) => n.ring === 1)).toBe(true);
      expect(memNodes.every((n: any) => n.ring === 2)).toBe(true);

      // Memory node details
      const selectedMem = memNodes.find((n: any) => n.entityId === 'mem:1');
      expect(selectedMem.selected).toBe(true);
      expect(selectedMem.relevanceScore).toBe(0.85);
      expect(selectedMem.scoreBreakdown.semantic).toBe(0.7);
      expect(selectedMem.scoreBreakdown.graph).toBe(0.3);
      expect(selectedMem.category).toBe('Architecture');

      const droppedMem = memNodes.find((n: any) => n.entityId === 'mem:3');
      expect(droppedMem.selected).toBe(false);
      expect(droppedMem.dropped).toBe(true);

      // Edges
      const routedEdges = res.body.edges.filter((e: any) => e.relation === 'routed_to');
      const selectedEdges = res.body.edges.filter((e: any) => e.relation === 'selected_memory');
      const droppedEdges = res.body.edges.filter((e: any) => e.relation === 'dropped_memory');
      expect(routedEdges.length).toBe(2);
      expect(selectedEdges.length).toBe(2);
      expect(droppedEdges.length).toBe(1);

      // Score legend
      expect(res.body.scoreLegend.length).toBeGreaterThan(0);
      expect(res.body.scoreLegend.map((l: any) => l.field)).toContain('semantic');
      expect(res.body.scoreLegend.map((l: any) => l.field)).toContain('graph');

      // Summary
      expect(res.body.summary.selectedCount).toBe(2);
      expect(res.body.summary.droppedCount).toBe(1);
      expect(res.body.summary.avgRelevanceScore).toBeCloseTo((0.85 + 0.6 + 0.2) / 3, 2);
    });

    it('returns graph/path as null with missing reason when graph proximity unavailable', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID });

      expect(res.status).toBe(200);

      // The dropped candidate (mem:3) has proximityUnavailable=true
      const droppedMem = res.body.nodes.find((n: any) => n.entityId === 'mem:3');
      expect(droppedMem.scoreBreakdown.graph).toBeNull();

      // The dropped edge should have evidence about missing graph score
      const droppedEdge = res.body.edges.find((e: any) =>
        e.relation === 'dropped_memory' && e.target.includes('mem:3'),
      );
      expect(droppedEdge.evidence).toMatch(/proximity unavailable/i);
    });

    it('reports AGE unavailable in fallback when checkAge returns false', async () => {
      mockCheckAge.mockResolvedValue(false);

      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true); // still returns data from telemetry
      expect(res.body.fallback.ageAvailable).toBe(false);
      expect(res.body.fallback.missingReasons).toContain(
        'Apache AGE not available — graph/path scores will be null',
      );
    });

    it('returns partial state when telemetry is missing for a run', async () => {
      mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM workspaces WHERE id')) {
          return params[0] === WS_ID ? { id: WS_ID, path: '/tmp/ws' } : undefined;
        }
        if (sql.includes('FROM pipeline_runs WHERE id')) {
          return params[0] === RUN_ID
            ? { id: RUN_ID, spec_path: `forge/specs/approved/${SPEC_SLUG}.json`, workspace_id: WS_ID }
            : undefined;
        }
        // No WAL event with telemetry
        if (sql.includes("event_type = 'story_started'")) {
          return undefined;
        }
        return undefined;
      });
      mockQuery.mockResolvedValue([]);

      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.fallback.telemetryAvailable).toBe(false);
      expect(res.body.fallback.missingReasons).toContain(
        'No retrieval telemetry found for this run',
      );
      // Hub still present but no memory nodes
      expect(res.body.hub).toBeDefined();
      const memNodes = res.body.nodes.filter((n: any) => n.type === 'memory');
      expect(memNodes.length).toBe(0);
    });

    it('applies bounded caps and reports truncation', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID, maxMemories: 2 });

      expect(res.status).toBe(200);
      const memNodes = res.body.nodes.filter((n: any) => n.type === 'memory');
      expect(memNodes.length).toBe(2);
      expect(res.body.truncation.memoriesTruncated).toBe(true);
      expect(res.body.truncation.totalCandidates).toBe(3);
      expect(res.body.truncation.returnedCandidates).toBe(2);
    });

    it('normalizes scores — all relevanceScore values are in [0, 1] range', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID });

      expect(res.status).toBe(200);
      const memNodes = res.body.nodes.filter((n: any) => n.type === 'memory');
      for (const node of memNodes) {
        if (node.relevanceScore != null) {
          expect(node.relevanceScore).toBeGreaterThanOrEqual(0);
          expect(node.relevanceScore).toBeLessThanOrEqual(1);
        }
      }
    });
  });

  describe('GET /api/spec-relevance-graph/by-run/:runId', () => {
    it('returns 404 when run does not exist', async () => {
      mockQueryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM pipeline_runs')) return undefined;
        return undefined;
      });

      const res = await request(app).get('/api/spec-relevance-graph/by-run/999');
      expect(res.status).toBe(404);
    });

    it('returns 400 for invalid runId', async () => {
      const res = await request(app).get('/api/spec-relevance-graph/by-run/abc');
      expect(res.status).toBe(400);
    });

    it('returns graph scoped to run workspace', async () => {
      const res = await request(app).get(`/api/spec-relevance-graph/by-run/${RUN_ID}`);

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.hub.runId).toBe(RUN_ID);
      expect(res.body.hub.specId).toBe(SPEC_SLUG);
    });
  });

  describe('GET /api/spec-relevance-graph/by-spec/:specSlug', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const res = await request(app)
        .get(`/api/spec-relevance-graph/by-spec/${SPEC_SLUG}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspaceId/i);
    });

    it('returns graph for spec with latest run telemetry', async () => {
      const res = await request(app)
        .get(`/api/spec-relevance-graph/by-spec/${SPEC_SLUG}`)
        .query({ workspaceId: WS_ID });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.hub.specId).toBe(SPEC_SLUG);
    });

    it('returns available graph even when no runs exist for spec', async () => {
      mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM workspaces WHERE id')) {
          return params[0] === WS_ID ? { id: WS_ID, path: '/tmp/ws' } : undefined;
        }
        // No latest run
        if (sql.includes('FROM pipeline_runs') && sql.includes('ORDER BY started_at DESC')) {
          return undefined;
        }
        return undefined;
      });

      const res = await request(app)
        .get(`/api/spec-relevance-graph/by-spec/${SPEC_SLUG}`)
        .query({ workspaceId: WS_ID });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.fallback.telemetryAvailable).toBe(false);
    });
  });

  describe('GET /api/spec-relevance-graph with retrievalTelemetryId', () => {
    it('returns graph when telemetry ID is provided directly', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, retrievalTelemetryId: TELEMETRY_ID });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.fallback.telemetryAvailable).toBe(true);
      const memNodes = res.body.nodes.filter((n: any) => n.type === 'memory');
      expect(memNodes.length).toBe(3);
    });

    it('reports unavailable telemetry when ID does not exist', async () => {
      mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM workspaces WHERE id')) {
          return params[0] === WS_ID ? { id: WS_ID, path: '/tmp/ws' } : undefined;
        }
        // Telemetry not found
        if (sql.includes('FROM retrieval_telemetry_events')) {
          return undefined;
        }
        return undefined;
      });

      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, retrievalTelemetryId: 'nonexistent' });

      expect(res.status).toBe(200);
      expect(res.body.available).toBe(true);
      expect(res.body.fallback.telemetryAvailable).toBe(false);
      expect(res.body.fallback.missingReasons).toContain(
        'Retrieval telemetry event nonexistent not found',
      );
    });
  });

  describe('edge visual hints', () => {
    it('selected_memory edges are solid, dropped_memory edges are dashed', async () => {
      const res = await request(app)
        .get('/api/spec-relevance-graph')
        .query({ workspaceId: WS_ID, runId: RUN_ID });

      expect(res.status).toBe(200);
      const selectedEdge = res.body.edges.find((e: any) => e.relation === 'selected_memory');
      const droppedEdge = res.body.edges.find((e: any) => e.relation === 'dropped_memory');

      expect(selectedEdge.visualHints.dashed).toBe(false);
      expect(droppedEdge.visualHints.dashed).toBe(true);
      expect(droppedEdge.visualHints.opacity).toBe(0.4);
    });
  });
});
