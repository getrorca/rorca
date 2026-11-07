/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * US-010: Integration tests verifying git_memory column removal.
 *
 * Acceptance criteria:
 * (a) synthesize() and synthesizeDirectionStack() never produce '=== PROJECT MEMORY (Git History) ===' block
 * (b) memories table entries with source='git_hydration' ARE retrievable via memory-router.ts
 */

import { clearAll as clearContextCache } from '../context-cache';
import { synthesize, synthesizeDirectionStack } from '../direction-stack';

// ─── Mock DB + search ────────────────────────────────────────────────────────

const mockQueryOne = jest.fn();
const mockQuery = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  query: (...args: unknown[]) => mockQuery(...args),
}));

jest.mock('../search', () => ({
  hybridSearch: jest.fn().mockResolvedValue([]),
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── Default DB mock: workspace_context has NO git_memory column data ─────────

function setupMinimalDb(opts: {
  schemaSnapshot?: string;
  memories?: Array<{ content: string; created_at: string; source?: string }>;
} = {}) {
  mockQueryOne.mockImplementation((sql: string) => {
    if (sql.includes('layer = 1')) return undefined;
    if (sql.includes('layer = 2')) return undefined;
    if (sql.includes('layer = 3')) return undefined;
    if (sql.includes('workspaces') && sql.includes('domain')) return undefined;
    // workspace_context: only schema_snapshot — git_memory column is gone
    if (sql.includes('workspace_context')) return { schema_snapshot: opts.schemaSnapshot ?? null };
    if (sql.includes('workspace_access')) return undefined;
    if (sql.includes('COUNT') && sql.includes('embeddings')) return { cnt: '0' };
    if (sql.includes('COUNT') && sql.includes('wal_events')) return { cnt: String(opts.memories?.length ?? 0) };
    return undefined;
  });

  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('memories')) return opts.memories ?? [];
    if (sql.includes('wal_events') && sql.includes('memory_created')) return [];
    if (sql.includes('installed_skills')) return [];
    return [];
  });
}

// ─── (a) synthesize() sync path ──────────────────────────────────────────────

describe('US-010: git_memory column removal — synthesize() sync path', () => {
  it('never emits PROJECT MEMORY (Git History) block regardless of inputs', () => {
    const result = synthesize({
      l1: 'global standards',
      l2: 'domain profile',
      l3: 'project context',
      schemaSnapshot: 'CREATE TABLE users (id TEXT PRIMARY KEY);',
      specBrief: 'build auth feature',
    });

    expect(result).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });

  it('synthesize() SynthesizeParams no longer accepts gitMemory field', () => {
    // Type-level: calling synthesize with an unknown field should not affect output.
    // At runtime, extra properties are ignored; the block must not appear.
    const params: Record<string, unknown> = {
      specBrief: 'build feature',
      schemaSnapshot: 'CREATE TABLE t (id TEXT);',
      gitMemory: 'this should be ignored',
    };
    // Cast to any to simulate old callers passing gitMemory inadvertently
    const result = synthesize(params as unknown as Parameters<typeof synthesize>[0]);
    expect(result).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });
});

// ─── (a) synthesizeDirectionStack() async path ───────────────────────────────

describe('US-010: git_memory column removal — synthesizeDirectionStack() async path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearContextCache();
    setupMinimalDb();
  });

  it('returns context without PROJECT MEMORY (Git History) block', async () => {
    const result = await synthesizeDirectionStack('ws-test');
    expect(result.text).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });

  it('droppedItems does not include git_memory type', async () => {
    setupMinimalDb({ schemaSnapshot: 'a'.repeat(1600) }); // schema is large

    // Tight budget so schema would be dropped
    const result = await synthesizeDirectionStack('ws-test', { maxTokens: 10 });

    expect(result.text).not.toContain('=== PROJECT MEMORY (Git History) ===');
    const gitMemoryDropped = result.metadata.droppedItems.some(d => d.type === 'git_memory');
    expect(gitMemoryDropped).toBe(false);
  });

  it('workspace_context query does not select git_memory column', async () => {
    await synthesizeDirectionStack('ws-test');

    // Find calls that touched workspace_context
    const wsCtxCalls = mockQueryOne.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('workspace_context'),
    );

    for (const call of wsCtxCalls) {
      const sql = call[0] as string;
      expect(sql).not.toContain('git_memory');
    }
  });
});

// ─── (b) git_hydration memories ARE retrievable ──────────────────────────────

describe('US-010: git_hydration memories retrievable via memories table', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearContextCache();
  });

  it('memories with source=git_hydration appear in synthesized context', async () => {
    setupMinimalDb({
      memories: [
        {
          content: 'Convention: always use async/await over callbacks',
          created_at: new Date().toISOString(),
          source: 'git_hydration',
        },
        {
          content: 'Bug fix: fixed race condition in worker init',
          created_at: new Date().toISOString(),
          source: 'git_hydration',
        },
      ],
    });

    const result = await synthesizeDirectionStack('ws-test');

    // Memory entries from the memories table ARE included
    expect(result.metadata.memoryEntries.included).toBeGreaterThan(0);
    expect(result.text).toContain('RELEVANT MEMORY');
  });

  it('synthesizeDirectionStack completes successfully after git_memory column removal', async () => {
    setupMinimalDb();

    // Must not throw, must return valid structure
    const result = await synthesizeDirectionStack('ws-test', {
      storyText: 'Add user authentication endpoint',
    });

    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('metadata');
    expect(result.metadata).toHaveProperty('totalTokens');
    expect(result.metadata).toHaveProperty('droppedItems');
    expect(typeof result.text).toBe('string');
    expect(result.text).not.toContain('=== PROJECT MEMORY (Git History) ===');
  });
});
