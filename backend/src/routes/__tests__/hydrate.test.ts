/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';

const mockGitMapStep = jest.fn();
const mockGitReduceStep = jest.fn();
const mockGetLatestHash = jest.fn();
jest.mock('../../lib/git-hydrator', () => ({
  gitMapStep: (...args: unknown[]) => mockGitMapStep(...args),
  gitReduceStep: (...args: unknown[]) => mockGitReduceStep(...args),
  getLatestHash: (...args: unknown[]) => mockGetLatestHash(...args),
}));

const mockHydrateSchema = jest.fn();
jest.mock('../../lib/schema-hydrator', () => ({
  hydrateSchema: (...args: unknown[]) => mockHydrateSchema(...args),
}));

const WORKSPACE_ID = `ws-hydrate-${crypto.randomUUID()}`;
let server: Server;
let authToken: string;

function api() {
  return request(server);
}

async function cleanFixture(): Promise<void> {
  await execute('DELETE FROM memories WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspace_context WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
}

async function createWorkspace(): Promise<void> {
  await execute(
    `INSERT INTO workspaces (id, label, path, domains)
     VALUES ($1, 'Hydrate Test', $2, $3)`,
    [WORKSPACE_ID, process.cwd(), JSON.stringify(['code'])],
  );
}

async function hydrate(body: Record<string, unknown> = {}) {
  return api()
    .post(`/api/workspaces/${WORKSPACE_ID}/hydrate`)
    .set('Authorization', `Bearer ${authToken}`)
    .send(body);
}

function decodedPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === 'string' ? JSON.parse(payload) : payload as Record<string, unknown>;
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: `hydrate-${crypto.randomUUID()}@test.rorca.local`,
    authId: crypto.randomUUID(),
    role: 'admin',
  });
  server = expressApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(async () => {
  jest.clearAllMocks();
  await cleanFixture();
});

afterEach(cleanFixture);

afterAll(async () => {
  await cleanFixture();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
});

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
  mockGitReduceStep.mockResolvedValue('architectural_decisions:\n  - description: Added auth');
  mockGetLatestHash.mockReturnValue('b2');

  const res = await hydrate();

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

  const res = await hydrate({ types: ['schema'] });

  expect(res.status).toBe(200);
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

  const res = await hydrate({ types: ['git'] });

  expect(res.status).toBe(200);
  expect(res.body.git.commitCount).toBe(5);
  expect(res.body.schema).toBeUndefined();
  expect(mockHydrateSchema).not.toHaveBeenCalled();
});

test('POST workspace not in DB returns 404', async () => {
  const res = await hydrate();

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

test('gitMapStep returns [] returns 200 with newCommits=0', async () => {
  await createWorkspace();
  mockGitMapStep.mockResolvedValue([]);
  mockGetLatestHash.mockReturnValue(null);

  const res = await hydrate({ types: ['git'] });

  expect(res.status).toBe(200);
  expect(res.body.git).toMatchObject({ newCommits: 0, commitCount: 0 });
  expect(mockGitReduceStep).not.toHaveBeenCalled();
});

test('hydrateSchema returns empty snapshot returns 200 with tableCount=0', async () => {
  await createWorkspace();
  mockHydrateSchema.mockReturnValue({ snapshot: '', tableNames: [], fileCount: 0, migrationDir: '' });

  const res = await hydrate({ types: ['schema'] });

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
  await hydrate({ types: ['schema'] });
  mockHydrateSchema.mockReturnValue({
    snapshot: 'CREATE TABLE t1 (id TEXT);\nCREATE TABLE t2 (id TEXT);',
    tableNames: ['t1', 't2'],
    fileCount: 2,
    migrationDir: '/tmp',
  });

  const res = await hydrate({ types: ['schema'] });

  expect(res.status).toBe(200);
  expect(res.body.schema.tableCount).toBe(2);
  const rows = await query('SELECT workspace_id FROM workspace_context WHERE workspace_id = $1', [WORKSPACE_ID]);
  expect(rows).toHaveLength(1);
});

test('delta sync uses last_ingested_commit_hash from workspace_context', async () => {
  await createWorkspace();
  await execute(
    `INSERT INTO workspace_context (workspace_id, last_ingested_commit_hash, git_commit_count)
     VALUES ($1, $2, $3)`,
    [WORKSPACE_ID, 'prev_hash_abc', 20],
  );
  mockGitMapStep.mockResolvedValue([
    { fromHash: 'n1', toHash: 'n2', commitCount: 3, summary: '- New feature' },
  ]);
  mockGitReduceStep.mockResolvedValue('conventions:\n  - rule: new rule');
  mockGetLatestHash.mockReturnValue('n2');

  const res = await hydrate({ types: ['git'] });

  expect(res.status).toBe(200);
  expect(mockGitMapStep).toHaveBeenCalledWith(expect.objectContaining({ fromHash: 'prev_hash_abc' }));
  expect(res.body.git).toMatchObject({ commitCount: 23, newCommits: 3 });
  const memory = await queryOne<{ content: string }>(
    `SELECT content FROM memories
     WHERE workspace_id = $1 AND source = 'git_hydration'
     ORDER BY created_at DESC LIMIT 1`,
    [WORKSPACE_ID],
  );
  expect(memory?.content).toContain('new rule');
});

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

  await hydrate();

  const events = await query<{ event_type: string; workspace_id: string; payload: unknown }>(
    `SELECT event_type, workspace_id, payload FROM wal_events
     WHERE workspace_id = $1 AND event_type LIKE 'hydrate_%' ORDER BY id`,
    [WORKSPACE_ID],
  );
  expect(events.map(event => event.event_type)).toEqual(['hydrate_schema', 'hydrate_git']);
  expect(decodedPayload(events[0].payload)).toEqual({ tableCount: 1 });
  expect(decodedPayload(events[1].payload)).toMatchObject({ commitCount: 5, newCommits: 5 });
});

test('gitMapStep Not a git repository error returns 422', async () => {
  await createWorkspace();
  mockGitMapStep.mockRejectedValue(new Error('Not a git repository: /tmp/fake'));

  const res = await hydrate({ types: ['git'] });

  expect(res.status).toBe(422);
  expect(res.body.error).toContain('Not a git repository');
});

test('git reduce failure returns 502', async () => {
  await createWorkspace();
  mockGitMapStep.mockResolvedValue([
    { fromHash: 'a', toHash: 'b', commitCount: 5, summary: '- Something' },
  ]);
  mockGitReduceStep.mockRejectedValue(new Error('API rate limited'));

  const res = await hydrate({ types: ['git'] });

  expect(res.status).toBe(502);
  expect(res.body.error).toContain('LLM call failed during git reduce');
});
