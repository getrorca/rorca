/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockChatComplete = jest.fn();
const mockEmbedText = jest.fn();
const mockPrepareText = jest.fn((_: string, text: string) => text);
const mockCollectStoryFileTouches = jest.fn();
const mockBroadcastAll = jest.fn();
const mockResolveWorkflowConfig = jest.fn();
const mockHydrateSchema = jest.fn();
const mockGitMapStep = jest.fn();
const mockGitReduceStep = jest.fn();
const mockGetLatestHash = jest.fn();
const mockGetCurrentHead = jest.fn();
const mockExistsSync = jest.fn();

jest.mock('../../db/index', () => ({
  execute: mockExecute,
  query: mockQuery,
  queryOne: mockQueryOne,
}));

jest.mock('../llm-client', () => ({
  chatComplete: mockChatComplete,
}));

jest.mock('../embedding-pipeline', () => ({
  embedText: mockEmbedText,
  prepareText: mockPrepareText,
}));

jest.mock('../knowledge-graph', () => ({
  collectStoryFileTouches: mockCollectStoryFileTouches,
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../sse-hub', () => ({
  broadcastAll: mockBroadcastAll,
}));

jest.mock('../workflow-config-resolver', () => ({
  resolveWorkflowConfig: mockResolveWorkflowConfig,
}));

jest.mock('../schema-hydrator', () => ({
  hydrateSchema: mockHydrateSchema,
}));

jest.mock('../git-hydrator', () => ({
  gitMapStep: mockGitMapStep,
  gitReduceStep: mockGitReduceStep,
  getLatestHash: mockGetLatestHash,
  getCurrentHead: mockGetCurrentHead,
}));

jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

import {
  autoSynthesizeMemory,
  isGitMemoryStale,
  GIT_MEMORY_STALENESS_MS,
  autoHydrateWorkspaceContext,
  maybeRehydrateGitMemoryOnSpecGen,
  buildContextHealthSummary,
} from '../auto-memory';

describe('autoSynthesizeMemory provenance hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveWorkflowConfig.mockResolvedValue({});
    mockChatComplete.mockResolvedValue({
      text: JSON.stringify([
        {
          category: 'Pattern',
          content: 'Persist memory provenance from canonical sources.',
          confidence: 'high',
          relatedFiles: [],
        },
      ]),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    mockEmbedText.mockResolvedValue([0.1, 0.2]);
    mockCollectStoryFileTouches.mockResolvedValue(['src/foo.ts', 'src/foo.ts', 'docs/notes.md']);
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT spec_path FROM pipeline_runs')) {
        return { spec_path: 'forge/specs/approved/spec-graph.json' };
      }
      if (sql.includes('INSERT INTO memories')) {
        return { id: 123 };
      }
      if (sql.includes('INSERT INTO wal_events')) {
        return {
          id: 999,
          event_type: 'memory_created',
          workspace_id: 'ws-1',
          spec_id: 'spec-graph',
          story_id: 'US-001',
          payload: '{}',
          ts: new Date().toISOString(),
        };
      }
      return undefined;
    });
  });

  it('stores source_spec_id and backfills related_files from known story file scope', async () => {
    await autoSynthesizeMemory(
      'US-001',
      'ws-1',
      'Implement provenance hardening',
      'Edited src/foo.ts and docs/notes.md',
      'passed',
      77,
    );

    expect(mockCollectStoryFileTouches).toHaveBeenCalledWith(77, 'US-001');

    const insertCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO memories'));
    expect(insertCall).toBeDefined();
    expect(String(insertCall![0])).toContain('source_spec_id');
    expect(insertCall![1]).toEqual([
      'ws-1',
      'Pattern',
      'Persist memory provenance from canonical sources.',
      'US-001',
      'spec-graph',
      77,
      'high',
      JSON.stringify(['src/foo.ts', 'docs/notes.md']),
      '[0.1,0.2]',
    ]);

    const walCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO wal_events'));
    expect(walCall).toBeDefined();
    expect(walCall![1]).toEqual([
      'memory_created',
      'ws-1',
      'spec-graph',
      'US-001',
      JSON.stringify({
        id: 123,
        text: 'Persist memory provenance from canonical sources.',
        category: 'Pattern',
        relatedFiles: ['src/foo.ts', 'docs/notes.md'],
        source_spec_id: 'spec-graph',
      }),
    ]);
    expect(mockBroadcastAll).toHaveBeenCalled();
  });
});

