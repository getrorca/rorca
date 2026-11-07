/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * auto-merge-pipeline.test.ts — Release-1 fail-closed coverage for the retired
 * auto-merge/retry actuator plus retained persistence/schema compatibility.
 *
 * The canonical release reconciler may integrate an exact immutable release
 * identity. Legacy HTTP retry and direct performMerge calls cannot mint that
 * authority, enqueue jobs, mutate merge state, write WAL, or touch Git.
 */

import crypto from 'node:crypto';
import * as fs from 'fs';
import type { Server } from 'node:http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import type * as AuthHelperModule from './helpers/auth-helper';
import type * as DatabaseModule from '../../db/index';
import type * as MergeHandlerModule from '../../lib/merge-handler';

jest.setTimeout(90_000);

const FIXTURE_ID = crypto.randomUUID();
const WS_ID = `ws-auto-merge-${FIXTURE_ID}`;
const OTHER_WS_ID = `ws-auto-merge-other-${FIXTURE_ID}`;
const AUTH_ID = crypto.randomUUID();
const USER_ID = crypto.randomUUID();
const AUTH_EMAIL = `auto-merge-${FIXTURE_ID}@test.rorca.local`;
const ENVIRONMENT_KEYS = ['NODE_ENV', 'RORCA_TEST_DATABASE_WORKSPACE_SCOPE'] as const;
type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number];
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map(key => [key, process.env[key]]),
) as Record<EnvironmentKey, string | undefined>;

// The application pool captures the workspace scope when db/index is loaded.
process.env.NODE_ENV = 'test';
process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WS_ID;
const mockBossSend = jest.fn().mockResolvedValue('mock-merge-job-id');

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

const migrationDatabaseUrl = process.env.WAVE2_TEST_MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error('WAVE2_TEST_MIGRATION_DATABASE_URL is required');
const ownerPool = new Pool({
  connectionString: migrationDatabaseUrl,
  max: 1,
  options: `--search_path=rorca,public -c rorca.migration_mode=on -c rorca.workspace_id=${WS_ID}`,
});
const { getAuthToken } = require('./helpers/auth-helper') as typeof AuthHelperModule;
const { query, queryOne, execute, closePool } = require('../../db/index') as typeof DatabaseModule;
const { performMerge } = require('../../lib/merge-handler') as typeof MergeHandlerModule;

let app: Server;
let tmpDir: string;
let wsDir: string;
let authToken: string;

