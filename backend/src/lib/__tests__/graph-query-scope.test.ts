/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();

jest.mock('../../db/index', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: jest.fn(async () => ({
      query: mockClientQuery,
      release: mockRelease,
    })),
  },
  query: jest.fn(),
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../age-guard', () => ({
  checkAge: jest.fn().mockResolvedValue(true),
}));

import {
  queryImpact,
  queryRelated,
  querySpecKnowledgeGraph,
  upsertMemoryNode,
} from '../knowledge-graph';

function cypherSqlCalls(): string[] {
  return mockClientQuery.mock.calls
    .map(([sql]) => String(sql))
    .filter(sql => sql.includes("cypher('rorca_v2'"));
}

describe('graph query scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [{ extname: 'age' }] });
    mockClientQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  });

  it('queryRelated resolves scoped story identity to the canonical story key', async () => {
    await queryRelated('Story', 'US-001', 2, ['TOUCHES'], {
      workspaceId: 'ws-1',
      specId: 'spec-a',
    });

    expect(cypherSqlCalls().join('\n')).toContain("MATCH (start:Story {key: 'story:ws-1::spec-a::US-001'})");
  });

  it('queryImpact resolves workspace-scoped normalized file identity before traversal', async () => {
    await queryImpact('./src/app.ts', 'ws-1');

    const sql = cypherSqlCalls().join('\n');
    expect(sql).toContain("File {key: 'file:ws-1::src/app.ts'}");
    expect(sql).not.toContain("File {path: './src/app.ts'}");
  });

  it('querySpecKnowledgeGraph resolves canonical spec identity when workspace scope is provided', async () => {
    await querySpecKnowledgeGraph('spec-a', 'ws-1');

    expect(cypherSqlCalls().join('\n')).toContain("Spec {key: 'spec:ws-1::spec-a'}");
  });

  it('upserts a standalone memory node without inventing relationships', async () => {
    await upsertMemoryNode('42', 'ws-1', 'Decision', {
      pinned: true,
      createdAt: new Date('2026-08-11T00:00:00.000Z'),
      updatedAt: new Date('2026-08-12T00:00:00.000Z'),
    });

    const sql = cypherSqlCalls().join('\n');
    expect(sql).toContain("MERGE (m:Memory {key: 'memory:ws-1::42'})");
    expect(sql).toContain("m.category = COALESCE(m.category, 'Decision')");
    expect(sql).toContain('m.pinned = true');
    expect(sql).not.toContain('LEARNED_FROM');
    expect(sql).not.toContain('FROM_SPEC');
    expect(sql).not.toContain('ABOUT');
  });
});