describe('isGitMemoryStale (CTM-005 freshness check)', () => {
  const NOW = 1_000_000_000_000;

  it('treats missing hydration as stale', () => {
    expect(isGitMemoryStale(null, NOW)).toBe(true);
    expect(isGitMemoryStale(undefined, NOW)).toBe(true);
    expect(isGitMemoryStale('not-a-date', NOW)).toBe(true);
  });

  it('treats hydration older than the threshold as stale', () => {
    const old = new Date(NOW - GIT_MEMORY_STALENESS_MS - 1).toISOString();
    expect(isGitMemoryStale(old, NOW)).toBe(true);
  });

  it('treats recent hydration as fresh', () => {
    const recent = new Date(NOW - 60_000).toISOString();
    expect(isGitMemoryStale(recent, NOW)).toBe(false);
  });

  it('honors a custom threshold', () => {
    const ts = new Date(NOW - 5_000).toISOString();
    expect(isGitMemoryStale(ts, NOW, 1_000)).toBe(true);
    expect(isGitMemoryStale(ts, NOW, 10_000)).toBe(false);
  });
});

describe('autoHydrateWorkspaceContext (CTM-005 hydration triggers)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHydrateSchema.mockReturnValue({ snapshot: 'CREATE TABLE x ();', tableNames: ['x'], fileCount: 1, migrationDir: '/m' });
    mockGitMapStep.mockResolvedValue([{ fromHash: 'a', toHash: 'b', commitCount: 3, summary: 'did things' }]);
    mockGitReduceStep.mockResolvedValue('# memory');
    mockGetLatestHash.mockReturnValue('b');
    mockQueryOne.mockResolvedValue(undefined);
    mockExecute.mockResolvedValue({ rowCount: 1 });
  });

  it('hydrates schema and git, persisting hydration timestamp', async () => {
    const result = await autoHydrateWorkspaceContext({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      workspaceLabel: 'Repo',
    });

    expect(mockHydrateSchema).toHaveBeenCalledWith('/repo');
    expect(mockGitMapStep).toHaveBeenCalledWith({ workspacePath: '/repo', fromHash: undefined });
    expect(result.schema).toEqual({ ok: true, tableCount: 1 });
    expect(result.git).toEqual({ ok: true, newCommits: 3, commitCount: 3 });

    const gitInsert = mockExecute.mock.calls.find(([sql]) => String(sql).includes('git_memory_hydrated_at'));
    expect(gitInsert).toBeDefined();
  });

  it('is non-fatal when git hydration throws', async () => {
    mockGitMapStep.mockRejectedValue(new Error('Not a git repository'));
    const result = await autoHydrateWorkspaceContext({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      workspaceLabel: 'Repo',
    });
    expect(result.git).toEqual({ ok: false, newCommits: 0, commitCount: 0 });
    expect(result.schema?.ok).toBe(true);
  });

  it('only hydrates requested types', async () => {
    await autoHydrateWorkspaceContext({
      workspaceId: 'ws-1',
      workspacePath: '/repo',
      workspaceLabel: 'Repo',
      types: ['schema'],
    });
    expect(mockHydrateSchema).toHaveBeenCalled();
    expect(mockGitMapStep).not.toHaveBeenCalled();
  });
});

