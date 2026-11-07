/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
import express from 'express';
import request from 'supertest';
import { forgejoSignature } from '../../lib/__tests__/fixtures/fake-forgejo-server';
import { forgejoWebhookSecretCipher } from '../../lib/forgejo-token-credential-provider';

const WEBHOOK_SECRET = 'forgejo-webhook-secret-fixture-0123456789abcdef';
const CREDENTIAL_ROW = {
  id: '10000000-0000-4000-8000-000000000101', workspace_id: 'ws-forgejo',
  instance_url: 'https://forgejo.example.test', repo_owner: 'acme', repo_name: 'widgets', status: 'active',
  webhook_secret_encrypted: forgejoWebhookSecretCipher.encrypt(WEBHOOK_SECRET),
  webhook_secret_previous_encrypted: null,
  webhook_secret_version: 1,
  webhook_secret_revoked_at: null,
};

jest.mock('../../db/index', () => ({
  queryOne: jest.fn(),
  execute: jest.fn(async () => ({ rowCount: 1 })),
}));
jest.mock('../../lib/webhook-router', () => ({
  webhookPayloadSha256: jest.fn((payload: unknown) => `sha256:${JSON.stringify(payload).length}`),
}));

import { execute, queryOne } from '../../db/index';
import forgejoWebhookCallbackRouter from '../forgejo-webhooks';

const app = express();
app.use(express.json({
  verify: (req: any, _res: any, buf: Buffer) => { (req as any).rawBody = buf; },
}));
app.use('/api/webhooks/forgejo', forgejoWebhookCallbackRouter);

function signedPost(payload: object, secret: string, headers: Record<string, string> = {}) {
  // Send the JSON string (not a Buffer): supertest serializes a Buffer under
  // application/json into {"type":"Buffer",...}, corrupting the raw bytes the
  // signature was computed over and the payload the receiver must parse.
  const rawBody = Buffer.from(JSON.stringify(payload));
  return request(app)
    .post('/api/webhooks/forgejo')
    .set('Content-Type', 'application/json')
    .set('X-Forgejo-Event', headers['X-Forgejo-Event'] ?? 'push')
    .set('X-Forgejo-Delivery', headers['X-Forgejo-Delivery'] ?? 'delivery-12345678')
    .set('X-Forgejo-Signature', forgejoSignature(rawBody, secret))
    .send(rawBody.toString());
}

beforeEach(() => {
  jest.clearAllMocks();
  // Dispatch by SQL so workspace resolution and delivery claims return the
  // exact shapes the receiver consumes (a claim row must carry claim_token +
  // attempt_count, not the credential row).
  (queryOne as jest.Mock).mockImplementation(async (sql: unknown) => {
    const text = String(sql);
    if (text.includes('resolve_forgejo_webhook_binding')) return CREDENTIAL_ROW;
    if (text.includes('webhook_events') && text.includes('RETURNING')) {
      return { claim_token: '22222222-2222-4222-8222-222222222222', attempt_count: 1 };
    }
    if (text.includes('FROM webhook_events')) return undefined;
    return undefined;
  });
});


