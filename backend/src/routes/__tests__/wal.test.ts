/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { execute, queryOne } from '../../db/index';

let app: Server;
let authToken: string;
const workspaceId = `wal-route-${process.pid}-${randomUUID()}`;
const walUrl = `/api/wal?workspace_id=${encodeURIComponent(workspaceId)}`;


beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: `wal-${process.pid}-${randomUUID()}@rorca.test`,
    authId: randomUUID(),
  });
  app = await new Promise<Server>((resolve, reject) => {
    const listener = expressApp.listen(0, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });
});

async function deleteFixtureWalEvents() {
  // Host-closeout WAL is immutable while a pipeline run references it. Scope
  // cleanup to this fixture and retain any referenced authority row.
  await execute(
    `DELETE FROM wal_events event
      WHERE event.workspace_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_runs run
           WHERE run.host_closeout_event_id = event.id
        )`,
    [workspaceId],
  );
}

beforeEach(deleteFixtureWalEvents);

afterEach(deleteFixtureWalEvents);

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
});

async function insertWalEvent(eventType: string) {
  await execute(`INSERT INTO wal_events (event_type, workspace_id) VALUES ($1, $2)`, [eventType, workspaceId]);
}

test('GET /api/wal returns all 3 inserted events, newest first', async () => {
  await insertWalEvent('workspace_create');
  await insertWalEvent('direction_update');
  await insertWalEvent('generate');

  const res = await request(app).get(walUrl).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(3);
  expect(res.body.total).toBe(3);
  // Newest first (DESC by id)
  expect(res.body.items[0].event_type).toBe('generate');
  expect(res.body.items[1].event_type).toBe('direction_update');
  expect(res.body.items[2].event_type).toBe('workspace_create');
});

test('limit=2 returns only 2 events, total still reflects full count', async () => {
  await insertWalEvent('workspace_create');
  await insertWalEvent('direction_update');
  await insertWalEvent('generate');

  const res = await request(app).get(`${walUrl}&limit=2`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2);
  expect(res.body.total).toBe(3);
});

test('offset=1 skips the newest event', async () => {
  await insertWalEvent('workspace_create');
  await insertWalEvent('direction_update');
  await insertWalEvent('generate');

  const res = await request(app).get(`${walUrl}&offset=1`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toHaveLength(2);
  // Skipped 'generate' (newest), first result is 'direction_update'
  expect(res.body.items[0].event_type).toBe('direction_update');
  expect(res.body.items[1].event_type).toBe('workspace_create');
});

test('empty WAL returns events:[], total:0', async () => {
  const res = await request(app).get(walUrl).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.items).toEqual([]);
  expect(res.body.total).toBe(0);
});

test('POST idempotency key prevents a retry after response loss from duplicating WAL', async () => {
  const body = {
    event_type: 'story_token_update',
    workspace_id: workspaceId,
    story_id: 'US-001',
    idempotency_key: `wal-test-idempotency-${randomUUID()}`,
    occurred_at: '2026-07-15T00:00:00.000Z',
    payload: { run_id: 42, cumulative_input: 100, cumulative_output: 20 },
  };

  const first = await request(app).post('/api/wal').set('Authorization', `Bearer ${authToken}`).send(body);
  const retry = await request(app).post('/api/wal').set('Authorization', `Bearer ${authToken}`).send(body);
  const count = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM wal_events WHERE ingest_key = $1',
    [body.idempotency_key],
  );

  expect(first.status).toBe(201);
  expect(first.body.duplicate).toBe(false);
  expect(retry.status).toBe(200);
  expect(retry.body).toMatchObject({ id: first.body.id, duplicate: true });
  expect(count?.count).toBe(1);
});
