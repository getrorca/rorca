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
const claimDelivery = jest.fn();
const checkDedup = jest.fn();
const dispatch = jest.fn();
const completeDelivery = jest.fn();
const failDelivery = jest.fn();
const insertAuditEntry = jest.fn();
const decryptToken = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
}));
jest.mock('../../lib/auth-utils', () => ({ decryptToken: (...args: unknown[]) => decryptToken(...args) }));
jest.mock('../../lib/integration-vault', () => ({ getIntegrationSecret: jest.fn(async () => 'signed-secret') }));
jest.mock('../workspace-github', () => ({ verifyWebhookSignature: jest.fn(() => true) }));
jest.mock('../../lib/webhook-router', () => ({
  getWebhookRouter: () => ({ claimDelivery, checkDedup, dispatch, completeDelivery, failDelivery }),
  webhookPayloadSha256: jest.fn(() => 'a'.repeat(64)),
}));
jest.mock('../../lib/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../integration-audit-log', () => ({ insertAuditEntry: (...args: unknown[]) => insertAuditEntry(...args) }));
jest.mock('../../lib/paginate', () => ({ parsePaginationParams: jest.fn(), paginateQuery: jest.fn() }));

import webhooksRouter from '../webhooks';

const authority = {
  source: 'github-app', workspace_id: 'ws-1', repo_owner: 'acme', repo_name: 'widgets',
  webhook_id: null, webhook_secret_id: 'secret-1', installation_id: 77, repository_id: 99,
  account_id: 88, account_login: 'acme', binding_id: 'binding-1', authority_status: 'active',
};

function app() {
  const instance = express();
  instance.use(express.json({ verify: (req, _res, buffer) => { (req as any).rawBody = Buffer.from(buffer); } }));
  instance.use('/api/webhooks', webhooksRouter);
  instance.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error?.statusCode ?? 500).json(error?.toJSON?.() ?? { error: error?.message ?? 'Internal error' });
  });
  return instance;
}

function delivery(id: string) {
  return request(app()).post('/api/webhooks/github')
    .set('x-hub-signature-256', `sha256=${'a'.repeat(64)}`)
    .set('x-github-event', 'ping')
    .set('x-github-delivery', id)
    .send({
      installation: { id: 77 },
      repository: { id: 99, full_name: 'acme/widgets', owner: { id: 88, login: 'acme' } },
      sender: { login: 'github' },
    });
}

beforeEach(() => {
  jest.clearAllMocks();
  queryOne.mockReset();
  queryOne.mockImplementation(async (sql: string) => sql.includes('WITH current_app') ? authority : undefined);
  execute.mockResolvedValue({ rowCount: 1 });
  decryptToken.mockReturnValue('legacy-signed-secret');
  insertAuditEntry.mockResolvedValue(undefined);
  claimDelivery.mockResolvedValue({ claimToken: '10000000-0000-4000-8000-000000000001', attempt: 1 });
  checkDedup.mockResolvedValue('completed');
  dispatch.mockResolvedValue(1);
  completeDelivery.mockResolvedValue(true);
  failDelivery.mockResolvedValue(true);
});

test('does not acknowledge 200 until dispatch and durable claim completion succeed', async () => {
  const response = await delivery('delivery-success-1');
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('completed');
  expect(dispatch).toHaveBeenCalledWith('github', 'ping', expect.any(Object), expect.objectContaining({
    deliveryId: 'delivery-success-1', workspaceId: 'ws-1',
    verifiedDelivery: expect.objectContaining({ method: 'github-hmac-sha256' }),
  }));
  expect(completeDelivery).toHaveBeenCalledWith('github', 'delivery-success-1', '10000000-0000-4000-8000-000000000001');
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('signed_delivery_observed = TRUE'), ['ws-1', 77, 99]);
});

test('handler failure marks the claim failed and returns retryable 503 instead of false 200', async () => {
  dispatch.mockRejectedValueOnce(new Error('simulated crash/failure'));
  const response = await delivery('delivery-failed-1');
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({ ok: false, status: 'failed', code: 'WEBHOOK_PROCESSING_FAILED' });
  expect(failDelivery).toHaveBeenCalledWith('github', 'delivery-failed-1', '10000000-0000-4000-8000-000000000001');
  expect(completeDelivery).not.toHaveBeenCalled();
});

