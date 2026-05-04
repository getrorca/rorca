/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { execute, queryOne, query } from '../../db/index';
import { truncateConflictSummary, emitMergeEvent } from '../../lib/emit-merge-event';

// ─── Mock SSE hub so broadcastAll is a no-op in tests ────────────────────────

jest.mock('../../lib/sse-hub', () => ({
  broadcastAll: jest.fn(),
}));

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(async () => {
  process.env.NODE_ENV = 'test';
  await execute(`DELETE FROM wal_events`);
});

afterEach(() => {
  delete process.env.NODE_ENV;
});

// ─── truncateConflictSummary unit tests ──────────────────────────────────────

describe('truncateConflictSummary', () => {
  it('returns empty string for null', () => {
    expect(truncateConflictSummary(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(truncateConflictSummary(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(truncateConflictSummary('')).toBe('');
  });

  it('returns string unchanged when under 2000 chars', () => {
    const short = 'conflict line\n'.repeat(10);
    expect(truncateConflictSummary(short)).toBe(short);
  });

  it('returns exactly 2000 chars when input is exactly 2000', () => {
    const exact = 'x'.repeat(2000);
    expect(truncateConflictSummary(exact)).toHaveLength(2000);
    expect(truncateConflictSummary(exact)).toBe(exact);
  });

  it('truncates to 2000 chars when input exceeds 2000', () => {
    const over = 'y'.repeat(3000);
    const result = truncateConflictSummary(over);
    expect(result).toHaveLength(2000);
    expect(result).toBe('y'.repeat(2000));
  });
});

// ─── emitMergeEvent integration tests ────────────────────────────────────────

describe('emitMergeEvent - worktree_merge_started', () => {
  it('inserts a worktree_merge_started event with correct payload', async () => {
    await emitMergeEvent(42, 'worktree_merge_started', {
      runId: 42,
      branch: 'feat/my-spec-1234',
      targetBranch: 'main',
    });

    const row = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'worktree_merge_started'`,
      [],
    );

    expect(row).toBeDefined();
    expect(row!.event_type).toBe('worktree_merge_started');

    const p = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect(p.runId).toBe(42);
    expect(p.branch).toBe('feat/my-spec-1234');
    expect(p.targetBranch).toBe('main');
  });
});

describe('emitMergeEvent - worktree_merged', () => {
  it('inserts a worktree_merged event including mergeCommitSha', async () => {
    await emitMergeEvent(7, 'worktree_merged', {
      runId: 7,
      branch: 'feat/another-1000',
      targetBranch: 'main',
      mergeCommitSha: 'abc123def456',
    });

    const row = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'worktree_merged'`,
      [],
    );

    expect(row).toBeDefined();
    const p = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect(p.mergeCommitSha).toBe('abc123def456');
    expect(p.runId).toBe(7);
    expect(p.targetBranch).toBe('main');
  });
});

describe('emitMergeEvent - worktree_merge_failed', () => {
  it('inserts a worktree_merge_failed event with short conflictSummary unchanged', async () => {
    await emitMergeEvent(99, 'worktree_merge_failed', {
      runId: 99,
      branch: 'feat/short-1',
      targetBranch: 'main',
      conflictSummary: 'CONFLICT: merge conflict in src/index.ts',
    });

    const row = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'worktree_merge_failed'`,
      [],
    );

    expect(row).toBeDefined();
    const p = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect(p.conflictSummary).toBe('CONFLICT: merge conflict in src/index.ts');
  });

  it('truncates conflictSummary to 2000 chars when too long', async () => {
    const bigDiff = 'CONFLICT line\n'.repeat(500); // ~7000 chars
    await emitMergeEvent(11, 'worktree_merge_failed', {
      runId: 11,
      branch: 'feat/big-conflict-2',
      targetBranch: 'main',
      conflictSummary: bigDiff,
    });

    const row = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'worktree_merge_failed'`,
      [],
    );

    expect(row).toBeDefined();
    const p = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect((p.conflictSummary as string).length).toBe(2000);
  });

  it('handles empty conflictSummary', async () => {
    await emitMergeEvent(55, 'worktree_merge_failed', {
      runId: 55,
      branch: 'feat/empty-conflict-3',
      targetBranch: 'main',
      conflictSummary: '',
    });

    const row = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'worktree_merge_failed'`,
      [],
    );

    expect(row).toBeDefined();
    const p = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect(p.conflictSummary).toBe('');
  });

  it('handles conflictSummary of exactly 2000 chars without truncation', async () => {
    const exact2000 = 'z'.repeat(2000);
    await emitMergeEvent(77, 'worktree_merge_failed', {
      runId: 77,
      branch: 'feat/exact-boundary-4',
      targetBranch: 'main',
      conflictSummary: exact2000,
    });

    const row = await queryOne<{ event_type: string; payload: unknown }>(
      `SELECT event_type, payload FROM wal_events WHERE event_type = 'worktree_merge_failed'`,
      [],
    );

    expect(row).toBeDefined();
    const p = typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload;
    expect((p.conflictSummary as string).length).toBe(2000);
  });
});

describe('emitMergeEvent - multiple events in sequence', () => {
  it('all three event types are queryable after insertion', async () => {
    await emitMergeEvent(1, 'worktree_merge_started', {
      runId: 1, branch: 'feat/seq-1', targetBranch: 'main',
    });
    await emitMergeEvent(1, 'worktree_merged', {
      runId: 1, branch: 'feat/seq-1', targetBranch: 'main', mergeCommitSha: 'deadbeef',
    });
    await emitMergeEvent(2, 'worktree_merge_failed', {
      runId: 2, branch: 'feat/seq-2', targetBranch: 'main', conflictSummary: 'conflict',
    });

    const rows = await query<{ event_type: string }>(
      `SELECT event_type FROM wal_events ORDER BY id`,
      [],
    );

    const types = rows.map((r) => r.event_type);
    expect(types).toContain('worktree_merge_started');
    expect(types).toContain('worktree_merged');
    expect(types).toContain('worktree_merge_failed');
  });
});
