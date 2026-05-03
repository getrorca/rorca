/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
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
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sse-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
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

async function createWorkspace(id = 'ws-sse-1') {
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`, [id, 'SSE Test Workspace', tmpDir]);
}

// ─── Test 1: POST /api/pipeline/runs creates run → triggers broadcastAll ────

test('POST /api/pipeline/runs creates run and broadcasts WAL event to subscribers', async () => {
  await createWorkspace();

  // Subscribe via the sse-hub before creating the run
  const sseHub = require('../../lib/sse-hub');
  const received: any[] = [];
  const unsubscribe = sseHub.subscribe((event: any) => {
    received.push(event);
  });

  // Create a pipeline run
  const res = await request(app)
    .post('/api/pipeline/runs')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ specPath: 'specs/pending/test-spec.json', workspaceId: 'ws-sse-1' });

  expect(res.status).toBe(201);
  expect(res.body.run).toBeDefined();
  expect(res.body.run.spec_path).toBe('specs/pending/test-spec.json');
  expect(res.body.run.workspace_id).toBe('ws-sse-1');
  expect(res.body.run.status).toBe('running');

  // Verify subscriber received the broadcast
  expect(received).toHaveLength(1);
  expect(received[0].event_type).toBe('run_started');
  expect(received[0].workspace_id).toBe('ws-sse-1');

  const payload = JSON.parse(received[0].payload);
  expect(payload.run_id).toBe(res.body.run.id);
  expect(payload.spec_path).toBe('specs/pending/test-spec.json');

  unsubscribe();
});

// ─── Test 2: subscribe() cleanup removes subscriber from Map ────────────────

test('subscribe() cleanup function removes subscriber from Map (no leak)', () => {
  const sseHub = require('../../lib/sse-hub');
  const initialCount = sseHub.subscriberCount();

  const unsub1 = sseHub.subscribe(() => {});
  const unsub2 = sseHub.subscribe(() => {});
  expect(sseHub.subscriberCount()).toBe(initialCount + 2);

  unsub1();
  expect(sseHub.subscriberCount()).toBe(initialCount + 1);

  unsub2();
  expect(sseHub.subscriberCount()).toBe(initialCount);
});

// ─── Test 3: GET /api/pipeline/runs/:runId returns run + empty stories ──────

test('GET /api/pipeline/runs/:runId returns the run with empty story_results array', async () => {
  await createWorkspace();

  // Create a run first
  const createRes = await request(app)
    .post('/api/pipeline/runs')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ specPath: 'specs/pending/my-spec.json', workspaceId: 'ws-sse-1' });

  const runId = createRes.body.run.id;

  // Fetch the run by ID
  const res = await request(app).get(`/api/pipeline/runs/${runId}`).set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(200);
  expect(res.body.run).toBeDefined();
  expect(res.body.run.id).toBe(runId);
  expect(res.body.run.spec_path).toBe('specs/pending/my-spec.json');
  expect(res.body.run.workspace_id).toBe('ws-sse-1');
  expect(res.body.run.status).toBe('running');
  expect(res.body.stories).toEqual([]);
});

// ─── Test 4: POST /api/pipeline/runs with missing fields returns 400 ────────

test('POST /api/pipeline/runs missing specPath returns 400', async () => {
  const res = await request(app)
    .post('/api/pipeline/runs')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ workspaceId: 'ws-sse-1' });

  expect(res.status).toBe(400);
  expect(res.body.error).toContain('Missing required fields');
});

// ─── Test 5: GET /api/pipeline/runs/:runId returns 404 for nonexistent ──────

test('GET /api/pipeline/runs/:runId returns 404 for nonexistent run', async () => {
  const res = await request(app).get('/api/pipeline/runs/99999').set('Authorization', `Bearer ${authToken}`);

  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Run not found');
});

// ─── Test 6: WAL event persisted with correct Phase 3 event types ───────────

test('POST /api/pipeline/runs persists run_started WAL event in wal_events table', async () => {
  await createWorkspace();

  await request(app)
    .post('/api/pipeline/runs')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ specPath: 'specs/pending/wal-check.json', workspaceId: 'ws-sse-1' });

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'run_started'`) as any[];

  expect(events).toHaveLength(1);
  expect(events[0].workspace_id).toBe('ws-sse-1');

  const payload = JSON.parse(events[0].payload);
  expect(payload.spec_path).toBe('specs/pending/wal-check.json');
});

// ─── Test 7: GET /api/pipeline/stream returns SSE content type ──────────────

test('GET /api/pipeline/stream returns text/event-stream content type', async () => {
  const res = await request(app)
    .get('/api/pipeline/stream')
    .set('Authorization', `Bearer ${authToken}`)
    .buffer(true)
    .parse((res: any, callback: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        // Close after receiving initial keepalive
        if (data.includes(': keepalive')) {
          (res as any).destroy();
        }
      });
      res.on('end', () => callback(null, data));
      res.on('error', () => callback(null, data));
      res.on('close', () => callback(null, data));
    });

  expect(res.headers['content-type']).toBe('text/event-stream');
  expect(res.body).toContain(': keepalive');
});
