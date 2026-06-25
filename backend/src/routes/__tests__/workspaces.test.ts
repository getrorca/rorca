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

let app: Express;
let tmpDir: string;
let _dbPath: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ws-test-'));
  _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
  // Upgrade user to 'pro' plan to avoid requirePlan quota blocking workspace creation tests
  await execute("UPDATE users SET plan = 'pro' WHERE email = 'testauth@example.com'", []);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

const validWorkspace = {
  id: 'ws-test-1',
  label: 'Test Workspace',
  path: os.tmpdir(),
  domains: ['frontend', 'backend'],
};

test('POST /api/workspaces with valid path returns 201', async () => {
  const res = await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  expect(res.status).toBe(201);
  expect(res.body.workspace).toMatchObject({
    id: 'ws-test-1',
    label: 'Test Workspace',
    path: os.tmpdir(),
    domains: ['frontend', 'backend'],
  });
  expect(res.body.workspace.created_at).toBeDefined();
});

test('POST /api/workspaces with non-existent path returns 400', async () => {
  const res = await request(app)
    .post('/api/workspaces')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ ...validWorkspace, path: '/does/not/exist/xyz' });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('/does/not/exist/xyz');
});

test('POST /api/workspaces missing required field returns 400', async () => {
  const res = await request(app)
    .post('/api/workspaces')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ id: 'ws-1', label: 'Test' });

  expect(res.status).toBe(422); // validateBody returns 422 for Zod validation failures
  expect(res.body.error).toBeDefined();
});

test('GET /api/workspaces returns array containing created workspace', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(Array.isArray(res.body.items)).toBe(true);
  const created = res.body.items.find((item: { id: string }) => item.id === 'ws-test-1');
  expect(created).toBeDefined();
  expect(Array.isArray(created?.domains)).toBe(true);
});

test('GET /api/workspaces/:id returns workspace', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const res = await request(app).get('/api/workspaces/ws-test-1').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.workspace.id).toBe('ws-test-1');
});

test('GET /api/workspaces/:id returns 404 for nonexistent', async () => {
  const res = await request(app).get('/api/workspaces/nonexistent').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Workspace not found');
});

test('DELETE /api/workspaces/:id returns 204 and workspace is gone', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const delRes = await request(app).delete('/api/workspaces/ws-test-1').set('Authorization', `Bearer ${authToken}`);
  expect(delRes.status).toBe(204);

  const getRes = await request(app).get('/api/workspaces/ws-test-1').set('Authorization', `Bearer ${authToken}`);
  expect(getRes.status).toBe(404);
});

test('WAL events logged for workspace_create and workspace_delete', async () => {
  // Use a unique ID to avoid accumulating WAL events from other tests using ws-test-1
  const uniqueId = `ws-wal-test-${Date.now()}`;
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send({ ...validWorkspace, id: uniqueId });
  await request(app).delete(`/api/workspaces/${uniqueId}`).set('Authorization', `Bearer ${authToken}`);

  const events = await query(
    "SELECT event_type, workspace_id FROM wal_events WHERE workspace_id = $1 AND event_type IN ('workspace_create', 'workspace_delete') ORDER BY id",
    [uniqueId]
  ) as { event_type: string; workspace_id: string }[];

  expect(events).toHaveLength(2);
  expect(events[0].event_type).toBe('workspace_create');
  expect(events[1].event_type).toBe('workspace_delete');
});

test('GET /api/workspaces/:id/context returns 200 with null fields before hydration', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const res = await request(app).get('/api/workspaces/ws-test-1/context').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.schemaSnapshot).toBeNull();
  expect(res.body.schemaTableCount).toBeNull();
  expect(res.body.gitMemory).toBeNull();
  expect(res.body.lastIngestedCommitHash).toBeNull();
  expect(res.body.gitCommitCount).toBeNull();
});

test('GET /api/workspaces/:id/context returns populated fields after INSERT', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  await execute(`INSERT INTO workspace_context (workspace_id, schema_snapshot, schema_snapshot_at, schema_table_count, last_ingested_commit_hash, git_commit_count)
     VALUES ($1, $2, $3, $4, $5, $6)`, ['ws-test-1', 'CREATE TABLE users (id TEXT);', '2026-02-21T00:00:00Z', 1, 'abc123', 5]);

  const res = await request(app).get('/api/workspaces/ws-test-1/context').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.schemaSnapshot).toBe('CREATE TABLE users (id TEXT);');
  expect(res.body.schemaTableCount).toBe(1);
  expect(res.body.gitMemory).toBeNull();
  expect(res.body.lastIngestedCommitHash).toBe('abc123');
  expect(res.body.gitCommitCount).toBe(5);
});

test('GET /api/workspaces/:id/status returns canonical database capability with redacted connection metadata', async () => {
  await request(app).post('/api/workspaces').set('Authorization', `Bearer ${authToken}`).send(validWorkspace);

  const res = await request(app).get('/api/workspaces/ws-test-1/status').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.workspaceId).toBe('ws-test-1');
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
