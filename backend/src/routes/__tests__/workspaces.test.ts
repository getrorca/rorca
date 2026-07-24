/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, execute } from '../../db/index';

const mockAutoHydrateWorkspaceContext = jest.fn().mockResolvedValue(undefined);
jest.mock('../../lib/auto-memory', () => ({
  ...jest.requireActual('../../lib/auto-memory'),
  autoHydrateWorkspaceContext: (...args: unknown[]) => mockAutoHydrateWorkspaceContext(...args),
}));

const WORKSPACE_ID = `ws-routes-${crypto.randomUUID()}`;
let server: Server;
let tmpDir: string;
let authToken: string;

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    label: 'Test Workspace',
    path: tmpDir,
    domains: ['frontend', 'backend'],
    ...overrides,
  };
}

async function cleanWorkspaceFixture(): Promise<void> {
  await execute('DELETE FROM agent_profiles WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspace_context WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ws-test-'));
  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: `workspace-routes-${crypto.randomUUID()}@test.rorca.local`,
    authId: crypto.randomUUID(),
    role: 'admin',
  });
  server = expressApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(async () => {
  mockAutoHydrateWorkspaceContext.mockClear();
  await cleanWorkspaceFixture();
});

afterEach(cleanWorkspaceFixture);

afterAll(async () => {
  await cleanWorkspaceFixture();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

function api() {
  return request(server);
}

async function createWorkspace() {
  return api().post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(workspace());
}

test('POST /api/workspaces with valid path returns 201', async () => {
  const res = await createWorkspace();

  expect(res.status).toBe(201);
  expect(res.body.workspace).toMatchObject(workspace());
  expect(res.body.workspace.created_at).toBeDefined();
  expect(mockAutoHydrateWorkspaceContext).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WORKSPACE_ID }));
});

test('POST /api/workspaces with non-existent path returns 400', async () => {
  const nonexistentPath = path.join(tmpDir, 'does-not-exist');
  const res = await api()
    .post('/api/workspaces')
    .set('Authorization', `Bearer ${authToken}`)
    .send(workspace({ path: nonexistentPath }));

  expect(res.status).toBe(400);
  expect(res.body.error).toContain(nonexistentPath);
});

test('POST /api/workspaces missing required field returns 422', async () => {
  const res = await api()
    .post('/api/workspaces')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ id: WORKSPACE_ID, label: 'Test' });

  expect(res.status).toBe(422);
  expect(res.body.error).toBeDefined();
});

test('GET /api/workspaces returns the fixture workspace', async () => {
  await createWorkspace();

  const res = await api().get('/api/workspaces').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  const created = res.body.items.find((item: { id: string }) => item.id === WORKSPACE_ID);
  expect(created).toBeDefined();
  expect(Array.isArray(created.domains)).toBe(true);
});

test('GET /api/workspaces/:id returns workspace', async () => {
  await createWorkspace();

  const res = await api().get(`/api/workspaces/${WORKSPACE_ID}`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.workspace.id).toBe(WORKSPACE_ID);
});

test('GET /api/workspaces/:id returns 404 for nonexistent', async () => {
  const res = await api().get(`/api/workspaces/${WORKSPACE_ID}-missing`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

test('DELETE /api/workspaces/:id returns 204 and workspace is gone', async () => {
  await createWorkspace();

  const delRes = await api().delete(`/api/workspaces/${WORKSPACE_ID}`).set('Authorization', `Bearer ${authToken}`);
  expect(delRes.status).toBe(204);

  const getRes = await api().get(`/api/workspaces/${WORKSPACE_ID}`).set('Authorization', `Bearer ${authToken}`);
  expect(getRes.status).toBe(404);
});

test('WAL events logged for workspace_create and workspace_delete', async () => {
  await createWorkspace();
  await api().delete(`/api/workspaces/${WORKSPACE_ID}`).set('Authorization', `Bearer ${authToken}`);

  const events = await query<{ event_type: string; workspace_id: string }>(
    `SELECT event_type, workspace_id FROM wal_events
     WHERE workspace_id = $1 AND event_type IN ('workspace_create', 'workspace_delete') ORDER BY id`,
    [WORKSPACE_ID],
  );

  expect(events.map(event => event.event_type)).toEqual(['workspace_create', 'workspace_delete']);
});

test('GET /api/workspaces/:id/context returns null fields before hydration', async () => {
  await createWorkspace();

  const res = await api().get(`/api/workspaces/${WORKSPACE_ID}/context`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    schemaSnapshot: null,
    schemaTableCount: null,
    gitMemory: null,
    lastIngestedCommitHash: null,
    gitCommitCount: null,
  });
});

test('GET /api/workspaces/:id/context returns populated fields after hydration state update', async () => {
  await createWorkspace();
  await execute(
    `INSERT INTO workspace_context
       (workspace_id, schema_snapshot, schema_snapshot_at, schema_table_count, last_ingested_commit_hash, git_commit_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id) DO UPDATE SET
       schema_snapshot = EXCLUDED.schema_snapshot,
       schema_snapshot_at = EXCLUDED.schema_snapshot_at,
       schema_table_count = EXCLUDED.schema_table_count,
       last_ingested_commit_hash = EXCLUDED.last_ingested_commit_hash,
       git_commit_count = EXCLUDED.git_commit_count`,
    [WORKSPACE_ID, 'CREATE TABLE users (id TEXT);', '2026-02-21T00:00:00Z', 1, 'abc123', 5],
  );

  const res = await api().get(`/api/workspaces/${WORKSPACE_ID}/context`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    schemaSnapshot: 'CREATE TABLE users (id TEXT);',
    schemaTableCount: 1,
    gitMemory: null,
    lastIngestedCommitHash: 'abc123',
    gitCommitCount: 5,
  });
});

test('GET /api/workspaces/:id/status returns canonical database capability with redacted connection metadata', async () => {
  await createWorkspace();

  const res = await api().get(`/api/workspaces/${WORKSPACE_ID}/status`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.workspaceId).toBe(WORKSPACE_ID);
  expect(res.body.databaseCapability).toMatchObject({
    dbMode: expect.any(String),
    provider: expect.any(String),
    graphMode: expect.any(String),
  });
  expect(res.body.databaseCapability.extensions).toHaveProperty('age');
  expect(Array.isArray(res.body.databaseCapability.warnings)).toBe(true);
  expect(String(res.body.databaseCapability.connection.url ?? '')).not.toContain('@');
  expect(res.body.databaseSetup).toMatchObject({
    selectedMode: expect.any(String),
    selectionPersistsAcrossSessions: true,
  });
  expect(res.body.databaseSetup.modes).toHaveLength(3);
  expect(res.body.databaseSetup.graphModes.map((entry: { mode: string }) => entry.mode).sort()).toEqual(['full', 'lite']);
  expect(res.body.graph).toHaveProperty('graphMode', res.body.databaseCapability.graphMode);
});
