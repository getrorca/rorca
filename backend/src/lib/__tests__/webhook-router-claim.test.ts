/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

jest.mock('../../db/index', () => ({
  execute: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { execute, queryOne } from '../../db/index';
import {
  WebhookDispatchError,
  WebhookRouter,
  webhookPayloadSha256,
  type VerifiedWebhookDelivery,
} from '../webhook-router';

const provenance: VerifiedWebhookDelivery = {
  method: 'github-hmac-sha256',
  payloadSha256: 'a'.repeat(64),
};

beforeEach(() => jest.clearAllMocks());

test('verified payload hashing is stable across JSON object key order', () => {
  expect(webhookPayloadSha256({ b: 2, a: { y: 2, x: 1 } })).toBe(
    webhookPayloadSha256({ a: { x: 1, y: 2 }, b: 2 }),
  );
});

test('atomically claims new delivery and treats a live/completed duplicate as unowned', async () => {
  (queryOne as jest.Mock)
    .mockResolvedValueOnce({ claim_token: '10000000-0000-4000-8000-000000000001', attempt_count: 1 })
    .mockResolvedValueOnce(undefined);
  const router = new WebhookRouter();
  await expect(router.claimDelivery('github', 'delivery-123', 'push', 'ws-1', provenance)).resolves.toEqual({
    claimToken: '10000000-0000-4000-8000-000000000001', attempt: 1,
  });
  await expect(router.claimDelivery('github', 'delivery-123', 'push', 'ws-1', provenance)).resolves.toBeNull();
  expect(queryOne).toHaveBeenNthCalledWith(1, expect.stringContaining('ON CONFLICT (provider, delivery_id) DO UPDATE'), expect.arrayContaining([
    'github', 'delivery-123', 'push', 'ws-1',
  ]));
});

test('claim SQL bounds failed/stale crash reclamation and preserves identity matching', async () => {
  (queryOne as jest.Mock).mockResolvedValue({ claim_token: '20000000-0000-4000-8000-000000000002', attempt_count: 2 });
  const router = new WebhookRouter();
  await router.claimDelivery('github', 'delivery-redelivery', 'ping', 'ws-1', provenance);
  const sql = String((queryOne as jest.Mock).mock.calls[0][0]);
  expect(sql).toContain("webhook_events.status = 'failed'");
  expect(sql).toContain("webhook_events.status = 'processing'");
  expect(sql).toContain('processing_started_at < $8');
  expect(sql).toContain('attempt_count < $9');
  expect(sql).toContain('event_type = EXCLUDED.event_type');
  expect(sql).toContain('workspace_id IS NOT DISTINCT FROM EXCLUDED.workspace_id');
  expect(sql).toContain('payload_sha256 = EXCLUDED.payload_sha256');
  expect(sql).toContain('verification_method = EXCLUDED.verification_method');
  expect(sql).toContain('signature_verified_at = EXCLUDED.signature_verified_at');
});

test('only the current claim token can acknowledge or fail a reclaimed delivery', async () => {
  (execute as jest.Mock).mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 1 });
  const router = new WebhookRouter();
  await expect(router.completeDelivery('github', 'delivery-crash', 'stale-token')).resolves.toBe(false);
  await expect(router.failDelivery('github', 'delivery-crash', 'current-token')).resolves.toBe(true);
  expect(execute).toHaveBeenNthCalledWith(1, expect.stringContaining('claim_token = $3'), ['github', 'delivery-crash', 'stale-token']);
  expect(execute).toHaveBeenNthCalledWith(2, expect.stringContaining("status = 'failed'"), ['github', 'delivery-crash', 'current-token']);
});

test('handler exhaustion writes the existing DLQ and rejects so provider redelivery is requested', async () => {
  jest.useFakeTimers();
  try {
    (execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
    const router = new WebhookRouter();
    const handler = jest.fn(async () => { throw new Error('handler failed'); });
    router.on('github', 'push', handler);
    const dispatched = router.dispatch('github', 'push', { repository: { id: 99 } }, {
      deliveryId: 'delivery-failed', workspaceId: 'ws-1', verifiedDelivery: provenance,
    });
    const rejection = expect(dispatched).rejects.toBeInstanceOf(WebhookDispatchError);
    await jest.runAllTimersAsync();
    await rejection;
    expect(handler).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO webhook_dlq'), expect.arrayContaining([
      'github', 'push', expect.any(String), 'handler failed', 3, 'delivery-failed', 'ws-1',
      provenance.payloadSha256, provenance.method,
    ]));
  } finally {
    jest.useRealTimers();
  }
});

