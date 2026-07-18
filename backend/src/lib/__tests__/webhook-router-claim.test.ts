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
import { WebhookDispatchError, WebhookRouter } from '../webhook-router';

beforeEach(() => jest.clearAllMocks());

test('atomically claims new delivery and treats a live/completed duplicate as unowned', async () => {
  (queryOne as jest.Mock)
    .mockResolvedValueOnce({ claim_token: '10000000-0000-4000-8000-000000000001', attempt_count: 1 })
    .mockResolvedValueOnce(undefined);
  const router = new WebhookRouter();
  await expect(router.claimDelivery('github', 'delivery-123', 'push', 'ws-1')).resolves.toEqual({
    claimToken: '10000000-0000-4000-8000-000000000001', attempt: 1,
  });
  await expect(router.claimDelivery('github', 'delivery-123', 'push', 'ws-1')).resolves.toBeNull();
  expect(queryOne).toHaveBeenNthCalledWith(1, expect.stringContaining('ON CONFLICT (provider, delivery_id) DO UPDATE'), expect.arrayContaining([
    'github', 'delivery-123', 'push', 'ws-1',
  ]));
});

test('claim SQL bounds failed/stale crash reclamation and preserves identity matching', async () => {
  (queryOne as jest.Mock).mockResolvedValue({ claim_token: '20000000-0000-4000-8000-000000000002', attempt_count: 2 });
  const router = new WebhookRouter();
  await router.claimDelivery('github', 'delivery-redelivery', 'ping', 'ws-1');
  const sql = String((queryOne as jest.Mock).mock.calls[0][0]);
  expect(sql).toContain("webhook_events.status = 'failed'");
  expect(sql).toContain("webhook_events.status = 'processing'");
  expect(sql).toContain('processing_started_at < $6');
  expect(sql).toContain('attempt_count < $7');
  expect(sql).toContain('event_type = EXCLUDED.event_type');
  expect(sql).toContain('workspace_id IS NOT DISTINCT FROM EXCLUDED.workspace_id');
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
      deliveryId: 'delivery-failed', workspaceId: 'ws-1',
    });
    const rejection = expect(dispatched).rejects.toBeInstanceOf(WebhookDispatchError);
    await jest.runAllTimersAsync();
    await rejection;
    expect(handler).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO webhook_dlq'), expect.arrayContaining([
      'github', 'push', expect.any(String), 'handler failed', 3, 'delivery-failed', 'ws-1',
    ]));
  } finally {
    jest.useRealTimers();
  }
});
