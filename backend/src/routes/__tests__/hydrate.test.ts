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
import { query, queryOne, execute } from '../../db/index';

// Mock git-hydrator
const mockGitMapStep = jest.fn();
const mockGitReduceStep = jest.fn();
const mockGetLatestHash = jest.fn();
jest.mock('../../lib/git-hydrator', () => ({
  gitMapStep: (...args: any[]) => mockGitMapStep(...args),
  gitReduceStep: (...args: any[]) => mockGitReduceStep(...args),
  getLatestHash: (...args: any[]) => mockGetLatestHash(...args),
}));

// Mock schema-hydrator
const mockHydrateSchema = jest.fn();
jest.mock('../../lib/schema-hydrator', () => ({
  hydrateSchema: (...args: any[]) => mockHydrateSchema(...args),
}));

let app: Express;
let tmpDir: string;
let _dbPath: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-hydrate-test-'));
  _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

const validWorkspace = {
  id: 'ws-hydrate',
  label: 'Hydrate Test',
  path: os.tmpdir(),
  domains: ['code'],
};

async function createWorkspace() {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);
}

// --- Basic endpoint tests ---

test('POST /api/workspaces/:id/hydrate with valid workspace runs both hydrators', async () => {
  await createWorkspace();

  mockHydrateSchema.mockReturnValue({
    snapshot: 'CREATE TABLE users (id TEXT);',
    tableNames: ['users'],
    fileCount: 1,
    migrationDir: '/tmp/migrations',
  });

  mockGitMapStep.mockResolvedValue([
    { fromHash: 'a1', toHash: 'b2', commitCount: 10, summary: '- Added auth' },
  ]);
  mockGitReduceStep.mockResolvedValue(
    'architectural_decisions:\n  - description: Added auth'
  );
  mockGetLatestHash.mockReturnValue('b2');

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.schema.tableCount).toBe(1);
  expect(res.body.schema.snapshot_at).toBeDefined();
  expect(res.body.git.commitCount).toBe(10);
  expect(res.body.git.newCommits).toBe(10);
  expect(res.body.git.memory_updated_at).toBeDefined();
});

test('POST with types=[schema] only runs schema hydration', async () => {
  await createWorkspace();

  mockHydrateSchema.mockReturnValue({
    snapshot: 'CREATE TABLE items (id TEXT);',
    tableNames: ['items'],
    fileCount: 1,
    migrationDir: '/tmp/migrations',
  });

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['schema'] });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.schema.tableCount).toBe(1);
  expect(res.body.git).toBeUndefined();
  expect(mockGitMapStep).not.toHaveBeenCalled();
});

test('POST with types=[git] only runs git hydration', async () => {
  await createWorkspace();

  mockGitMapStep.mockResolvedValue([
    { fromHash: 'x', toHash: 'y', commitCount: 5, summary: '- stuff' },
  ]);
  mockGitReduceStep.mockResolvedValue('conventions:\n  - rule: use snake_case');
  mockGetLatestHash.mockReturnValue('y');

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['git'] });

  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(res.body.git.commitCount).toBe(5);
  expect(res.body.schema).toBeUndefined();
  expect(mockHydrateSchema).not.toHaveBeenCalled();
});

test('POST workspace not in DB returns 404', async () => {
  const res = await request(app)
    .post('/api/workspaces/nonexistent/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

// --- Edge cases ---

test('gitMapStep returns [] (no commits) returns 200 with newCommits=0', async () => {
  await createWorkspace();

  mockGitMapStep.mockResolvedValue([]);
  mockGetLatestHash.mockReturnValue(null);

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['git'] });

  expect(res.status).toBe(200);
  expect(res.body.git.newCommits).toBe(0);
  expect(res.body.git.commitCount).toBe(0);
  // gitReduceStep should not be called when there are no new commits
  expect(mockGitReduceStep).not.toHaveBeenCalled();
});

test('hydrateSchema returns empty snapshot returns 200 with tableCount=0', async () => {
  await createWorkspace();

  mockHydrateSchema.mockReturnValue({
    snapshot: '',
    tableNames: [],
    fileCount: 0,
    migrationDir: '',
  });

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['schema'] });

  expect(res.status).toBe(200);
  expect(res.body.schema.tableCount).toBe(0);
});

