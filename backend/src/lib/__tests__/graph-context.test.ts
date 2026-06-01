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
  graphStats: (...args: unknown[]) => mockGraphContextGraphStats(...args),
  parseAgtype: (value: unknown) => mockParseAgtype(value),
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
      const memoryId = Array.isArray(params) ? String(params[0]) : '';
      if (memoryId === '11') return [{ payload: JSON.stringify({ text: 'Payee alias memories should stay workspace-scoped.' }) }];
      if (memoryId === '22') return [{ payload: JSON.stringify({ text: 'Import remediation spec observations apply to touched import files.' }) }];
      return [];
    });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("LOAD 'age'")) return { rows: [] };
      if (sql.includes('SET search_path')) return { rows: [] };
      if (sql.includes("MATCH (f:File {path: 'backend/src/lib/import-history.ts'})<-[:TOUCHES]-(s:Story)-[:LEARNED_FROM]->(m:Memory)")) {
        return { rows: [] };
      }
      if (sql.includes("MATCH (m:Memory)-[:ABOUT]->(f:File {path: 'backend/src/lib/import-history.ts'})")) {
        return { rows: [{ mid: '"11"' }] };
      }
      if (sql.includes("MATCH (f:File {path: 'backend/src/lib/import-history.ts'})<-[:TOUCHES]-(s:Story)-[:BELONGS_TO]->(sp:Spec)<-[:FROM_SPEC]-(m:Memory)")) {
        return { rows: [{ mid: '"22"', specid: '"import-categorization-precision-hardening"' }] };
      }
      if (sql.includes("MATCH (c:Convention)-[:APPLIES_TO]->(f:File {path: 'backend/src/lib/import-history.ts'})")) {
        return { rows: [] };
      }
      if (sql.includes("MATCH (s:Story)-[:TOUCHES]->(f:File {path: 'backend/src/lib/import-history.ts'})")) {
        return { rows: [] };
      }
      if (sql.includes("MATCH (s:Story)-[:TOUCHES]->(f:File {path: 'backend/src/lib/import-history.ts'})<-[:TOUCHES]-(s2:Story)")) {
        return { rows: [] };
      }
      return { rows: [] };
    });
  });

  test('includes memories linked by ABOUT and FROM_SPEC edges for touched files', async () => {
    const { getGraphContext } = require('../graph-context');

    const result = await getGraphContext(
      'IMP-004',
      ['backend/src/lib/import-history.ts'],
      'cashflow',
    );

    expect(result.relatedMemories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: '11',
          text: 'Payee alias memories should stay workspace-scoped.',
          relationship: 'about backend/src/lib/import-history.ts',
          hops: 1,
        }),
        expect.objectContaining({
          memoryId: '22',
          text: 'Import remediation spec observations apply to touched import files.',
          relationship: 'captured in spec import-categorization-precision-hardening which touched backend/src/lib/import-history.ts',
          hops: 3,
        }),
      ]),
    );
    expect(result.graphHits).toBeGreaterThanOrEqual(2);
    expect(mockCacheSet).toHaveBeenCalled();
  });
});

export {};
