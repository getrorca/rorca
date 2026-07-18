/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';

const queryOne = jest.fn();
const execute = jest.fn();
const claimDelivery = jest.fn();
const checkDedup = jest.fn();
const dispatch = jest.fn();
const completeDelivery = jest.fn();
const failDelivery = jest.fn();
const insertAuditEntry = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  execute: (...args: unknown[]) => execute(...args),
}));
jest.mock('../../lib/auth-utils', () => ({ decryptToken: jest.fn() }));
jest.mock('../../lib/integration-vault', () => ({ getIntegrationSecret: jest.fn(async () => 'signed-secret') }));
jest.mock('../workspace-github', () => ({ verifyWebhookSignature: jest.fn(() => true) }));
jest.mock('../../lib/webhook-router', () => ({
  getWebhookRouter: () => ({ claimDelivery, checkDedup, dispatch, completeDelivery, failDelivery }),
}));
jest.mock('../../lib/logger', () => ({ logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../integration-audit-log', () => ({ insertAuditEntry: (...args: unknown[]) => insertAuditEntry(...args) }));
jest.mock('../../lib/paginate', () => ({ parsePaginationParams: jest.fn(), paginateQuery: jest.fn() }));

import webhooksRouter from '../webhooks';

const authority = {
  source: 'github-app', workspace_id: 'ws-1', repo_owner: 'acme', repo_name: 'widgets',
  webhook_id: null, webhook_secret_id: 'secret-1', installation_id: 77, repository_id: 99,
  account_id: 88, account_login: 'acme',
};

function app() {
  const instance = express();
  instance.use(express.json({ verify: (req, _res, buffer) => { (req as any).rawBody = Buffer.from(buffer); } }));
  instance.use('/api/webhooks', webhooksRouter);
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
  queryOne.mockImplementation(async (sql: string) => sql.includes('SELECT workspace_id FROM github_app_workspace_bindings')
    ? { workspace_id: 'ws-1' } : authority);
  execute.mockResolvedValue({ rowCount: 1 });
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
  expect(dispatch).toHaveBeenCalledWith('github', 'ping', expect.any(Object), { deliveryId: 'delivery-success-1', workspaceId: 'ws-1' });
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
