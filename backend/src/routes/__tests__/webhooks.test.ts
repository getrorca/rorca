/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHmac } from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { query, queryOne, execute } from '../../db/index';
import { encryptToken } from '../../lib/auth-utils';

let app: Server;
let tmpDir: string;
let _authToken: string;

const WEBHOOK_SECRET = 'test-webhook-secret-for-hmac';
const WORKSPACE_ID = 'ws-webhook-test';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function makePayload(overrides: Record<string, any> = {}) {
  return {
    action: 'opened',
    ref: 'refs/heads/main',
    repository: { full_name: 'acme/my-repo' },
    sender: { login: 'octocat' },
    ...overrides,
  };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  _authToken = await getAuthToken(expressApp);
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-webhook-test-'));
  await execute('DELETE FROM webhook_dlq WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM webhook_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [WORKSPACE_ID, 'Webhook Test', tmpDir],
  );
  await execute(
    `INSERT INTO workspace_github_webhooks (workspace_id, repo_owner, repo_name, webhook_id, encrypted_webhook_secret)
     VALUES ($1, $2, $3, $4, $5)`,
    [WORKSPACE_ID, 'acme', 'my-repo', 12345, encryptToken(WEBHOOK_SECRET)],
  );
});

afterEach(async () => {
  await execute('DELETE FROM webhook_dlq WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM webhook_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspace_github_webhooks WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
});

// ─── Signature verification ─────────────────────────────────────────────────

test('valid signature returns 200', async () => {
  const payload = makePayload();
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'push')
    .set('X-GitHub-Delivery', 'delivery-123')
    .send(body);

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true, status: 'completed' });
});

test('invalid signature returns 401 with no WAL event logged', async () => {
  const payload = makePayload();
  const body = JSON.stringify(payload);
  const badSig = sign(body, 'wrong-secret');

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', badSig)
    .set('X-GitHub-Event', 'push')
    .set('X-GitHub-Delivery', 'delivery-456')
    .send(body);

  expect(res.status).toBe(401);
  expect(res.body.error).toMatch(/invalid webhook signature/i);

  // No WAL event should be created for invalid signatures
  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_webhook'`);
  expect(events).toHaveLength(0);
});

test('tampered body fails signature check', async () => {
  const payload = makePayload();
  const originalBody = JSON.stringify(payload);
  const sig = sign(originalBody, WEBHOOK_SECRET);

  // Send a different body with the signature from the original
  const tamperedPayload = makePayload({ action: 'closed' });
  const tamperedBody = JSON.stringify(tamperedPayload);

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'push')
    .set('X-GitHub-Delivery', 'delivery-789')
    .send(tamperedBody);

  expect(res.status).toBe(401);
});

// ─── Missing headers ────────────────────────────────────────────────────────

test('missing X-Hub-Signature-256 header fails with non-oracular authentication denial', async () => {
  const body = JSON.stringify(makePayload());

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', 'push')
    .send(body);

  expect(res.status).toBe(401);
  expect(res.body.code).toBe('AUTH_ERROR');
});

test('missing X-GitHub-Event header fails before payload processing', async () => {
  const body = JSON.stringify(makePayload());
  const sig = sign(body, WEBHOOK_SECRET);

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .send(body);

  expect(res.status).toBe(401);
  expect(res.body.code).toBe('AUTH_ERROR');
});

test('missing repository in payload returns 400', async () => {
  const payload = { action: 'opened', sender: { login: 'octocat' } };
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'push')
    .set('X-GitHub-Delivery', 'delivery-missing-repository')
    .send(body);

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/missing repository/i);
});

// ─── Unknown repository ─────────────────────────────────────────────────────

test('webhook for unconnected repo returns 404', async () => {
  const payload = makePayload({ repository: { full_name: 'unknown/repo' } });
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);

  const res = await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'push')
    .set('X-GitHub-Delivery', 'delivery-unknown-repository')
    .send(body);

  expect(res.status).toBe(404);
});

// ─── WAL event logging ──────────────────────────────────────────────────────

test('valid webhook logs a wal_event with github_webhook type', async () => {
  const payload = makePayload({ action: 'synchronize' });
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);

  await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'pull_request')
    .set('X-GitHub-Delivery', 'delivery-wal')
    .send(body);

  // Give async processing time to complete
  await new Promise((r) => setTimeout(r, 100));

  const events = await query(`SELECT * FROM wal_events WHERE event_type = 'github_webhook'`) as any[];

  expect(events).toHaveLength(1);
  expect(events[0].workspace_id).toBe(WORKSPACE_ID);

  const walPayload = typeof events[0].payload === 'string'
    ? JSON.parse(events[0].payload)
    : events[0].payload;
  expect(walPayload.event).toBe('pull_request');
  expect(walPayload.deliveryId).toBe('delivery-wal');
  expect(walPayload.repo).toBe('acme/my-repo');
  expect(walPayload.action).toBe('synchronize');
  expect(walPayload.sender).toBe('octocat');
});

// ─── Event-specific handler dispatch ────────────────────────────────────────

test('event handlers are dispatched for the correct event type', async () => {
  const received: { event: string; workspaceId: string }[] = [];

  // Register a handler via the exported onGithubEvent
  const webhooksMod = require('../webhooks');
  webhooksMod.onGithubEvent('issues', (
    _payload: any,
    event: string,
    workspaceId: string,
  ) => {
    received.push({ event, workspaceId });
  });

  const payload = makePayload({ action: 'opened' });
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);

  await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'issues')
    .set('X-GitHub-Delivery', 'delivery-dispatch')
    .send(body);

  // Give async processing time to complete
  await new Promise((r) => setTimeout(r, 100));

  expect(received).toHaveLength(1);
  expect(received[0].event).toBe('issues');
  expect(received[0].workspaceId).toBe(WORKSPACE_ID);
});

// ─── last_webhook_at update ─────────────────────────────────────────────────

test('valid webhook updates last_webhook_at timestamp', async () => {
  const payload = makePayload();
  const body = JSON.stringify(payload);
  const sig = sign(body, WEBHOOK_SECRET);

  const before = await queryOne(`SELECT last_webhook_at FROM workspace_github_webhooks WHERE workspace_id = $1`, [WORKSPACE_ID]) as any;
  expect(before.last_webhook_at).toBeNull();

  await request(app)
    .post('/api/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig)
    .set('X-GitHub-Event', 'push')
    .set('X-GitHub-Delivery', 'delivery-last-webhook-at')
    .send(body);

  await new Promise((r) => setTimeout(r, 100));

  const after = await queryOne(`SELECT last_webhook_at FROM workspace_github_webhooks WHERE workspace_id = $1`, [WORKSPACE_ID]) as any;
  expect(after.last_webhook_at).not.toBeNull();
});