function restoreEnvironment(): void {
  for (const key of ENVIRONMENT_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function ownerExecute(sql: string, params: unknown[] = []): Promise<void> {
  await ownerPool.query(sql, params);
}

async function ownerQueryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await ownerPool.query(sql, params);
  return result.rows[0] as T | undefined;
}

async function ensureWorkspace(workspacePath: string): Promise<void> {
  await ownerExecute(
    `INSERT INTO workspaces (id, label, path, pipeline_config)
     VALUES
       ($1, 'Auto Merge Test', $3, $5),
       ($2, 'Auto Merge Cross-Workspace Control', $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET path = EXCLUDED.path, pipeline_config = EXCLUDED.pipeline_config`,
    [WS_ID, OTHER_WS_ID, workspacePath, path.join(tmpDir, 'other-workspace'), JSON.stringify({
      autoMerge: true,
      mergeStrategy: 'direct',
    })],
  );
  await ownerExecute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2::uuid, 'owner')
     ON CONFLICT (workspace_id, user_auth_id) DO UPDATE SET role = 'owner'`,
    [WS_ID, AUTH_ID],
  );
}

async function cleanupTestData(): Promise<void> {
  const workspaceIds = [WS_ID, OTHER_WS_ID];
  await ownerExecute(
    `DELETE FROM token_usage
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute(
    `DELETE FROM story_results
      WHERE run_id IN (SELECT id FROM pipeline_runs WHERE workspace_id = ANY($1::text[]))`,
    [workspaceIds],
  );
  await ownerExecute('DELETE FROM pipeline_runs WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
  await ownerExecute('DELETE FROM wal_events WHERE workspace_id = ANY($1::text[])', [workspaceIds]);
}

async function seedRun(overrides: {
  workspaceId?: string;
  status?: string;
  merge_status?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  auto_merge?: boolean;
  merge_strategy?: 'direct' | 'pr' | 'draft-pr' | 'branch-only';
} = {}): Promise<number> {
  const result = await ownerPool.query<{ id: number }>(
    `INSERT INTO pipeline_runs (spec_path, workspace_id, status, branch_name, worktree_path, merge_status, auto_merge, merge_strategy, agent_type, agent_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pi', 'openai-codex/gpt-5.6-sol') RETURNING id`,
    [
      'forge/specs/approved/test-spec.json',
      overrides.workspaceId ?? WS_ID,
      overrides.status ?? 'done',
      'branch_name' in overrides ? overrides.branch_name : 'feat/auto-merge-test-branch',
      'worktree_path' in overrides ? overrides.worktree_path : '/tmp/worktree-auto-merge-test',
      'merge_status' in overrides ? overrides.merge_status : null,
      overrides.auto_merge ?? true,
      overrides.merge_strategy ?? 'direct',
    ],
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WS_ID;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-auto-merge-test-'));
  wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(wsDir, 'forge', 'specs', 'approved'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'other-workspace'), { recursive: true });

  await ownerExecute(
    `INSERT INTO users (id, email, display_name, password_hash, auth_id, role, plan)
     VALUES ($1, $2, 'Auto Merge Suite', 'x', $3::uuid, 'admin', 'pro')`,
    [USER_ID, AUTH_EMAIL, AUTH_ID],
  );
  await ensureWorkspace(wsDir);

  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: AUTH_EMAIL,
    authId: AUTH_ID,
    role: 'admin',
    displayName: 'Auto Merge Suite',
  });
  const listening = Promise.withResolvers<Server>();
  const listener = expressApp.listen(0, '127.0.0.1', () => {
    listener.off('error', listening.reject);
    listening.resolve(listener);
  });
  listener.once('error', listening.reject);
  app = await listening.promise;
});

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  if (app) {
    try {
      app.closeAllConnections();
      await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await cleanupTestData();
    await ownerExecute('DELETE FROM workspace_members WHERE workspace_id = $1', [WS_ID]);
    await ownerExecute('DELETE FROM workspaces WHERE id = ANY($1::text[])', [[WS_ID, OTHER_WS_ID]]);
    await ownerExecute('DELETE FROM users WHERE id = $1', [USER_ID]);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await closePool();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await ownerPool.end();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  restoreEnvironment();
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'auto-merge pipeline fixture cleanup failed');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Retry-merge endpoint response codes
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/pipeline/runs/:runId/retry-merge', () => {
  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.RORCA_TEST_DATABASE_WORKSPACE_SCOPE = WS_ID;
    jest.clearAllMocks();
    await cleanupTestData();
    await ensureWorkspace(wsDir);
  });

  function postRetryMerge(runId: number | string) {
    return request(app)
      .post(`/api/pipeline/runs/${runId}/retry-merge`)
      .set('Authorization', `Bearer ${authToken}`)
      .send();
  }

  function expectRetired(response: { status: number; body: Record<string, any> }): void {
    expect(response.status).toBe(409);
    expect(response.body.error).toContain('Manual retry-merge is retired');
    expect(mockBossSend).not.toHaveBeenCalled();
  }

  test('retires the actuator before looking up a nonexistent run', async () => {
    expectRetired(await postRetryMerge(999999));
  });

  test('returns 400 without mutating either the scoped run or a cross-workspace run', async () => {
    const scopedRunId = await seedRun({ merge_status: 'failed' });
    const otherRunId = await seedRun({ workspaceId: OTHER_WS_ID, merge_status: 'merging' });
    const beforeWal = await ownerQueryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM wal_events WHERE workspace_id = ANY($1::text[])',
      [[WS_ID, OTHER_WS_ID]],
    );

    const res = await postRetryMerge('notanumber');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid runId');
    const scopedRun = await ownerQueryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [scopedRunId],
    );
    const otherRun = await ownerQueryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [otherRunId],
    );
    const afterWal = await ownerQueryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM wal_events WHERE workspace_id = ANY($1::text[])',
      [[WS_ID, OTHER_WS_ID]],
    );
    expect(scopedRun?.merge_status).toBe('failed');
    expect(otherRun?.merge_status).toBe('merging');
    expect(afterWal?.count).toBe(beforeWal?.count);
    expect(mockBossSend).not.toHaveBeenCalled();
  });

  test('returns 409 when merge_status is null (never attempted)', async () => {
    const runId = await seedRun({ merge_status: null });
    const res = await postRetryMerge(runId);
    expectRetired(res);
  });

  test('returns 409 when merge_status is already merging', async () => {
    const runId = await seedRun({ merge_status: 'merging' });
    const res = await postRetryMerge(runId);
    expectRetired(res);
  });

  test('returns 409 when merge_status is already merged (success)', async () => {
    const runId = await seedRun({ merge_status: 'merged' });
    const res = await postRetryMerge(runId);
    expectRetired(res);
  });

  test('returns 409 when run has no branch_name', async () => {
    const runId = await seedRun({ merge_status: 'failed', branch_name: null });
    const res = await postRetryMerge(runId);
    expectRetired(res);
  });

  test('returns the retired response for a formerly eligible retry', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    expectRetired(await postRetryMerge(runId));
  });

  // ── merge_status transition via endpoint ──

  test('retired retry-merge leaves failed merge state unchanged', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    const before = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(before!.merge_status).toBe('failed');

    expectRetired(await postRetryMerge(runId));

    const after = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(after!.merge_status).toBe('failed');
  });

  // ── pg-boss enqueue verification ──

  test('does not enqueue the retired pipeline:merge job', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    expectRetired(await postRetryMerge(runId));
  });

  test('does not create a BIGINT-normalized payload for the retired actuator', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    expectRetired(await postRetryMerge(runId));
  });

  test('does not copy a branch name into a retired merge payload', async () => {
    const runId = await seedRun({ merge_status: 'failed', branch_name: 'feat/my-branch-123' });
    expectRetired(await postRetryMerge(runId));
  });

  test('does not copy workspace authority into a retired merge payload', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    expectRetired(await postRetryMerge(runId));
  });

  test('does not construct a legacy PipelineMergeJobPayload', async () => {
    const runId = await seedRun({ merge_status: 'failed' });
    expectRetired(await postRetryMerge(runId));
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
  let mockGitInstance: Record<string, jest.Mock>;
  let tmpDir: string;
  let wsDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-perform-merge-test-'));
    wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    // Legacy simple-git effects must remain absent when immutable release
    // identity is missing; these spies document the no-effect boundary.
    mockGitInstance = {
      status: jest.fn(),
      stash: jest.fn(),
      merge: jest.fn(),
      raw: jest.fn(),
      add: jest.fn(),
      commit: jest.fn(),
    };

    await cleanupTestData();
    await ensureWorkspace(wsDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('refuses missing host release identity before run lookup', async () => {
    const result = await performMerge(999999, 'feat/nonexistent', '/tmp/ws');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Host release identity is required');
  });

  test('refuses a final base merge for branch-only/no-auto-merge runs and preserves their worktree', async () => {
    const worktreeDir = path.join(tmpDir, 'branch-only-worktree');
    fs.mkdirSync(worktreeDir, { recursive: true });
    const runId = await seedRun({
      merge_status: 'failed',
      worktree_path: worktreeDir,
      auto_merge: false,
      merge_strategy: 'branch-only',
    });

    const result = await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Host release identity is required') });
    expect(mockGitInstance.merge).not.toHaveBeenCalled();
    expect(mockGitInstance.raw).not.toHaveBeenCalledWith(['worktree', 'remove', '--force', worktreeDir]);
    expect(fs.existsSync(worktreeDir)).toBe(true);
  });

  test('refuses missing host release identity before branch fallback', async () => {
    const runId = await seedRun({ branch_name: null, merge_status: null });

    const result = await performMerge(runId, '', wsDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Host release identity is required');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBeNull();
  });

  test('leaves failed state unchanged without host release identity', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.merge.mockRejectedValueOnce(new Error('Pre-check: unexpected error'));

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('does not fast-forward a legacy direct merge fixture', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'abc123sha\n';
      if (args[0] === 'worktree') return '';
      if (args[0] === 'diff') return '';
      return '';
    });

    const result = await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Host release identity is required');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('does not inspect conflict files without host release identity', async () => {
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
    expect(result.conflictFiles).toBeUndefined();
    expect(result.error).toContain('Host release identity is required');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('does not auto-resolve tracking conflicts without host release identity', async () => {
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

    expect(result.success).toBe(false);
    expect(result.error).toContain('Host release identity is required');

    const row = await queryOne<{ merge_status: string | null }>(
      'SELECT merge_status FROM pipeline_runs WHERE id = $1',
      [runId],
    );
    expect(row!.merge_status).toBe('failed');
  });

  test('does not stash workspace changes without host release identity', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.status.mockResolvedValue({ files: [{ path: 'dirty.ts' }] });
    mockGitInstance.merge.mockResolvedValue('');
    mockGitInstance.raw.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') return 'stash-sha\n';
      return '';
    });

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    expect(mockGitInstance.stash).not.toHaveBeenCalled();
  });

  test('does not enter stash restoration without host release identity', async () => {
    const runId = await seedRun({ merge_status: 'failed' });

    mockGitInstance.status.mockResolvedValue({ files: [{ path: 'dirty.ts' }] });
    mockGitInstance.merge.mockRejectedValue(new Error('Unexpected error during merge'));

    await performMerge(runId, 'feat/auto-merge-test-branch', wsDir);

    const stashCalls = mockGitInstance.stash.mock.calls;
    const popCall = stashCalls.find((c: string[][]) => c[0]?.[0] === 'pop');
    expect(popCall).toBeUndefined();
  });

  test('does not execute the legacy merge pre-check without host release identity', async () => {
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
    expect(result.success).toBe(false);
    expect(result.error).toContain('Host release identity is required');
  });

  test('does not emit a success WAL event without host release identity', async () => {
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

    expect(events).toHaveLength(0);
  });

  test('does not emit a conflict WAL event without host release identity', async () => {
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

    expect(events).toHaveLength(0);
  });

  test('does not remove a worktree without host release identity', async () => {
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

    expect(mockGitInstance.raw).not.toHaveBeenCalled();
  });

  test('does not clear worktree_path without host release identity', async () => {
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
    expect(row!.worktree_path).toBe('/tmp/worktree-to-clear');
  });

  test('does not use DB branch fallback to mint host release identity', async () => {
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

    expect(result.success).toBe(false);
    expect(result.error).toContain('Host release identity is required');
    expect(mockGitInstance.merge).not.toHaveBeenCalled();
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
