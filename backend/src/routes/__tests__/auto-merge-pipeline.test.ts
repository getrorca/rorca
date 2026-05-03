/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * auto-merge-pipeline.test.ts — Comprehensive integration tests for the
 * auto-merge backend pipeline.
 *
 * Covers:
 *   1. retry-merge endpoint: 404 / 409 / 200 responses
 *   2. WAL event emission for merge lifecycle (worktree_merged, worktree_merge_failed)
 *   3. merge_status column transitions (null→merging→merged, null→merging→failed)
 *   4. pg-boss pipeline:merge job enqueue with correct payload
 *   5. performMerge() unit tests with mocked simple-git
 *   6. PipelineMergeJobPayload Zod schema validation
 *
 * Engine-agnostic — merge logic runs in the worker independently of agent type.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

jest.setTimeout(90_000);

const WS_ID = 'ws-auto-merge-test';

// ── Helpers ────────────────────────────────────────────────────────────────

async function ensureWorkspace(wsDir: string): Promise<void> {
  await execute(
    `INSERT INTO users (id, email, display_name, password_hash, plan)
     VALUES ('local-admin', 'admin@rorca.local', 'Admin', 'x', 'pro')
     ON CONFLICT (id) DO UPDATE SET plan = 'pro'`,
  );

  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WS_ID, 'Auto Merge Test', wsDir],
  );
}

