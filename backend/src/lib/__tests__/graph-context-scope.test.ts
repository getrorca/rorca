/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockQuery = jest.fn();

jest.mock('../../db/index', () => ({
  pool: {
    connect: jest.fn(async () => ({
      query: mockClientQuery,
      release: mockRelease,
    })),
  },
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock('../context-cache', () => ({
  get: jest.fn(),
  set: jest.fn(),
}));

jest.mock('../knowledge-graph', () => {
  const actual = jest.requireActual('../knowledge-graph');
  return {
    ...actual,
    graphStats: jest.fn().mockResolvedValue({
      available: true,
      vertexCount: 1,
      edgeCount: 0,
      labels: ['Story', 'File'],
    }),
  };
});

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { get, set } from '../context-cache';
import {
  buildGraphContextCacheKey,
  getGraphContext,
} from '../graph-context';

const mockCacheGet = get as jest.MockedFunction<typeof get>;
const mockCacheSet = set as jest.MockedFunction<typeof set>;

function cypherSqlCalls(): string[] {
  return mockClientQuery.mock.calls
    .map(([sql]) => String(sql))
    .filter(sql => sql.includes("cypher('rorca'"));
}

describe('graph context scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCacheGet.mockReturnValue(undefined);
    mockClientQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    mockQuery.mockResolvedValue([]);
  });

  it('cache keys include workspace/spec/story scope while normalizing predicted paths', () => {
    const scoped = buildGraphContextCacheKey('US-001', ['./src/app.ts'], 'ws-1', 'spec-a');
    const normalized = buildGraphContextCacheKey('US-001', ['src\\app.ts'], 'ws-1', 'spec-a');
    const otherSpec = buildGraphContextCacheKey('US-001', ['./src/app.ts'], 'ws-1', 'spec-b');
    const otherWorkspace = buildGraphContextCacheKey('US-001', ['./src/app.ts'], 'ws-2', 'spec-a');

    expect(scoped).toBe(normalized);
    expect(scoped).not.toBe(otherSpec);
    expect(scoped).not.toBe(otherWorkspace);
    expect(scoped).toContain('graph-context:ws-1:spec-a:US-001:');
  });

  it('getGraphContext traverses with canonical story keys and workspace-scoped file keys', async () => {
    await getGraphContext('US-001', ['./src/app.ts'], 'ws-1', 2, 'spec-a');

    const sql = cypherSqlCalls().join('\n');
    expect(sql).toContain("File {key: 'file:ws-1::src/app.ts'}");
    expect(sql).toContain("s.key <> 'story:ws-1::spec-a::US-001'");
    expect(mockCacheSet).toHaveBeenCalledWith(
      expect.stringContaining('graph-context:ws-1:spec-a:US-001:'),
      expect.any(Object),
      'warm',
    );
  });
});