test('UPSERT: calling hydrate twice does not duplicate workspace_context rows', async () => {
  await createWorkspace();

  mockHydrateSchema.mockReturnValue({
    snapshot: 'CREATE TABLE t1 (id TEXT);',
    tableNames: ['t1'],
    fileCount: 1,
    migrationDir: '/tmp',
  });

  // First call
  await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['schema'] });

  // Update return
  mockHydrateSchema.mockReturnValue({
    snapshot: 'CREATE TABLE t1 (id TEXT);\nCREATE TABLE t2 (id TEXT);',
    tableNames: ['t1', 't2'],
    fileCount: 2,
    migrationDir: '/tmp',
  });

  // Second call
  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['schema'] });

  expect(res.status).toBe(200);
  expect(res.body.schema.tableCount).toBe(2);

  // Only one row in workspace_context
  const rows = await query('SELECT * FROM workspace_context WHERE workspace_id = $1', ['ws-hydrate']);
  expect(rows).toHaveLength(1);
});

test('delta sync: uses last_ingested_commit_hash from workspace_context', async () => {
  await createWorkspace();

  // Pre-seed workspace_context with a previous hash
  await execute(`INSERT INTO workspace_context (workspace_id, last_ingested_commit_hash, git_commit_count)
     VALUES ($1, $2, $3)`, ['ws-hydrate', 'prev_hash_abc', 20]);

  mockGitMapStep.mockResolvedValue([
    { fromHash: 'n1', toHash: 'n2', commitCount: 3, summary: '- New feature' },
  ]);
  mockGitReduceStep.mockResolvedValue('conventions:\n  - rule: new rule');
  mockGetLatestHash.mockReturnValue('n2');

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['git'] });

  expect(res.status).toBe(200);
  // Should pass fromHash to gitMapStep
  expect(mockGitMapStep).toHaveBeenCalledWith(
    expect.objectContaining({ fromHash: 'prev_hash_abc' })
  );
  // Commit count should accumulate
  expect(res.body.git.commitCount).toBe(23);
  expect(res.body.git.newCommits).toBe(3);

  // Git memory is now written to the memories table (source='git_hydration')
  const memRow = await queryOne('SELECT content FROM memories WHERE workspace_id = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1', ['ws-hydrate', 'git_hydration']) as { content: string } | undefined;
  expect(memRow).toBeDefined();
  expect(memRow?.content).toContain('new rule');
});

// --- WAL events ---

test('WAL events inserted for both hydrate_schema and hydrate_git', async () => {
  await createWorkspace();

  mockHydrateSchema.mockReturnValue({
    snapshot: 'CREATE TABLE t (id TEXT);',
    tableNames: ['t'],
    fileCount: 1,
    migrationDir: '/tmp',
  });
  mockGitMapStep.mockResolvedValue([
    { fromHash: 'a', toHash: 'b', commitCount: 5, summary: '- Added X' },
  ]);
  mockGitReduceStep.mockResolvedValue('yaml output');
  mockGetLatestHash.mockReturnValue('b');

  await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({});

  const events = await query(
    "SELECT event_type, workspace_id, payload FROM wal_events WHERE workspace_id = 'ws-hydrate' AND event_type LIKE 'hydrate_%' ORDER BY id"
  ) as { event_type: string; workspace_id: string; payload: string }[];

  expect(events).toHaveLength(2);
  expect(events[0].event_type).toBe('hydrate_schema');
  expect(JSON.parse(events[0].payload)).toEqual({ tableCount: 1 });
  expect(events[1].event_type).toBe('hydrate_git');
  const gitPayload = JSON.parse(events[1].payload);
  expect(gitPayload.commitCount).toBe(5);
  expect(gitPayload.newCommits).toBe(5);
});

// --- Error handling ---

test('gitMapStep throws "Not a git repository" returns 422', async () => {
  await createWorkspace();

  mockGitMapStep.mockRejectedValue(
    new Error('Not a git repository: /tmp/fake')
  );

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['git'] });

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('Not a git repository');
});

test('chatComplete throws during reduce returns 502', async () => {
  await createWorkspace();

  mockGitMapStep.mockResolvedValue([
    { fromHash: 'a', toHash: 'b', commitCount: 5, summary: '- Something' },
  ]);
  mockGitReduceStep.mockRejectedValue(new Error('API rate limited'));

  const res = await request(app)
    .post('/api/workspaces/ws-hydrate/hydrate')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ types: ['git'] });

  expect(res.status).toBe(502);
  expect(res.body.error).toContain('LLM call failed during git reduce');
});