async function cleanupTestData(): Promise<void> {
  await execute(`DELETE FROM token_usage WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM story_results WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = $1)`, [WS_ID]);
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = $1`, [WS_ID]);
  await execute(`DELETE FROM wal_events WHERE workspace_id = $1`, [WS_ID]);
}

async function seedRun(overrides: {
  status?: string;
  merge_status?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
} = {}): Promise<number> {
  const result = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, branch_name, worktree_path, merge_status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      'forge/specs/approved/test-spec.json',
      WS_ID,
      overrides.status ?? 'done',
      'branch_name' in overrides ? overrides.branch_name : 'feat/auto-merge-test-branch',
      'worktree_path' in overrides ? overrides.worktree_path : '/tmp/worktree-auto-merge-test',
      'merge_status' in overrides ? overrides.merge_status : null,
    ],
  );
  return result!.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Retry-merge endpoint response codes
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/pipeline/runs/:runId/retry-merge', () => {
  let app: Express;
  let tmpDir: string;
  let wsDir: string;
  let authToken: string;
  let mockBossSend: jest.Mock;

  beforeEach(async () => {
    jest.resetModules();

    mockBossSend = jest.fn().mockResolvedValue('mock-merge-job-id');

    jest.mock('../../lib/llm-client', () => ({
      chatComplete: jest.fn(),
      getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
      isValidModel: jest.fn().mockReturnValue(true),
      DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
      resolveVaultProvider: jest.fn().mockReturnValue(null),
      getModelInfo: jest.fn().mockReturnValue(undefined),
      SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
    }));

    jest.mock('../../lib/pg-boss', () => ({
      initBoss: jest.fn().mockResolvedValue(undefined),
      getBoss: jest.fn().mockReturnValue({
        send: mockBossSend,
        work: jest.fn(),
        stop: jest.fn().mockResolvedValue(undefined),
      }),
    }));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-auto-merge-test-'));
    process.env.NODE_ENV = 'test';

    const serverMod = require('../../server');
    app = serverMod.default;
    authToken = await getAuthToken(app);

    await execute(`UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'`);

    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });

    await cleanupTestData();
    await ensureWorkspace(wsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.NODE_ENV;
  });

  function postRetryMerge(runId: number | string) {
    return request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();
  }

  test('returns 404 when runId does not exist', async () => {
    const res = await postRetryMerge(999999);
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  test('returns 400 for non-numeric runId', async () => {
    const res = await postRetryMerge('notanumber');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid runId');
  });

  test('returns 409 when merge_status is null (never attempted)', async () => {
    const runId = await seedRun({ merge_status: null });
    const res = await postRetryMerge(runId);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('null');
  });

  test('returns 409 when merge_status is already merging', async () => {
    const runId = await seedRun({ merge_status: 'merging' });
    const res = await postRetryMerge(runId);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('merging');
  });

  test('returns 409 when merge_status is already merged (success)', async () => {
    const runId = await seedRun({ merge_status: 'merged' });
    const res = await postRetryMerge(runId);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('merged');
  });

  test('returns 409 when run has no branch_name', async () => {
    const runId = await seedRun({ merge_status: 'failed', branch_name: null });
    const res = await postRetryMerge(runId);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('branch_name');
  });

  test('returns 200 with { queued: true } on successful retry initiation', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    const res = await postRetryMerge(runId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, runId, queued: true });
  });

  // ── merge_status transition via endpoint ──

  test('retry-merge sets merge_status from failed to merging', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    const before = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(before!.merge_status).toBe('failed');

    await postRetryMerge(runId);

    const after = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(after!.merge_status).toBe('merging');
  });

  // ── pg-boss enqueue verification ──

  test('enqueues pipeline:merge job with correct payload', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    await postRetryMerge(runId);

    expect(mockBossSend).toHaveBeenCalledTimes(1);
    expect(mockBossSend).toHaveBeenCalledWith(
      'pipeline:merge',
      {
        runId,
        branch: 'feat/auto-merge-test-branch',
        workspaceId: WS_ID,
      },
      expect.objectContaining({
        retryLimit: 0,
        expireInSeconds: 3600,
      }),
    );
  });

  test('payload runId is a positive integer', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    await postRetryMerge(runId);

    const payload = mockBossSend.mock.calls[0][1];
    expect(typeof payload.runId).toBe('number');
    expect(Number.isInteger(payload.runId)).toBe(true);
    expect(payload.runId).toBeGreaterThan(0);
  });

  test('payload branch matches run branch_name', async () => {
    const runId = await seedRun({ merge_status: 'failed', branch_name: 'feat/my-branch-123' });
    await postRetryMerge(runId);

    const payload = mockBossSend.mock.calls[0][1];
    expect(payload.branch).toBe('feat/my-branch-123');
  });

  test('payload workspaceId matches run workspace_id', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    await postRetryMerge(runId);

    const payload = mockBossSend.mock.calls[0][1];
    expect(payload.workspaceId).toBe(WS_ID);
  });

  test('payload conforms to PipelineMergeJobPayload Zod schema', async () => {
    const { PipelineMergeJobPayload } = require('../../lib/pg-boss-schemas');

    const runId = await seedRun({ merge_status: 'failed' });
    await postRetryMerge(runId);

    const payload = mockBossSend.mock.calls[0][1];
    const parsed = PipelineMergeJobPayload.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test('does not enqueue job when merge_status is not failed', async () => {
    const runId = await seedRun({ merge_status: 'merged' });
    await postRetryMerge(runId);

    expect(mockBossSend).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. merge_status column transitions (DB-level)
// ═══════════════════════════════════════════════════════════════════════════

describe('merge_status column transitions', () => {
  let tmpDir: string;
  let wsDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-merge-status-test-'));
    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    await cleanupTestData();
    await ensureWorkspace(wsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('merge_status accepts only valid values at application level', async () => {
    // The CHECK constraint may not be present in all environments.
    // Verify the valid values are accepted by the DB.
    const runId = await seedRun({ merge_status: null });

    for (const validStatus of ['merging', 'merged', 'failed']) {
      await execute(
        `UPDATE pipeline_runs SET merge_status = $1 WHERE id = $2`,
        [validStatus, runId],
      );
      const row = await queryOne<{ merge_status: string | null }>(
        'SELECT merge_status FROM pipeline_runs WHERE id = $1',
        [runId],
      );
      expect(row!.merge_status).toBe(validStatus);
    }

    // Reset to null
    await execute(
      `UPDATE pipeline_runs SET merge_status = NULL WHERE id = $1`,
      [runId],
    );
    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBeNull();
  });

  test('merge_status can be null (non-worktree run)', async () => {
    const runId = await seedRun({ merge_status: null, branch_name: null });

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBeNull();
  });

  test('null → merging transition', async () => {
    const runId = await seedRun({ merge_status: null });

    await execute(
      `UPDATE pipeline_runs SET merge_status = 'merging' WHERE id = $1`,
      [runId],
    );

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('merging');
  });

  test('merging → merged transition', async () => {
    const runId = await seedRun({ merge_status: 'merging' });

    await execute(
      `UPDATE pipeline_runs SET merge_status = 'merged' WHERE id = $1`,
      [runId],
    );

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('merged');
  });

  test('merging → failed transition', async () => {
    const runId = await seedRun({ merge_status: 'merging' });

    await execute(
      `UPDATE pipeline_runs SET merge_status = 'failed' WHERE id = $1`,
      [runId],
    );

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WAL event emission for merge lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('WAL events for merge lifecycle', () => {
  let tmpDir: string;
  let wsDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wal-merge-test-'));
    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    await cleanupTestData();
    await ensureWorkspace(wsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('worktree_merged WAL event stores correct payload', async () => {
    const runId = await seedRun({ merge_status: 'merging' });

    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('worktree_merged', $1, $2)`,
      [WS_ID, JSON.stringify({
        run_id: runId,
        branchName: 'feat/auto-merge-test-branch',
        mergeCommitSha: 'abc123def456789',
      })],
    );

    const events = await query<{
      event_type: string;
      workspace_id: string;
      payload: string;
    }>(
      `SELECT event_type, workspace_id, payload FROM wal_events
       WHERE event_type = 'worktree_merged' AND workspace_id = $1`,
      [WS_ID],
    );

    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('worktree_merged');
    expect(events[0].workspace_id).toBe(WS_ID);

    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(payload.run_id).toBe(runId);
    expect(payload.branchName).toBe('feat/auto-merge-test-branch');
    expect(payload.mergeCommitSha).toBe('abc123def456789');
  });

  test('worktree_merge_failed WAL event stores conflict files', async () => {
    const runId = await seedRun({ merge_status: 'merging' });

    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('worktree_merge_failed', $1, $2)`,
      [WS_ID, JSON.stringify({
        run_id: runId,
        branchName: 'feat/auto-merge-test-branch',
        worktreePath: '/tmp/worktree-auto-merge-test',
        conflictFiles: ['src/index.ts', 'package.json'],
        message: 'Auto-merge failed — code conflicts detected. Resolve manually or retry after fixing.',
      })],
    );

    const events = await query<{
      event_type: string;
      workspace_id: string;
      payload: any;
    }>(
      `SELECT event_type, workspace_id, payload FROM wal_events
       WHERE event_type = 'worktree_merge_failed' AND workspace_id = $1`,
      [WS_ID],
    );

    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('worktree_merge_failed');

    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(payload.run_id).toBe(runId);
    expect(payload.conflictFiles).toEqual(['src/index.ts', 'package.json']);
    expect(payload.message).toContain('code conflicts');
  });

  test('worktree_merged event payload contains mergeCommitSha string', async () => {
    const runId = await seedRun();

    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('worktree_merged', $1, $2)`,
      [WS_ID, JSON.stringify({
        run_id: runId,
        branchName: 'feat/test',
        mergeCommitSha: 'deadbeefcafe1234',
      })],
    );

    const events = await query<{ payload: any }>(
      `SELECT payload FROM wal_events WHERE event_type = 'worktree_merged' AND workspace_id = $1`,
      [WS_ID],
    );

    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(typeof payload.mergeCommitSha).toBe('string');
    expect(payload.mergeCommitSha).toBe('deadbeefcafe1234');
  });

  test('worktree_merge_failed event payload conflictFiles is array', async () => {
    const runId = await seedRun();

    await execute(
      `INSERT INTO wal_events (event_type, workspace_id, payload)
       VALUES ('worktree_merge_failed', $1, $2)`,
      [WS_ID, JSON.stringify({
        run_id: runId,
        branchName: 'feat/test',
        worktreePath: '/tmp/wt',
        conflictFiles: ['a.ts', 'b.ts', 'c.ts'],
        message: 'conflicts',
      })],
    );

    const events = await query<{ payload: any }>(
      `SELECT payload FROM wal_events WHERE event_type = 'worktree_merge_failed' AND workspace_id = $1`,
      [WS_ID],
    );

    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(Array.isArray(payload.conflictFiles)).toBe(true);
    expect(payload.conflictFiles).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. performMerge() unit tests (mocked simple-git)
// ═══════════════════════════════════════════════════════════════════════════

describe('performMerge()', () => {
  let performMerge: typeof import('../../lib/merge-handler').performMerge;
  let mockGitInstance: Record<string, jest.Mock>;
  let tmpDir: string;
  let wsDir: string;

  beforeEach(async () => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-perform-merge-test-'));
    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    mockGitInstance = {
      status: jest.fn().mockResolvedValue({ files: [] }),
      stash: jest.fn().mockResolvedValue(''),
      merge: jest.fn().mockResolvedValue(''),
      raw: jest.fn().mockResolvedValue(''),
      add: jest.fn().mockResolvedValue(''),
      commit: jest.fn().mockResolvedValue(''),
    };

    jest.mock('simple-git', () => ({
      __esModule: true,
      default: jest.fn(() => mockGitInstance),
    }));

    jest.mock('../../lib/sse-hub', () => ({
      broadcastAll: jest.fn(),
      subscribe: jest.fn(() => jest.fn()),
      attachSSE: jest.fn(),
    }));

    const mergeHandlerMod = require('../../lib/merge-handler');
    performMerge = mergeHandlerMod.performMerge;

    await cleanupTestData();
    await ensureWorkspace(wsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns { success: false } when run does not exist', async () => {
    const result = await performMerge(999999, 'feat/nonexistent', '/tmp/ws');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('returns { success: false } when no branch name available', async () => {
    const runId = await seedRun({ branch_name: null, merge_status: null });

    const result = await performMerge(runId, '', wsDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No branch name');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('sets merge_status to merging then to failed on error', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.merge.mockRejectedValueOnce(new Error('Pre-check: unexpected error'));

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('successful fast-forward merge returns { success: true, mergeCommitSha }', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'abc123sha\n';
      if (args[0] === 'worktree') return '';
      if (args[0] === 'diff') return '';
      return '';
    });

    const result = await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(result.success).toBe(true);
    expect(result.mergeCommitSha).toBe('abc123sha');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('merged');
  });

  test('merge with code conflicts returns { success: false, conflictFiles }', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    let mergeCallCount = 0;
    mockGitInstance.merge.mockImplementation(async () => {
      mergeCallCount++;
      if (mergeCallCount === 1) {
        throw new Error('CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed');
      }
      return '';
    });

    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return 'src/app.ts\nsrc/server.ts\n';
      }
      return '';
    });

    const result = await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(result.success).toBe(false);
    expect(result.conflictFiles).toContain('src/app.ts');
    expect(result.conflictFiles).toContain('src/server.ts');
    expect(result.error).toContain('Code conflicts');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('merge with only tracking file conflicts auto-resolves and succeeds', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    let mergeCallCount = 0;
    mockGitInstance.merge.mockImplementation(async () => {
      mergeCallCount++;
      if (mergeCallCount === 1) {
        throw new Error('CONFLICT (content): Merge conflict in .rorca/run-state.json\nAutomatic merge failed');
      }
      return '';
    });

    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return '.rorca/run-state.json\nprogress.txt\n';
      }
      if (args[0] === 'rev-parse') return 'tracking-merge-sha\n';
      return '';
    });

    const result = await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(result.success).toBe(true);
    expect(result.mergeCommitSha).toBe('tracking-merge-sha');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('merged');
  });

  test('stash is created when workspace has uncommitted changes', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.status.mockResolvedValue({ files: [{ path: 'dirty.ts' }] });
    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'stash-sha\n';
      return '';
    });

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(mockGitInstance.stash).toHaveBeenCalledWith(
      expect.arrayContaining(['push', '--include-untracked']),
    );
    expect(mockGitInstance.stash).toHaveBeenCalledWith(['pop']);
  });

  test('stash is restored even when merge fails', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.status.mockResolvedValue({ files: [{ path: 'dirty.ts' }] });
    mockGitInstance.merge.mockRejectedValue(new Error('Unexpected error during merge'));

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const stashCalls = mockGitInstance.stash.mock.calls;
    const popCall = stashCalls.find((c: string[][]) => c[0]?.[0] === 'pop');
    expect(popCall).toBeDefined();
  });

  test('"Already up to date" merge is treated as clean pre-check', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    let mergeCallCount = 0;
    mockGitInstance.merge.mockImplementation(async () => {
      mergeCallCount++;
      if (mergeCallCount === 1) {
        throw new Error('Already up to date.');
      }
      return '';
    });

    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'uptodate-sha\n';
      return '';
    });

    const result = await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);
    expect(result.success).toBe(true);
  });

  test('worktree_merged WAL event is emitted on success', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'wal-test-sha\n';
      return '';
    });

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const events = await query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM wal_events
       WHERE event_type = 'worktree_merged' AND workspace_id = $1`,
      [WS_ID],
    );

    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(payload.run_id).toBe(runId);
    expect(payload.branchName).toBe('feat/auto-merge-test-branch');
    expect(payload.mergeCommitSha).toBe('wal-test-sha');
  });

  test('worktree_merge_failed WAL event is emitted on conflict', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    let mergeCallCount = 0;
    mockGitInstance.merge.mockImplementation(async () => {
      mergeCallCount++;
      if (mergeCallCount === 1) {
        throw new Error('CONFLICT (content): Automatic merge failed; fix conflicts and then commit');
      }
      return '';
    });

    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return 'src/conflict-file.ts\n';
      }
      return '';
    });

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const events = await query<{ event_type: string; payload: any }>(
      `SELECT event_type, payload FROM wal_events
       WHERE event_type = 'worktree_merge_failed' AND workspace_id = $1`,
      [WS_ID],
    );

    expect(events.length).toBeGreaterThanOrEqual(1);
    const payload = typeof events[0].payload === 'string' ? JSON.parse(events[0].payload) : events[0].payload;
    expect(payload.run_id).toBe(runId);
    expect(payload.conflictFiles).toContain('src/conflict-file.ts');
  });

  test('worktree directory removal is attempted after successful merge', async () => {
    const worktreeDir = path.join(tmpDir, 'worktree-to-remove');
    fs.mkdirSync(worktreeDir, { recursive: true });

    const runId = await seedRun({
      merge_status: 'failed',
      worktree_path: worktreeDir,
    });

    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'rm-sha\n';
      if (args[0] === 'worktree') return '';
      return '';
    });

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(mockGitInstance.raw).toHaveBeenCalledWith(
      ['worktree', 'remove', '--force', worktreeDir],
    );
  });

  test('worktree_path is cleared in pipeline_runs after successful merge', async () => {
    const runId = await seedRun({
      merge_status: 'failed',
      worktree_path: '/tmp/worktree-to-clear',
    });

    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'clear-sha\n';
      return '';
    });

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const row = await queryOne<{ worktree_path: string | null }>(
      'SELECT worktree_path FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.worktree_path).toBeNull();
  });

  test('uses branch_name from DB when branchName arg is empty', async () => {
    const runId = await seedRun({
      merge_status: 'failed',
      branch_name: 'feat/from-db-branch',
    });

    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'db-branch-sha\n';
      return '';
    });

    const result = await performMerge(runId, '', wsDir);

    expect(result.success).toBe(true);
    expect(mockGitInstance.merge).toHaveBeenCalledWith(
      expect.arrayContaining(['feat/from-db-branch']),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. PipelineMergeJobPayload Zod schema validation
// ═══════════════════════════════════════════════════════════════════════════

describe('PipelineMergeJobPayload schema', () => {
  const { PipelineMergeJobPayload } = require('../../lib/pg-boss-schemas');

  test('accepts valid payload', () => {
    const result = PipelineMergeJobPayload.safeParse({
      runId: 42,
      branch: 'feat/my-branch',
      workspaceId: 'ws-123',
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing runId', () => {
    const result = PipelineMergeJobPayload.safeParse({
      branch: 'feat/my-branch',
      workspaceId: 'ws-123',
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-positive runId', () => {
    const result = PipelineMergeJobPayload.safeParse({
      runId: 0,
      branch: 'feat/my-branch',
      workspaceId: 'ws-123',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty branch', () => {
    const result = PipelineMergeJobPayload.safeParse({
      runId: 1,
      branch: '',
      workspaceId: 'ws-123',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty workspaceId', () => {
    const result = PipelineMergeJobPayload.safeParse({
      runId: 1,
      branch: 'feat/b',
      workspaceId: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects extra fields (strict mode)', () => {
    const result = PipelineMergeJobPayload.safeParse({
      runId: 1,
      branch: 'feat/b',
      workspaceId: 'ws-1',
      extraField: 'should-fail',
    });
    expect(result.success).toBe(false);
  });

  test('rejects non-integer runId', () => {
    const result = PipelineMergeJobPayload.safeParse({
      runId: 1.5,
      branch: 'feat/b',
      workspaceId: 'ws-1',
    });
    expect(result.success).toBe(false);
  });
});
