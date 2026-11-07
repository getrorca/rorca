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
const mockPoolQuery = jest.fn();
const mockCheckAge = jest.fn();

jest.mock('../../db/index', () => ({
  pool: {
    connect: () => mockConnect(),
    query: (...args: unknown[]) => mockPoolQuery(...args),
  },
  query: jest.fn(),
}));

jest.mock('../age-guard', () => ({
  checkAge: () => mockCheckAge(),
  getAgeUnavailableBody: jest.fn(),
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { upsertMemoryRelationProjection } from '../knowledge-graph';

describe('memory relation AGE projection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAge.mockResolvedValue(true);
    mockPoolQuery.mockResolvedValue({ rows: [{ extname: 'age' }], rowCount: 1 });
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql === "SELECT NOW()::text AS now") {
        return { rows: [{ now: '2026-06-02T12:00:00.000Z' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('uses a deterministic workspace-scoped MERGE key so replay cannot create duplicate edges', async () => {
    const row = {
      id: 21,
      workspace_id: 'ws-1',
      source_memory_id: 8,
      target_memory_id: 3,
      relation_type: 'SUPERSEDES' as const,
      canonical_key: 'memory-relation:ws-1::SUPERSEDES::8::3',
      status: 'active' as const,
      created_at: '2026-06-02T10:00:00.000Z',
      updated_at: '2026-06-02T10:05:00.000Z',
      deleted_at: null,
      restored_at: null,
      superseded_at: null,
      source_category: 'Decision',
      source_pinned: false,
      source_created_at: '2026-06-02T10:00:00.000Z',
      source_updated_at: '2026-06-02T10:05:00.000Z',
      target_category: 'Decision',
      target_pinned: true,
      target_created_at: '2026-06-02T09:00:00.000Z',
      target_updated_at: '2026-06-02T09:05:00.000Z',
    };

    await upsertMemoryRelationProjection(row);
    await upsertMemoryRelationProjection(row);

    const cypherSql = mockClientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("cypher('rorca_v2'"));

    expect(cypherSql).toContain("MERGE (source)-[r:SUPERSEDES {key: 'memory-relation:ws-1::SUPERSEDES::8::3'}]->(target)");
    expect(cypherSql).toContain("source:Memory {key: 'memory:ws-1::8'}");
    expect(cypherSql).toContain("target:Memory {key: 'memory:ws-1::3'}");
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('projects inactive lifecycle metadata for deleted or superseded relations', async () => {
    await upsertMemoryRelationProjection({
      id: 33,
      workspace_id: 'ws-2',
      source_memory_id: 4,
      target_memory_id: 9,
      relation_type: 'CONFLICTS_WITH',
      canonical_key: 'memory-relation:ws-2::CONFLICTS_WITH::4::9',
      status: 'deleted',
      created_at: new Date('2026-06-02T11:00:00.000Z'),
      updated_at: new Date('2026-06-02T11:15:00.000Z'),
      deleted_at: new Date('2026-06-02T11:15:00.000Z'),
      restored_at: null,
      superseded_at: null,
      source_category: 'Pattern',
      source_pinned: false,
      source_created_at: new Date('2026-06-02T11:00:00.000Z'),
      source_updated_at: new Date('2026-06-02T11:00:00.000Z'),
      target_category: 'Pattern',
      target_pinned: false,
      target_created_at: new Date('2026-06-02T11:00:00.000Z'),
      target_updated_at: new Date('2026-06-02T11:00:00.000Z'),
    });

    const cypherSql = mockClientQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes("cypher('rorca_v2'"));

    expect(cypherSql).toContain("MERGE (source)-[r:CONFLICTS_WITH {key: 'memory-relation:ws-2::CONFLICTS_WITH::4::9'}]->(target)");
    expect(cypherSql).toContain('r.status = \'deleted\'');
    expect(cypherSql).toContain('r.active = false');
    expect(cypherSql).toContain("r.deleted_at = '2026-06-02T11:15:00.000Z'");
  });
});
