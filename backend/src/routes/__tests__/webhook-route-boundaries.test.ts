/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import '../../lib/async-handler';

const queryOne = jest.fn();
const execute = jest.fn();
const paginateQuery = jest.fn();
const replayDlqEvent = jest.fn();
const authBoundary = jest.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authorization = req.headers.authorization;
  if (!authorization) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const admin = authorization === 'Bearer platform-admin';
  req.user = {
    id: admin ? 'admin-user' : 'ordinary-user',
    email: admin ? 'admin@example.test' : 'user@example.test',
    supabaseId: admin ? '10000000-0000-4000-8000-000000000001' : '20000000-0000-4000-8000-000000000002',
    role: admin ? 'admin' : 'user',
    plan: 'pro',
  };
  next();
});

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
}));
jest.mock('../../lib/auth-utils', () => ({
  decryptToken: jest.fn(),
  LOCAL_ADMIN: { id: 'local-admin' },
}));
jest.mock('../../lib/integration-vault', () => ({ getIntegrationSecret: jest.fn() }));
jest.mock('../workspace-github', () => ({ verifyWebhookSignature: jest.fn(() => false) }));
jest.mock('../../lib/webhook-router', () => ({
  getWebhookRouter: () => ({ replayDlqEvent }),
  webhookPayloadSha256: jest.fn(() => 'a'.repeat(64)),
}));
jest.mock('../../lib/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../integration-audit-log', () => ({ insertAuditEntry: jest.fn(async () => undefined) }));
jest.mock('../../lib/paginate', () => ({
  parsePaginationParams: jest.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  paginateQuery: (...args: unknown[]) => paginateQuery(...args),
}));

import { csrfProtection } from '../../lib/csrf';
import { webhookAdminRouter, webhookCallbackRouter } from '../webhooks';

const CSRF = 'c'.repeat(64);

function mountedApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, body) => { (req as any).rawBody = Buffer.from(body); } }));
  app.use('/api/webhooks', webhookCallbackRouter);
  app.use(authBoundary);
  app.use(csrfProtection);
  app.use('/api/webhooks', webhookAdminRouter);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error?.statusCode ?? 500).json(error?.toJSON?.() ?? { error: error?.message ?? 'Internal error' });
  });
  return app;
}

function adminReplay(workspaceId: string, withCsrf = true) {
  let call = request(mountedApp())
    .post('/api/webhooks/dlq/17/retry')
    .set('Authorization', 'Bearer platform-admin')
    .set('Origin', 'https://rorca.example')
    .send({ workspaceId });
  if (withCsrf) call = call.set('Cookie', `_csrf=${CSRF}`).set('X-CSRF-Token', CSRF);
  return call;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.AUTH_REQUIRED = 'true';
  execute.mockResolvedValue({ rowCount: 1 });
  replayDlqEvent.mockResolvedValue({ success: true });
  paginateQuery.mockResolvedValue({
    items: [{ id: 1, workspace_id: 'ws-a', payload: { repository: { full_name: 'acme/a' } } }],
    total: 1,
    hasMore: false,
  });
});

afterEach(() => {
  delete process.env.AUTH_REQUIRED;
});

test('only the exact provider callback mount executes before authentication', async () => {
  const callback = await request(mountedApp())
    .post('/api/webhooks/github')
    .send({ repository: { full_name: 'acme/a' } });
  expect(callback.status).toBe(401);
  expect(callback.body.error).toMatch(/invalid webhook authentication headers/i);
  expect(authBoundary).not.toHaveBeenCalled();

  const administration = await request(mountedApp()).get('/api/webhooks/dlq?workspaceId=ws-a');
  expect(administration.status).toBe(401);
  expect(administration.body.error).toBe('Authentication required');

  const callbackLookalike = await request(mountedApp()).post('/api/webhooks/not-a-provider').send({});
  expect(callbackLookalike.status).toBe(401);
  expect(callbackLookalike.body.error).toBe('Authentication required');

  const trailingSlashLookalike = await request(mountedApp()).post('/api/webhooks/github/').send({});
  expect(trailingSlashLookalike.status).toBe(401);
  expect(trailingSlashLookalike.body.error).toBe('Authentication required');
  expect(authBoundary).toHaveBeenCalledTimes(3);
});

