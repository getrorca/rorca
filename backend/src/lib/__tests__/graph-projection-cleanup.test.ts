/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockQuery = jest.fn();

jest.mock('../../db/index', () => ({
  pool: {
    query: (...args: unknown[]) => mockPoolQuery(...args),
    connect: jest.fn(async () => ({
      query: mockClientQuery,
      release: mockRelease,
    })),
  },
  query: (...args: unknown[]) => mockQuery(...args),
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
  buildWorkspaceProjectionPrunePlan,
  reconcileWorkspaceGraphProjection,
} from '../knowledge-graph';

function cypherSqlCalls(): string[] {
  return mockClientQuery.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => sql.includes("cypher('rorca'"));
}

describe('graph projection cleanup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [{ extname: 'age' }] });
    mockQuery.mockResolvedValue([{ id: 99 }]);
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('RETURN cnt')) {
        return { rows: [{ cnt: '0' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it('builds a canonical-key prune plan that preserves active scoped nodes', () => {
    const plan = buildWorkspaceProjectionPrunePlan('ws-1', {
      specIds: ['spec-a'],
      stories: [{ specId: 'spec-a', storyId: 'US-001' }],
      memoryIds: ['99'],
      filePaths: ['./src/app.ts', 'src\\app.ts'],
    });

    expect(plan).toEqual([
      {
        label: 'Story',
        keyPrefix: 'story:ws-1::',
        activeKeys: ['story:ws-1::spec-a::US-001'],
      },
      {
        label: 'Spec',
        keyPrefix: 'spec:ws-1::',
        activeKeys: ['spec:ws-1::spec-a'],
      },
      {
        label: 'Memory',
        keyPrefix: 'memory:ws-1::',
        activeKeys: ['memory:ws-1::99'],
      },
      {
        label: 'File',
        keyPrefix: 'file:ws-1::',
        activeKeys: ['file:ws-1::src/app.ts'],
        additionalWhere: "COALESCE(n.path, '') <> ''",
      },
    ]);
  });

  it('reconciles workspace-scoped stale projection nodes by canonical key', async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-graph-cleanup-'));
    try {
      fs.mkdirSync(path.join(workspacePath, 'forge', 'specs', 'approved'), { recursive: true });
      fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(workspacePath, 'forge', 'specs', 'approved', 'spec-a.json'),
        JSON.stringify({ userStories: [{ id: 'US-001', title: 'Keep active story' }] }),
      );
      fs.writeFileSync(path.join(workspacePath, 'src', 'app.ts'), 'export const ok = true;\n');

      const result = await reconcileWorkspaceGraphProjection('ws-1', workspacePath);

      expect(result).toEqual({
        active: { Story: 1, Spec: 1, Memory: 1, File: 2 },
        pruned: { Story: 0, Spec: 0, Memory: 0, File: 0 },
      });

      const sql = cypherSqlCalls().join('\n');
      expect(sql).toContain("MATCH (n:Story)");
      expect(sql).toContain("n.key STARTS WITH 'story:ws-1::'");
      expect(sql).toContain("NOT n.key IN ['story:ws-1::spec-a::US-001']");
      expect(sql).toContain("MATCH (n:Spec)");
      expect(sql).toContain("NOT n.key IN ['spec:ws-1::spec-a']");
      expect(sql).toContain("MATCH (n:Memory)");
      expect(sql).toContain("NOT n.key IN ['memory:ws-1::99']");
      expect(sql).toContain("MATCH (n:File)");
      expect(sql).toContain("COALESCE(n.path, '') <> ''");
      expect(sql).toContain("'file:ws-1::forge/specs/approved/spec-a.json'");
      expect(sql).toContain("'file:ws-1::src/app.ts'");
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('FROM memories'),
        ['ws-1'],
      );
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