test('admin replay fails closed for cross-workspace or unverified DLQ provenance', async () => {
  (queryOne as jest.Mock).mockResolvedValue(undefined);
  const router = new WebhookRouter();
  const handler = jest.fn();
  router.on('github', 'push', handler);

  await expect(router.replayDlqEvent(41, 'ws-requester')).resolves.toEqual({
    success: false,
    error: 'DLQ entry not found or lacks verified delivery provenance',
  });

  const [sql, params] = (queryOne as jest.Mock).mock.calls[0];
  expect(sql).toContain('d.workspace_id = $2');
  expect(sql).toContain('e.workspace_id = d.workspace_id');
  expect(sql).toContain("d.provider IN ('github', 'linear', 'vercel', 'slack')");
  expect(sql).toContain('e.payload_sha256 = d.payload_sha256');
  expect(sql).toContain("e.status = 'failed'");
  expect(sql).toContain('e.signature_verified_at IS NOT NULL');
  expect(params).toEqual([41, 'ws-requester']);
  expect(handler).not.toHaveBeenCalled();
});

test('admin replay rejects a changed stored payload even when provenance columns still match', async () => {
  (queryOne as jest.Mock).mockResolvedValue({
    id: 42,
    provider: 'github',
    event_type: 'push',
    payload: { repository: { id: 100 } },
    error: 'initial handler failure',
    attempts: 3,
    delivery_id: 'delivery-changed',
    workspace_id: 'ws-1',
    payload_sha256: webhookPayloadSha256({ repository: { id: 99 } }),
    verification_method: provenance.method,
    created_at: '2026-07-18T00:00:00.000Z',
    resolved_at: null,
  });
  const router = new WebhookRouter();
  const handler = jest.fn();
  router.on('github', 'push', handler);

  await expect(router.replayDlqEvent(42, 'ws-1')).resolves.toEqual({
    success: false,
    error: 'DLQ entry not found or lacks verified delivery provenance',
  });
  expect(handler).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test('admin replay uses exact verified ledger provenance without requiring a fresh signature', async () => {
  const payload = { repository: { id: 99 }, ref: 'refs/heads/main' };
  const replayPayloadSha256 = webhookPayloadSha256(payload);
  (queryOne as jest.Mock).mockResolvedValue({
    id: 42,
    provider: 'github',
    event_type: 'push',
    payload,
    error: 'initial handler failure',
    attempts: 3,
    delivery_id: 'delivery-verified',
    workspace_id: 'ws-1',
    payload_sha256: replayPayloadSha256,
    verification_method: provenance.method,
    created_at: '2026-07-18T00:00:00.000Z',
    resolved_at: null,
  });
  (execute as jest.Mock).mockResolvedValue({ rowCount: 1 });
  const router = new WebhookRouter();
  const handler = jest.fn(async () => undefined);
  router.on('github', 'push', handler);

  await expect(router.replayDlqEvent(42, 'ws-1')).resolves.toEqual({ success: true });
  expect(handler).toHaveBeenCalledWith(payload, {
    deliveryId: 'delivery-verified',
    workspaceId: 'ws-1',
  });
  expect(execute).toHaveBeenCalledWith(expect.stringContaining('workspace_id = $2'), [
    42, 'ws-1', replayPayloadSha256, provenance.method,
  ]);
});