test('completed/current duplicates stay idempotent while a reclaimed redelivery can complete', async () => {
  claimDelivery.mockResolvedValueOnce(null);
  const duplicate = await delivery('delivery-duplicate-1');
  expect(duplicate.status).toBe(200);
  expect(duplicate.body.status).toBe('duplicate');
  expect(dispatch).not.toHaveBeenCalled();

  claimDelivery.mockResolvedValueOnce({ claimToken: '20000000-0000-4000-8000-000000000002', attempt: 2 });
  const redelivery = await delivery('delivery-redelivered-1');
  expect(redelivery.status).toBe(200);
  expect(redelivery.body.status).toBe('completed');
  expect(completeDelivery).toHaveBeenCalledWith('github', 'delivery-redelivered-1', '20000000-0000-4000-8000-000000000002');
  expect(insertAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ delivery_attempt: 2 }) }));
});

test('a recent processing claim is never falsely acknowledged as a successful duplicate', async () => {
  claimDelivery.mockResolvedValueOnce(null);
  checkDedup.mockResolvedValueOnce('processing');
  const response = await delivery('delivery-processing-1');
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({ status: 'retry-later', code: 'WEBHOOK_DELIVERY_IN_PROGRESS' });
  expect(dispatch).not.toHaveBeenCalled();
});

test.each([
  ['stale provider profile', 'delivery-stale-profile'],
  ['permission drift', 'delivery-permission-drift'],
  ['event drift', 'delivery-event-drift'],
] as const)('signed traffic is rejected and audited for %s', async (_reason, deliveryId) => {
  queryOne.mockResolvedValueOnce({ ...authority, authority_status: 'invalid' });

  const response = await delivery(deliveryId);

  expect(response.status).toBe(403);
  expect(response.body.error).toMatch(/canonical github app webhook authority is not active/i);
  expect(claimDelivery).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
  expect(execute).toHaveBeenCalledWith(expect.stringContaining("github_webhook_rejected"), [
    'ws-1', expect.stringContaining('canonical_authority_inactive'),
  ]);
  expect(insertAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
    action: 'webhook_rejected',
    details: expect.objectContaining({ delivery_id: deliveryId, authority_status: 'invalid' }),
  }));
});

test('a disabled current binding is a signed fail-closed downgrade fence', async () => {
  queryOne.mockResolvedValueOnce({ ...authority, authority_status: 'disabled' });

  const response = await delivery('delivery-disabled-binding');

  expect(response.status).toBe(403);
  expect(queryOne).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
  expect(insertAuditEntry).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ authority_status: 'disabled' }),
  }));
});

test('legacy webhook compatibility remains available only when no current App binding exists', async () => {
  queryOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce({
    source: 'legacy-repository-webhook', workspace_id: 'legacy-ws', repo_owner: 'acme', repo_name: 'widgets',
    webhook_id: 12, encrypted_webhook_secret: 'encrypted-legacy-secret', authority_status: 'active',
  });

  const response = await delivery('delivery-legacy-compat');

  expect(response.status).toBe(200);
  expect(decryptToken).toHaveBeenCalledWith('encrypted-legacy-secret');
  expect(claimDelivery).toHaveBeenCalledWith('github', 'delivery-legacy-compat', 'ping', 'legacy-ws',
    expect.objectContaining({ method: 'github-hmac-sha256' }));
});

test('an invalid current App binding never downgrades to a retained legacy webhook', async () => {
  queryOne
    .mockResolvedValueOnce({ ...authority, authority_status: 'invalid' })
    .mockResolvedValueOnce({
      source: 'legacy-repository-webhook', workspace_id: 'legacy-ws', repo_owner: 'acme', repo_name: 'widgets',
      webhook_id: 12, encrypted_webhook_secret: 'retained-legacy-secret', authority_status: 'active',
    });

  const response = await delivery('delivery-downgrade-fence');

  expect(response.status).toBe(403);
  expect(queryOne).toHaveBeenCalledTimes(1);
  expect(dispatch).not.toHaveBeenCalled();
});

test('a superseded App binding cannot authenticate when no current authority exists', async () => {
  queryOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);

  const response = await delivery('delivery-superseded-binding');

  expect(response.status).toBe(404);
  expect(queryOne).toHaveBeenCalledTimes(2);
  expect(String(queryOne.mock.calls[0][0])).toContain('b.superseded_at IS NULL');
  expect(dispatch).not.toHaveBeenCalled();
});
