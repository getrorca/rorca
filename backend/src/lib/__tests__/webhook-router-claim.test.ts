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

import { execute } from '../../db/index';
import { WebhookRouter } from '../webhook-router';

test('atomically claims a GitHub delivery without overwrite-on-conflict replay', async () => {
  (execute as jest.Mock).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
  const router = new WebhookRouter();
  await expect(router.claimDelivery('github', 'delivery-123', 'push', 'ws-1')).resolves.toBe(true);
  await expect(router.claimDelivery('github', 'delivery-123', 'push', 'ws-1')).resolves.toBe(false);
  expect(execute).toHaveBeenNthCalledWith(1, expect.stringContaining('ON CONFLICT (provider, delivery_id) DO NOTHING'), [
    'github', 'delivery-123', 'push', 'ws-1',
  ]);
});