describe('maybeRehydrateGitMemoryOnSpecGen (CTM-005 stale rehydration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGitMapStep.mockResolvedValue([{ fromHash: 'a', toHash: 'c', commitCount: 1, summary: 's' }]);
    mockGitReduceStep.mockResolvedValue('# memory');
    mockGetLatestHash.mockReturnValue('c');
    mockExecute.mockResolvedValue({ rowCount: 1 });
  });

  it('skips when HEAD is unchanged', async () => {
    mockQueryOne.mockResolvedValue({ last_ingested_commit_hash: 'c', git_commit_count: 5, git_memory_hydrated_at: null });
    mockGetCurrentHead.mockResolvedValue('c');

    const r = await maybeRehydrateGitMemoryOnSpecGen({ workspaceId: 'ws-1', workspacePath: '/repo', workspaceLabel: 'Repo' });
    expect(r).toEqual({ triggered: false, reason: 'head_unchanged' });
    expect(mockGitMapStep).not.toHaveBeenCalled();
  });

  it('skips when HEAD changed but memory is fresh', async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    mockQueryOne.mockResolvedValue({ last_ingested_commit_hash: 'a', git_commit_count: 5, git_memory_hydrated_at: fresh });
    mockGetCurrentHead.mockResolvedValue('c');

    const r = await maybeRehydrateGitMemoryOnSpecGen({ workspaceId: 'ws-1', workspacePath: '/repo', workspaceLabel: 'Repo' });
    expect(r).toEqual({ triggered: false, reason: 'fresh' });
    expect(mockGitMapStep).not.toHaveBeenCalled();
  });

  it('triggers rehydration when HEAD changed and memory is stale', async () => {
    mockQueryOne.mockResolvedValue({ last_ingested_commit_hash: 'a', git_commit_count: 5, git_memory_hydrated_at: null });
    mockGetCurrentHead.mockResolvedValue('c');

    const r = await maybeRehydrateGitMemoryOnSpecGen({ workspaceId: 'ws-1', workspacePath: '/repo', workspaceLabel: 'Repo' });
    expect(r).toEqual({ triggered: true, reason: 'stale_head_changed' });
    // Let the fire-and-forget hydration settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockGitMapStep).toHaveBeenCalled();
  });

  it('skips when HEAD cannot be resolved (not a repo)', async () => {
    mockQueryOne.mockResolvedValue(undefined);
    mockGetCurrentHead.mockResolvedValue(null);

    const r = await maybeRehydrateGitMemoryOnSpecGen({ workspaceId: 'ws-1', workspacePath: '/repo', workspaceLabel: 'Repo' });
    expect(r).toEqual({ triggered: false, reason: 'no_head' });
  });
});

describe('buildContextHealthSummary (CTM-005 health/readiness)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('reports absent + nudge when nothing is hydrated', async () => {
    mockQueryOne.mockResolvedValue(undefined);

    const s = await buildContextHealthSummary({ workspaceId: 'ws-1', workspacePath: '/repo' });
    expect(s.readiness).toBe('absent');
    expect(s.schemaPresent).toBe(false);
    expect(s.gitHydrated).toBe(false);
    expect(s.needsHydration).toBe(true);
    expect(s.nudge).toMatch(/has not been hydrated/i);
    expect(s.contextScore).toBe(0);
  });

  it('flags stale git memory with a non-blocking nudge', async () => {
    const old = new Date(Date.now() - GIT_MEMORY_STALENESS_MS - 1000).toISOString();
    mockQueryOne.mockResolvedValue({
      schema_snapshot: 'CREATE TABLE x ();',
      schema_snapshot_at: new Date().toISOString(),
      schema_table_count: 2,
      last_ingested_commit_hash: 'abc',
      git_commit_count: 10,
      git_memory_hydrated_at: old,
    });
    mockExistsSync.mockReturnValue(true);

    const s = await buildContextHealthSummary({ workspaceId: 'ws-1', workspacePath: '/repo' });
    expect(s.gitHydrated).toBe(true);
    expect(s.gitMemoryStale).toBe(true);
    expect(s.needsHydration).toBe(true);
    expect(s.nudge).toMatch(/stale/i);
  });

  it('reports ready with no nudge when fully hydrated and fresh', async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    mockQueryOne.mockResolvedValue({
      schema_snapshot: 'CREATE TABLE x ();',
      schema_snapshot_at: fresh,
      schema_table_count: 2,
      last_ingested_commit_hash: 'abc',
      git_commit_count: 10,
      git_memory_hydrated_at: fresh,
    });
    mockExistsSync.mockReturnValue(true);

    const s = await buildContextHealthSummary({ workspaceId: 'ws-1', workspacePath: '/repo' });
    expect(s.readiness).toBe('ready');
    expect(s.needsHydration).toBe(false);
    expect(s.nudge).toBeNull();
    expect(s.contextScore).toBe(100);
  });
});
