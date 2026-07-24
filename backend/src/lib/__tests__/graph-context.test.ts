/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockGraphContextGraphStats = jest.fn();
const mockParseAgtype = jest.fn((value: unknown) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
});
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
const mockDbQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../knowledge-graph', () => ({
  ...jest.requireActual('../knowledge-graph'),
  graphStats: (...args: unknown[]) => mockGraphContextGraphStats(...args),
  parseAgtype: (value: unknown) => mockParseAgtype(value),
}));

jest.mock('../age-guard', () => ({
  checkAge: jest.fn().mockResolvedValue(true),
}));

jest.mock('../context-cache', () => ({
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: (...args: unknown[]) => mockCacheSet(...args),
}));

jest.mock('../../db/index', () => ({
  pool: {
    connect: jest.fn(async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: (...args: unknown[]) => mockRelease(...args),
    })),
  },
  query: (...args: unknown[]) => mockDbQuery(...args),
}));

jest.mock('../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

describe('graph-context', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    mockGraphContextGraphStats.mockResolvedValue({ available: true, vertexCount: 10, edgeCount: 20 });
    mockCacheGet.mockReturnValue(undefined);
    mockDbQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('FROM wal_events')) return [];
      const memoryIds = Array.isArray(params?.[0]) ? params[0].map(String) : [];
      return memoryIds.map((memoryId) => ({
        memory_id: memoryId,
        payload: JSON.stringify({
          id: memoryId,
          text: memoryId === '11'
            ? 'Payee alias memories should stay workspace-scoped.'
            : 'Import remediation spec observations apply to touched import files.',
        }),
      }));
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("LOAD 'age'")) return { rows: [] };
      if (sql.includes('SET search_path')) return { rows: [] };
      if (sql.includes('MATCH (f:File)<-[:TOUCHES]-(s:Story)-[:LEARNED_FROM]->(m:Memory)')) {
        return { rows: [{ mid: '"11"', sid: '"IMP-003"', fpath: '"backend/src/lib/import-history.ts"' }] };
      }
      if (sql.includes('MATCH (f:File)<-[:TOUCHES]-(s:Story)-[:TOUCHES]->(f2:File)<-[:ABOUT]-(m:Memory)')) {
        return { rows: [{ mid: '"22"', fpath: '"backend/src/lib/import-normalization.ts"' }] };
      }
      if (sql.includes('MATCH (c:Convention)-[:APPLIES_TO]->(f:File)')) return { rows: [] };
      if (sql.includes('MATCH (s:Story)-[:TOUCHES]->(f:File)')) return { rows: [] };
      if (sql.includes('MATCH (f:File)<-[:TOUCHES]-(s2:Story)')) return { rows: [] };
      return { rows: [] };
    });
  });

  test('includes memories linked by current scoped direct and co-modified traversals', async () => {
    const { getGraphContext } = require('../graph-context');

    const result = await getGraphContext(
      'IMP-004',
      ['backend/src/lib/import-history.ts'],
      'cashflow',
      3,
    );

    expect(result.relatedMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: '11',
          text: 'Payee alias memories should stay workspace-scoped.',
          relationship: 'learned by IMP-003 which touched backend/src/lib/import-history.ts',
          hops: 2,
        }),
        expect.objectContaining({
          memoryId: '22',
          text: 'Import remediation spec observations apply to touched import files.',
          relationship: 'about co-modified file backend/src/lib/import-normalization.ts',
          hops: 3,
        }),
      ]),
    );
    expect(result.graphHits).toBeGreaterThanOrEqual(2);
    expect(mockCacheSet).toHaveBeenCalled();
  });
});

export {};
