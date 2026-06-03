/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(async () => ({
  query: mockClientQuery,
  release: mockRelease,
}));
const mockCheckAge = jest.fn();

jest.mock('../../db/index', () => ({
  pool: {
    connect: () => mockConnect(),
  },
  query: jest.fn(),
}));

jest.mock('../age-guard', () => ({
  checkAge: () => mockCheckAge(),
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  getMemoryGraphNeighborhood,
  getMemoryGraphOverview,
} from '../memory-graph';

function ag(value: unknown): string {
  return JSON.stringify(value);
}

function cypherSqlCalls(): string[] {
  return mockClientQuery.mock.calls
    .map(([sql]) => String(sql))
    .filter(sql => sql.includes("cypher('rorca'"));
}

describe('memory-graph helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAge.mockResolvedValue(true);
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === "SELECT current_setting('search_path') AS search_path") {
        return { rows: [{ search_path: 'rorca, public' }], rowCount: 1 };
      }
      if (sql === "LOAD 'age'" || sql === 'SET search_path = ag_catalog, "$user", public') {
        return { rows: [], rowCount: 0 };
      }
      if (sql === "SELECT set_config('search_path', $1, false)") {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('MATCH (m:Memory)') && sql.includes('RETURN m.id AS memoryId')) {
        if (sql.includes("AND m.id = '42'")) {
          return {
            rows: [{ memoryId: ag('42'), category: ag('Architecture'), pinned: ag(true), createdAt: ag('2026-06-02T10:00:00.000Z') }],
            rowCount: 1,
          };
        }

        return {
          rows: [
            { memoryId: ag('42'), category: ag('Architecture'), pinned: ag(true), createdAt: ag('2026-06-02T10:00:00.000Z') },
            { memoryId: ag('84'), category: ag('Decision'), pinned: ag(false), createdAt: ag('2026-06-01T10:00:00.000Z') },
          ],
          rowCount: 2,
        };
      }

      if (sql.includes('MATCH (m:Memory)-[:LEARNED_FROM]->(s:Story)')) {
        return {
          rows: [
            { memoryId: ag('42'), storyId: ag('US-001'), storyTitle: ag('Build graph API'), specId: ag('spec-a') },
            { memoryId: ag('84'), storyId: ag('US-002'), storyTitle: ag('Render panel summary'), specId: ag('spec-b') },
          ],
          rowCount: 2,
        };
      }

      if (sql.includes('MATCH (m:Memory)-[:ABOUT]->(f:File)')) {
        return {
          rows: [
            { memoryId: ag('42'), filePath: ag('src/app.tsx') },
            { memoryId: ag('84'), filePath: ag('backend/src/routes/memory.ts') },
          ],
          rowCount: 2,
        };
      }

      if (sql.includes('MATCH (m:Memory)-[:FROM_SPEC]->(sp:Spec)')) {
        return {
          rows: [
            { memoryId: ag('42'), specId: ag('spec-a'), specTitle: ag('Memory Ontology Canonical'), specStatus: ag('approved') },
            { memoryId: ag('84'), specId: ag('spec-b'), specTitle: ag('Panel polish'), specStatus: ag('approved') },
          ],
          rowCount: 2,
        };
      }

      if (sql.includes('MATCH (s:Story)-[:DEPENDS_ON]->(d:Story)')) {
        return {
          rows: [
            { storyId: ag('US-002'), storySpecId: ag('spec-b'), dependsOnId: ag('US-001'), dependsOnTitle: ag('Build graph API'), dependsOnSpecId: ag('spec-a') },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('MATCH (s:Story)-[:TOUCHES]->(f:File)')) {
        return {
          rows: [
            { storyId: ag('US-001'), specId: ag('spec-a'), filePath: ag('backend/src/lib/memory-graph.ts') },
          ],
          rowCount: 1,
        };
      }

      if (sql.includes('MATCH (s:Story)-[:BELONGS_TO]->(sp:Spec)')) {
        return {
          rows: [
            { storyId: ag('US-001'), specId: ag('spec-a'), specTitle: ag('Memory Ontology Canonical'), specStatus: ag('approved') },
            { storyId: ag('US-002'), specId: ag('spec-b'), specTitle: ag('Panel polish'), specStatus: ag('approved') },
          ],
          rowCount: 2,
        };
      }

      return { rows: [], rowCount: 0 };
    });
  });

  it('returns a deterministic overview graph with workspace-scoped bounded queries', async () => {
    const result = await getMemoryGraphOverview('ws-1');

    expect(result.available).toBe(true);
    expect(result.scope).toEqual({ workspaceId: 'ws-1', view: 'overview', memoryId: null });
    expect(result.selection.suggestedMemoryIds).toEqual(['42', '84']);
    expect(result.selection.relatedStoryIds).toEqual(['US-001', 'US-002']);
    expect(result.summary.countsByEdgeType).toEqual({
      ABOUT: 2,
      LEARNED_FROM: 2,
      FROM_SPEC: 2,
      TOUCHES: 1,
      BELONGS_TO: 2,
      DEPENDS_ON: 1,
    });
    expect(result.edges.map(edge => edge.type)).toEqual([
      'ABOUT',
      'ABOUT',
      'LEARNED_FROM',
      'LEARNED_FROM',
      'FROM_SPEC',
      'FROM_SPEC',
      'TOUCHES',
      'BELONGS_TO',
      'BELONGS_TO',
      'DEPENDS_ON',
    ]);

    const sql = cypherSqlCalls().join('\n');
    expect(sql).toContain("WHERE (m.workspaceId = 'ws-1' OR m.workspace_id = 'ws-1')");
    expect(sql).toContain("AND m.id IN ['42', '84']");
    expect(sql).toContain('LIMIT 12');
    expect(sql).toContain('LIMIT 8');
  });

  it('returns a selected-memory neighborhood graph centered on the requested memory', async () => {
    const result = await getMemoryGraphNeighborhood('ws-1', '42');

    expect(result.available).toBe(true);
    expect(result.scope).toEqual({ workspaceId: 'ws-1', view: 'neighborhood', memoryId: '42' });
    expect(result.selection.selectedMemoryId).toBe('42');
    expect(result.nodes.find(node => node.type === 'Memory')?.selected).toBe(true);

    const sql = cypherSqlCalls().join('\n');
    expect(sql).toContain("AND m.id = '42'");
    expect(sql).toContain("AND s.id IN ['US-001', 'US-002']");
  });

  it('returns a graceful available=false payload when AGE is unavailable', async () => {
    mockCheckAge.mockResolvedValue(false);

    const result = await getMemoryGraphOverview('ws-1');

    expect(result).toMatchObject({
      available: false,
      scope: { workspaceId: 'ws-1', view: 'overview', memoryId: null },
      code: 'AGE_NOT_AVAILABLE',
      mode: 'lite',
      hint: expect.stringMatching(/rorca db start/i),
    });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('restores search_path and returns available=false when a query fails', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === "SELECT current_setting('search_path') AS search_path") {
        return { rows: [{ search_path: 'rorca, public' }], rowCount: 1 };
      }
      if (sql === "LOAD 'age'" || sql === 'SET search_path = ag_catalog, "$user", public') {
        return { rows: [], rowCount: 0 };
      }
      if (sql === "SELECT set_config('search_path', $1, false)") {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('boom');
    });

    const result = await getMemoryGraphOverview('ws-1');

    expect(result.available).toBe(false);
    expect(result.code).toBe('GRAPH_QUERY_FAILED');
    expect(mockClientQuery).toHaveBeenCalledWith("SELECT set_config('search_path', $1, false)", ['rorca, public']);
  });
});