test('admin replay remains CSRF protected after authentication', async () => {
  queryOne.mockResolvedValue({ role: 'admin' });
  const response = await adminReplay('ws-a', false);
  expect(response.status).toBe(403);
  expect(response.body.code).toBe('CSRF_INVALID');
  expect(queryOne).not.toHaveBeenCalled();
  expect(replayDlqEvent).not.toHaveBeenCalled();
});

test('DLQ listing requires both platform admin and workspace membership', async () => {
  const nonAdmin = await request(mountedApp())
    .get('/api/webhooks/dlq?workspaceId=ws-a')
    .set('Authorization', 'Bearer ordinary-user');
  expect(nonAdmin.status).toBe(403);
  expect(nonAdmin.body.code).toBe('ADMIN_REQUIRED');
  expect(queryOne).not.toHaveBeenCalled();

  queryOne.mockResolvedValueOnce(undefined);
  const nonMemberAdmin = await request(mountedApp())
    .get('/api/webhooks/dlq?workspaceId=ws-a')
    .set('Authorization', 'Bearer platform-admin');
  expect(nonMemberAdmin.status).toBe(403);
  expect(nonMemberAdmin.body.code).toBe('FORBIDDEN');
  expect(paginateQuery).not.toHaveBeenCalled();
});

test('DLQ list SQL and returned payloads are pinned to the authorized workspace', async () => {
  queryOne.mockResolvedValue({ role: 'member' });
  const response = await request(mountedApp())
    .get('/api/webhooks/dlq?workspaceId=ws-a&provider=github&resolved=false')
    .set('Authorization', 'Bearer platform-admin');

  expect(response.status).toBe(200);
  expect(response.body.items).toEqual([
    expect.objectContaining({ workspace_id: 'ws-a', payload: { repository: { full_name: 'acme/a' } } }),
  ]);
  const options = paginateQuery.mock.calls[0][0];
  expect(options.query).toContain('d.workspace_id = $1');
  expect(options.countQuery).toContain('d.workspace_id = $1');
  expect(options.params).toEqual(['ws-a', 'github']);
});

test('DLQ replay requires workspace admin and writes audit intent before scoped replay', async () => {
  queryOne.mockResolvedValueOnce({ role: 'member' });
  const memberResponse = await adminReplay('ws-a');
  expect(memberResponse.status).toBe(403);
  expect(replayDlqEvent).not.toHaveBeenCalled();

  queryOne.mockResolvedValueOnce({ role: 'admin' });
  const adminResponse = await adminReplay('ws-a');
  expect(adminResponse.status).toBe(200);
  expect(adminResponse.body).toEqual({ ok: true });
  expect(replayDlqEvent).toHaveBeenCalledWith(17, 'ws-a');
  expect(execute.mock.calls[0][0]).toContain('webhook_dlq_replay_requested');
  expect(execute.mock.invocationCallOrder[0]).toBeLessThan(replayDlqEvent.mock.invocationCallOrder[0]);
});

test('cross-workspace retry is indistinguishable from missing and cannot return payloads', async () => {
  queryOne.mockResolvedValue({ role: 'admin' });
  replayDlqEvent.mockResolvedValue({
    success: false,
    error: 'DLQ entry not found or lacks verified delivery provenance',
  });

  const response = await adminReplay('ws-b');

  expect(response.status).toBe(404);
  expect(response.body).not.toHaveProperty('payload');
  expect(replayDlqEvent).toHaveBeenCalledWith(17, 'ws-b');
});
