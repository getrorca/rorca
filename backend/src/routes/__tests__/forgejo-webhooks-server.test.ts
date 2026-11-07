/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * A2 real-stack webhook mount: a correctly signed Forgejo delivery travels
 * through the PRODUCTION server middleware composition (rawBody capture for
 * the exact /api/webhooks/forgejo path, no separately mounted test app) and
 * reaches the receiver, which verifies it with the dedicated webhook secret.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { forgejoSignature } from '../../lib/__tests__/fixtures/fake-forgejo-server';
import { forgejoWebhookSecretCipher } from '../../lib/forgejo-token-credential-provider';
import { execute, queryOne } from '../../db/index';

let app: Server;
let tmpDir: string;

const WORKSPACE_ID = 'workspace:wave-two'; // matches the test pool workspace GUC
const WEBHOOK_SECRET = 'real-stack-forgejo-webhook-secret-0123456789abcdef';
const BINDING_ID = '10000000-0000-4000-8000-000000000111';

function sign(payload: object): string {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return forgejoSignature(rawBody, WEBHOOK_SECRET);
}

function sendWebhook(payload: object, event = 'push') {
  return request(app)
    .post('/api/webhooks/forgejo')
    .set('Content-Type', 'application/json')
    .set('X-Forgejo-Event', event)
    .set('X-Forgejo-Delivery', `delivery-realstack-${Date.now()}`)
    .set('X-Forgejo-Signature', sign(payload))
    .send(JSON.stringify(payload));
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-forgejo-webhooks-server-'));
  // Credential rows are audit-retained (never deleted), so they are seeded
  // exactly once per invocation; only the deletable delivery/WAL ledgers are
  // reset between tests.
  await execute('DELETE FROM webhook_events WHERE provider = \'forgejo\'');
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  await execute('DELETE FROM workspaces WHERE id = $1', [WORKSPACE_ID]);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [WORKSPACE_ID, 'Real Stack Webhook', tmpDir],
  );
  await execute(
    `INSERT INTO forgejo_workspace_credentials (
       id, workspace_id, instance_url, repo_owner, repo_name, token_digest, scope_profile,
       status, credential_version, key_version, created_by, webhook_secret_encrypted, webhook_secret_version
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'active', 1, 1, $8, $9, 1)
     ON CONFLICT (id) DO NOTHING`,
    [BINDING_ID, WORKSPACE_ID, 'https://forgejo.example.test', 'acme', 'widgets',
      'sha256:' + '0'.repeat(64), JSON.stringify({ schemaVersion: 'rorca.forgejo-capability-profile.v1' }),
      'test-operator', forgejoWebhookSecretCipher.encrypt(WEBHOOK_SECRET)],
  );
  const serverMod = require('../../server');
  const expressApp = serverMod.default as Express;
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  await execute('DELETE FROM webhook_events WHERE provider = \'forgejo\'');
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
});

afterEach(async () => {
  await execute('DELETE FROM webhook_events WHERE provider = \'forgejo\'');
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
});

afterAll(async () => {
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  await execute('DELETE FROM webhook_events WHERE provider = \'forgejo\'');
  await execute('DELETE FROM wal_events WHERE workspace_id = $1', [WORKSPACE_ID]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
describe('Forgejo webhook through the production middleware composition', () => {
  test('a correctly signed delivery reaches the handler and records WAL evidence', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      repository: { full_name: 'acme/widgets' },
      sender: { login: 'acme' },
    };
    const response = await sendWebhook(payload);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, status: 'completed' });
    const wal = await queryOne<{ event_type: string }>(
      `SELECT event_type FROM wal_events WHERE workspace_id = $1 AND event_type = 'forgejo_webhook' ORDER BY id DESC LIMIT 1`,
      [WORKSPACE_ID],
    );
    expect(wal?.event_type).toBe('forgejo_webhook');
  });

  test('the binding UUID no longer signs deliveries; wrong secrets are rejected', async () => {
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'acme/widgets' } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const wrong = await request(app)
      .post('/api/webhooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Forgejo-Event', 'push')
      .set('X-Forgejo-Delivery', 'delivery-wrongsecret-01')
      .set('X-Forgejo-Signature', forgejoSignature(rawBody, BINDING_ID))
      .send(rawBody.toString());
    expect(wrong.status).toBe(401);
  });
});
