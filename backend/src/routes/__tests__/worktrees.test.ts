/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, execute } from '../../db/index';

// ─── Mock simple-git ────────────────────────────────────────────────────────

const mockRaw = jest.fn<Promise<string>, [string[]]>();
const mockStatus = jest.fn();
const mockMerge = jest.fn<Promise<any>, [string[]]>();
const mockGit = jest.fn<{ raw: typeof mockRaw; status: typeof mockStatus; merge: typeof mockMerge }, [string]>(
  () => ({ raw: mockRaw, status: mockStatus, merge: mockMerge })
);

jest.mock('simple-git', () => ({
  __esModule: true,
  default: (p: string) => mockGit(p),
}));

// ─── Setup ──────────────────────────────────────────────────────────────────

let app: Express;
let tmpDir: string;
let _dbPath: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();

  // Re-apply the mock after resetModules
  jest.doMock('simple-git', () => ({
    __esModule: true,
    default: (p: string) => mockGit(p),
  }));

  // Reset merge mock default (resolves cleanly)
  mockMerge.mockResolvedValue({});

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-wt-test-'));
  _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Seed a workspace for tests
  await execute(`INSERT INTO workspaces (id, label, path, domains) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, ['ws-1', 'Test Workspace', tmpDir, '["frontend"]']);

  authToken = await getAuthToken(app);

  // Clear WAL events from user registration so tests start with a clean slate
  await execute(`DELETE FROM wal_events`);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── GET /api/worktrees ─────────────────────────────────────────────────────

const PORCELAIN_OUTPUT = [
  'worktree /home/user/project',
  'HEAD abc1234567890',
  'branch refs/heads/main',
  '',
  'worktree /home/user/project-feat-auth',
  'HEAD def9876543210',
  'branch refs/heads/feat/auth',
  'locked',
  '',
].join('\n');

test('GET /api/worktrees parses porcelain output correctly', async () => {
  mockRaw.mockResolvedValue(PORCELAIN_OUTPUT);

  const res = await request(app).get('/api/worktrees?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.worktrees).toHaveLength(2);

  expect(res.body.worktrees[0]).toEqual({
    path: '/home/user/project',
    branch: 'main',
    headSha: 'abc1234567890',
    isLocked: false,
    isBare: false,
  });

  expect(res.body.worktrees[1]).toEqual({
    path: '/home/user/project-feat-auth',
    branch: 'feat/auth',
    headSha: 'def9876543210',
    isLocked: true,
    isBare: false,
  });

  expect(mockGit).toHaveBeenCalledWith(tmpDir);
  expect(mockRaw).toHaveBeenCalledWith(['worktree', 'list', '--porcelain']);
});

test('GET /api/worktrees parses bare and detached worktrees', async () => {
  const output = [
    'worktree /home/user/project.git',
    'HEAD aaa111',
    'bare',
    '',
    'worktree /home/user/detached-wt',
    'HEAD bbb222',
    'detached',
    '',
  ].join('\n');

  mockRaw.mockResolvedValue(output);

  const res = await request(app).get('/api/worktrees?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.worktrees[0].isBare).toBe(true);
  expect(res.body.worktrees[1].branch).toBe('(detached)');
});

test('GET /api/worktrees returns 400 without workspaceId', async () => {
  const res = await request(app).get('/api/worktrees').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('workspaceId');
});

test('GET /api/worktrees returns 404 for nonexistent workspace', async () => {
  const res = await request(app).get('/api/worktrees?workspaceId=no-such').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

// ─── POST /api/worktrees ────────────────────────────────────────────────────

test('POST /api/worktrees calls git worktree add with correct args', async () => {
  mockRaw.mockResolvedValue('');

  const res = await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({
    workspaceId: 'ws-1',
    branchName: 'feat/user-auth',
    baseBranch: 'main',
  });

  expect(res.status).toBe(201);
  expect(res.body.ok).toBe(true);
  expect(res.body.branchName).toBe('feat/user-auth');
  expect(res.body.worktreePath).toBeDefined();

  // Verify git was called correctly
  expect(mockGit).toHaveBeenCalledWith(tmpDir);
  expect(mockRaw).toHaveBeenCalledWith([
    'worktree', 'add', '-b', 'feat/user-auth',
    expect.stringContaining('feat-user-auth'),
    'main',
  ]);
});

test('POST /api/worktrees defaults baseBranch to HEAD', async () => {
  mockRaw.mockResolvedValue('');

  await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({
    workspaceId: 'ws-1',
    branchName: 'fix/bug',
  });

  expect(mockRaw).toHaveBeenCalledWith([
    'worktree', 'add', '-b', 'fix/bug',
    expect.any(String),
    'HEAD',
  ]);
});

test('POST /api/worktrees uses custom worktreePath if provided', async () => {
  mockRaw.mockResolvedValue('');
  const customPath = path.join(tmpDir, 'custom-wt');

  const res = await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({
    workspaceId: 'ws-1',
    branchName: 'feat/custom',
    worktreePath: customPath,
  });

  expect(res.status).toBe(201);
  expect(res.body.worktreePath).toBe(customPath);
  expect(mockRaw).toHaveBeenCalledWith([
    'worktree', 'add', '-b', 'feat/custom',
    customPath,
    'HEAD',
  ]);
});

test('POST /api/worktrees returns 409 when branch already exists', async () => {
  mockRaw.mockRejectedValue(new Error("A branch named 'feat/existing' already exists"));

  const res = await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({
    workspaceId: 'ws-1',
    branchName: 'feat/existing',
  });

  expect(res.status).toBe(409);
  expect(res.body.error).toContain('already exists');
});

test('POST /api/worktrees emits WAL event', async () => {
  mockRaw.mockResolvedValue('');

  await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({
    workspaceId: 'ws-1',
    branchName: 'feat/wal-test',
  });

  const events = await query("SELECT * FROM wal_events WHERE event_type = 'worktree_created'") as Array<{ event_type: string; workspace_id: string; payload: string }>;

  expect(events).toHaveLength(1);
  expect(events[0].workspace_id).toBe('ws-1');
  const payload = JSON.parse(events[0].payload);
  expect(payload.branchName).toBe('feat/wal-test');
  expect(payload.worktreePath).toBeDefined();
});

test('POST /api/worktrees returns 400 without required fields', async () => {
  const res = await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({ workspaceId: 'ws-1' });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('branchName');
});

// ─── DELETE /api/worktrees/:encodedPath ─────────────────────────────────────

test('DELETE /api/worktrees/:path calls git worktree remove', async () => {
  mockRaw.mockResolvedValue('');

  const wtPath = '/home/user/project-feat-auth';
  const encoded = encodeURIComponent(wtPath);

  const res = await request(app).delete(`/api/worktrees/${encoded}?workspaceId=ws-1`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(mockRaw).toHaveBeenCalledWith(['worktree', 'remove', wtPath]);
});

test('DELETE /api/worktrees/:path with force=true passes --force', async () => {
  mockRaw.mockResolvedValue('');

  const wtPath = '/home/user/project-dirty';
  const encoded = encodeURIComponent(wtPath);

  await request(app).delete(`/api/worktrees/${encoded}?workspaceId=ws-1&force=true`).set('Authorization', `Bearer ${authToken}`);

  expect(mockRaw).toHaveBeenCalledWith(['worktree', 'remove', wtPath, '--force']);
});

test('DELETE /api/worktrees/:path returns 409 on dirty worktree', async () => {
  mockRaw.mockRejectedValue(new Error('contains modified or untracked files, use --force to delete'));

  const encoded = encodeURIComponent('/some/dirty/path');
  const res = await request(app).delete(`/api/worktrees/${encoded}?workspaceId=ws-1`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(409);
  expect(res.body.error).toContain('modified');
});

test('DELETE /api/worktrees/:path emits WAL event', async () => {
  mockRaw.mockResolvedValue('');

  const wtPath = '/home/user/project-remove';
  const encoded = encodeURIComponent(wtPath);

  await request(app).delete(`/api/worktrees/${encoded}?workspaceId=ws-1`).set('Authorization', `Bearer ${authToken}`);

  const events = await query("SELECT * FROM wal_events WHERE event_type = 'worktree_removed'") as Array<{ event_type: string; workspace_id: string; payload: string }>;

  expect(events).toHaveLength(1);
  expect(events[0].workspace_id).toBe('ws-1');
  const payload = JSON.parse(events[0].payload);
  expect(payload.worktreePath).toBe(wtPath);
});

// ─── GET /api/worktrees/status ──────────────────────────────────────────────

test('GET /api/worktrees/status returns git status for worktree', async () => {
  mockStatus.mockResolvedValue({
    current: 'feat/auth',
    ahead: 2,
    behind: 1,
    isClean: () => false,
    modified: ['src/index.ts', 'README.md'],
  });

  const wtPath = encodeURIComponent('/home/user/project-feat-auth');
  const res = await request(app).get(`/api/worktrees/status?workspaceId=ws-1&path=${wtPath}`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({
    branch: 'feat/auth',
    ahead: 2,
    behind: 1,
    isClean: false,
    modifiedFiles: ['src/index.ts', 'README.md'],
  });
});

test('GET /api/worktrees/status returns clean status', async () => {
  mockStatus.mockResolvedValue({
    current: 'main',
    ahead: 0,
    behind: 0,
    isClean: () => true,
    modified: [],
  });

  const wtPath = encodeURIComponent('/home/user/project');
  const res = await request(app).get(`/api/worktrees/status?workspaceId=ws-1&path=${wtPath}`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.isClean).toBe(true);
  expect(res.body.modifiedFiles).toEqual([]);
});

test('GET /api/worktrees/status returns 400 without required params', async () => {
  const res = await request(app).get('/api/worktrees/status?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('path');
});

// ─── W-005: Integration Tests ───────────────────────────────────────────────

describe('Integration: full round-trip', () => {
  test('POST → GET includes new entry → DELETE → GET confirms removal', async () => {
    // 1. POST — create a new worktree
    mockRaw.mockResolvedValueOnce(''); // git worktree add succeeds

    const createRes = await request(app).post('/api/worktrees').set('Authorization', `Bearer ${authToken}`).send({
      workspaceId: 'ws-1',
      branchName: 'feat/round-trip',
      baseBranch: 'main',
    });

    expect(createRes.status).toBe(201);
    expect(createRes.body.ok).toBe(true);
    const createdPath = createRes.body.worktreePath;
    expect(createdPath).toContain('feat-round-trip');

    // 2. GET — list should include the new worktree
    mockRaw.mockResolvedValueOnce(
      [
        'worktree /home/user/project',
        'HEAD aaa111',
        'branch refs/heads/main',
        '',
        `worktree ${createdPath}`,
        'HEAD bbb222',
        'branch refs/heads/feat/round-trip',
        '',
      ].join('\n')
    );

    const listRes = await request(app).get('/api/worktrees?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

    expect(listRes.status).toBe(200);
    expect(listRes.body.worktrees).toHaveLength(2);

    const newEntry = listRes.body.worktrees.find(
      (wt: { branch: string }) => wt.branch === 'feat/round-trip'
    );
    expect(newEntry).toBeDefined();
    expect(newEntry.path).toBe(createdPath);
    expect(newEntry.headSha).toBe('bbb222');
    expect(newEntry.isLocked).toBe(false);
    expect(newEntry.isBare).toBe(false);

    // 3. DELETE — remove the worktree
    mockRaw.mockResolvedValueOnce(''); // git worktree remove succeeds

    const encoded = encodeURIComponent(createdPath);
    const deleteRes = await request(app).delete(`/api/worktrees/${encoded}?workspaceId=ws-1`).set('Authorization', `Bearer ${authToken}`);

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // 4. GET — list should no longer include the removed worktree
    mockRaw.mockResolvedValueOnce(
      [
        'worktree /home/user/project',
        'HEAD aaa111',
        'branch refs/heads/main',
        '',
      ].join('\n')
    );

    const listAfterDelete = await request(app).get('/api/worktrees?workspaceId=ws-1').set('Authorization', `Bearer ${authToken}`);

    expect(listAfterDelete.status).toBe(200);
    expect(listAfterDelete.body.worktrees).toHaveLength(1);
    expect(listAfterDelete.body.worktrees[0].branch).toBe('main');

    // Verify WAL events were emitted for both create and delete
    const events = await query('SELECT * FROM wal_events ORDER BY id ASC') as Array<{ event_type: string; workspace_id: string; payload: string }>;

    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('worktree_created');
    expect(events[1].event_type).toBe('worktree_removed');
  });
});

describe('Integration: /api/worktrees/status response shape', () => {
  test('returns all expected fields with correct types', async () => {
    mockStatus.mockResolvedValue({
      current: 'feat/status-shape',
      ahead: 5,
      behind: 3,
      isClean: () => false,
      modified: ['src/app.ts', 'package.json', 'README.md'],
    });

    const wtPath = encodeURIComponent('/home/user/project-feat-status');
    const res = await request(app).get(`/api/worktrees/status?workspaceId=ws-1&path=${wtPath}`).set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);

    // Verify exact shape — no extra/missing fields
    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(['ahead', 'behind', 'branch', 'isClean', 'modifiedFiles']);

    // Verify types
    expect(typeof res.body.branch).toBe('string');
    expect(typeof res.body.ahead).toBe('number');
    expect(typeof res.body.behind).toBe('number');
    expect(typeof res.body.isClean).toBe('boolean');
    expect(Array.isArray(res.body.modifiedFiles)).toBe(true);

    // Verify values
    expect(res.body.branch).toBe('feat/status-shape');
    expect(res.body.ahead).toBe(5);
    expect(res.body.behind).toBe(3);
    expect(res.body.isClean).toBe(false);
    expect(res.body.modifiedFiles).toEqual(['src/app.ts', 'package.json', 'README.md']);
  });

  test('clean worktree returns empty modifiedFiles array', async () => {
    mockStatus.mockResolvedValue({
      current: 'main',
      ahead: 0,
      behind: 0,
      isClean: () => true,
      modified: [],
    });

    const wtPath = encodeURIComponent('/home/user/project');
    const res = await request(app).get(`/api/worktrees/status?workspaceId=ws-1&path=${wtPath}`).set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.isClean).toBe(true);
    expect(res.body.modifiedFiles).toEqual([]);
    expect(res.body.ahead).toBe(0);
    expect(res.body.behind).toBe(0);
  });
});

// ─── POST /api/worktrees/merge/preview ─────────────────────────────────────

describe('POST /api/worktrees/merge/preview', () => {
  test('returns canMerge=true when no conflicts', async () => {
    // diff --stat for filesChanged
    mockRaw.mockResolvedValueOnce(' 3 files changed, 10 insertions(+), 2 deletions(-)');
    // merge --no-commit --no-ff succeeds
    const mockMerge = jest.fn().mockResolvedValue({});
    mockGit.mockReturnValue({ raw: mockRaw, merge: mockMerge, status: mockStatus } as any);

    const res = await request(app)
      .post('/api/worktrees/merge/preview')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1', branchName: 'feat/clean' });

    expect(res.status).toBe(200);
    expect(res.body.canMerge).toBe(true);
    expect(res.body.hasConflicts).toBe(false);
    expect(res.body.conflictFiles).toEqual([]);
    expect(res.body.filesChanged).toBe(3);
  });

  test('returns hasConflicts=true with conflict files', async () => {
    // diff --stat for filesChanged
    mockRaw.mockResolvedValueOnce(' 2 files changed');
    // diff --name-only --diff-filter=U for conflict file list
    mockRaw.mockResolvedValueOnce('src/index.ts\nREADME.md\n');

    const mockMerge = jest.fn()
      .mockRejectedValueOnce(new Error('CONFLICT (content): Merge conflict in src/index.ts'))
      .mockResolvedValueOnce({}); // merge --abort

    mockGit.mockReturnValue({ raw: mockRaw, merge: mockMerge, status: mockStatus } as any);

    const res = await request(app)
      .post('/api/worktrees/merge/preview')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1', branchName: 'feat/conflicting' });

    expect(res.status).toBe(200);
    expect(res.body.canMerge).toBe(false);
    expect(res.body.hasConflicts).toBe(true);
    expect(res.body.conflictFiles).toHaveLength(2);
    expect(res.body.conflictFiles[0].path).toBe('src/index.ts');
    expect(res.body.conflictFiles[1].path).toBe('README.md');
  });

  test('returns 400 without required fields', async () => {
    const res = await request(app)
      .post('/api/worktrees/merge/preview')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('branchName');
  });

  test('returns 404 for nonexistent workspace', async () => {
    const res = await request(app)
      .post('/api/worktrees/merge/preview')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'no-such', branchName: 'feat/test' });

    expect(res.status).toBe(404);
  });
});

// ─── POST /api/worktrees/merge (enhanced) ──────────────────────────────────

describe('POST /api/worktrees/merge', () => {
  test('successful merge returns mergeCommitSha', async () => {
    const mockMerge = jest.fn().mockResolvedValue({});
    mockRaw.mockResolvedValueOnce('abc123def456\n'); // rev-parse HEAD
    mockGit.mockReturnValue({ raw: mockRaw, merge: mockMerge, status: mockStatus } as any);

    const res = await request(app)
      .post('/api/worktrees/merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1', branchName: 'feat/with-sha' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mergeCommitSha).toBe('abc123def456');
  });

  test('successful merge emits WAL event with branchName and mergeCommitSha', async () => {
    const mockMerge = jest.fn().mockResolvedValue({});
    mockRaw.mockResolvedValueOnce('sha789\n'); // rev-parse HEAD
    mockGit.mockReturnValue({ raw: mockRaw, merge: mockMerge, status: mockStatus } as any);

    await request(app)
      .post('/api/worktrees/merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1', branchName: 'feat/wal-sha' });

    const events = await query("SELECT * FROM wal_events WHERE event_type = 'worktree_merged'") as Array<{ event_type: string; workspace_id: string; payload: string }>;

    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload);
    expect(payload.branchName).toBe('feat/wal-sha');
    expect(payload.mergeCommitSha).toBe('sha789');
  });

  test('force merge uses -X theirs strategy', async () => {
    const mockMerge = jest.fn().mockResolvedValue({});
    mockRaw.mockResolvedValueOnce('forced123\n'); // rev-parse HEAD
    mockGit.mockReturnValue({ raw: mockRaw, merge: mockMerge, status: mockStatus } as any);

    const res = await request(app)
      .post('/api/worktrees/merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1', branchName: 'feat/force', force: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockMerge).toHaveBeenCalledWith(['feat/force', '--no-ff', '-X', 'theirs']);
  });

  test('conflict returns 409 with conflictFiles', async () => {
    mockRaw.mockResolvedValueOnce('src/app.ts\n'); // diff --name-only --diff-filter=U

    const mockMerge = jest.fn()
      .mockRejectedValueOnce(new Error('CONFLICT (content): Merge conflict in src/app.ts'))
      .mockResolvedValueOnce({}); // merge --abort

    mockGit.mockReturnValue({ raw: mockRaw, merge: mockMerge, status: mockStatus } as any);

    const res = await request(app)
      .post('/api/worktrees/merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1', branchName: 'feat/conflict' });

    expect(res.status).toBe(409);
    expect(res.body.conflict).toBe(true);
    expect(res.body.conflictFiles).toBeDefined();
  });

  test('returns 400 without required fields', async () => {
    const res = await request(app)
      .post('/api/worktrees/merge')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('branchName');
  });
});