describe('Forgejo webhook receiver (W5-006)', () => {
  test('verifies HMAC-SHA256 and ingests a push event with immutable audit', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      repository: { full_name: 'acme/widgets' },
      sender: { login: 'acme' },
    };
    const response = await signedPost(payload, WEBHOOK_SECRET);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, status: 'completed' });
    const sql = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    expect(sql).toContain('forgejo_webhook');
    expect(sql).toContain('webhook_events');
    const params = (execute as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    expect(params.some((value) => String(value).includes('acme/widgets'))).toBe(true);
  });

  test('accepts the X-Gitea-Signature header as an alias', async () => {
    const payload = {
      ref: 'refs/heads/main',
      after: 'a'.repeat(40),
      repository: { full_name: 'acme/widgets' },
    };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const response = await request(app)
      .post('/api/webhooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Gitea-Event', 'push')
      .set('X-Gitea-Delivery', 'delivery-gitea-01')
      .set('X-Gitea-Signature', forgejoSignature(rawBody, WEBHOOK_SECRET))
      .send(rawBody.toString());
    expect(response.status).toBe(200);
  });

  test('rejects tampered payloads, wrong secrets, and missing signatures with audit', async () => {
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'acme/widgets' } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const tampered = await request(app)
      .post('/api/webhooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Forgejo-Event', 'push')
      .set('X-Forgejo-Delivery', 'delivery-tamper-01')
      .set('X-Forgejo-Signature', forgejoSignature(rawBody, 'wrong-secret'))
      .send(rawBody.toString());
    expect(tampered.status).toBe(401);
    const missing = await request(app)
      .post('/api/webhooks/forgejo')
      .set('Content-Type', 'application/json')
      .set('X-Forgejo-Event', 'push')
      .set('X-Forgejo-Delivery', 'delivery-missing-1')
      .send(rawBody.toString());
    expect(missing.status).toBe(401);
    const audit = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    const auditParams = (execute as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    // The rejection reason lives in the audit details JSON parameter, not the SQL.
    expect(audit + '\n' + auditParams.map(String).join('\n')).toContain('forgejo_webhook_rejected');
  });

  test('drops unbound repositories and unknown events with audit, never processing them', async () => {
    (queryOne as jest.Mock).mockResolvedValueOnce(null);
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'other/unknown' } };
    const unbound = await signedPost(payload, WEBHOOK_SECRET, { 'X-Forgejo-Event': 'push' });
    expect(unbound.status).toBe(404);
    (queryOne as jest.Mock).mockResolvedValue(CREDENTIAL_ROW);
    const unknown = await signedPost({ repository: { full_name: 'acme/widgets' } }, WEBHOOK_SECRET,
      { 'X-Forgejo-Event': 'deployment' });
    expect(unknown.status).toBe(400);
    const audit = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    const auditParams = (execute as jest.Mock).mock.calls.flatMap((call) => call[1] ?? []);
    expect(audit + '\n' + auditParams.map(String).join('\n')).toContain('unbound_repository');
  });

  test('parses pull_request opened/synchronize/closed and rejects unsupported actions', async () => {
    for (const action of ['opened', 'synchronize', 'closed']) {
      const payload = {
        action,
        repository: { full_name: 'acme/widgets' },
        pull_request: { number: 12, head: { sha: 'a'.repeat(40) } },
      };
      const response = await signedPost(payload, WEBHOOK_SECRET, { 'X-Forgejo-Event': 'pull_request' });
      expect(response.status).toBe(200);
    }
    const badAction = await signedPost(
      { action: 'review_requested', repository: { full_name: 'acme/widgets' } },
      WEBHOOK_SECRET, { 'X-Forgejo-Event': 'pull_request' });
    expect(badAction.status).toBe(400);
  });

  test('status events are parsed into canonical workspace-scoped records', async () => {
    const payload = {
      sha: 'a'.repeat(40),
      context: 'rorca/pipeline',
      state: 'pending',
      repository: { full_name: 'acme/widgets' },
    };
    const response = await signedPost(payload, WEBHOOK_SECRET, { 'X-Forgejo-Event': 'status' });
    expect(response.status).toBe(200);
    const wal = (execute as jest.Mock).mock.calls.map((call) => String(call[0])).join('\n');
    expect(wal).toContain('forgejo_webhook');
  });

  test('replays are deduplicated via the delivery claim ledger', async () => {
    // The duplicate delivery loses the claim race (claimDelivery returns null);
    // the ledger check then reports the completed prior delivery as a duplicate.
    (queryOne as jest.Mock).mockResolvedValueOnce(CREDENTIAL_ROW); // workspace resolve
    (queryOne as jest.Mock).mockResolvedValueOnce(null); // claim conflict (already processing/completed)
    (queryOne as jest.Mock).mockResolvedValueOnce({ status: 'completed' }); // dedup check
    const payload = { ref: 'refs/heads/main', repository: { full_name: 'acme/widgets' } };
    const duplicate = await signedPost(payload, WEBHOOK_SECRET, { 'X-Forgejo-Delivery': 'delivery-dedup-01' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ ok: true, status: 'duplicate' });
  });
});
