/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

const mockQueryOne = jest.fn();

jest.mock('../../db/index', () => ({
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
}));

import { findLivePipelineRunTransport } from '../pipeline-job-inventory';

beforeEach(() => {
  jest.clearAllMocks();
});

test('worker-crash recovery preserves a live direct-lane transport', async () => {
  mockQueryOne.mockImplementation(async (sqlValue: unknown, params: unknown[]) => {
    const sql = String(sqlValue);
    if (sql.includes("'pipeline:run:direct'")
      && sql.includes("state IN ('created', 'active', 'retry')")
      && params[0] === '9007199254740993') {
      return { id: '11111111-1111-4111-8111-111111111111' };
    }
    return undefined;
  });

  await expect(findLivePipelineRunTransport(
    '9007199254740993',
    '"pgboss"."job"',
  )).resolves.toEqual({ id: '11111111-1111-4111-8111-111111111111' });
  expect(mockQueryOne).toHaveBeenCalledTimes(1);
});

test('cleanup can proceed only when no fresh, direct, or retry transport is live', async () => {
  mockQueryOne.mockResolvedValue(undefined);
  await expect(findLivePipelineRunTransport(41, '"pgboss"."job"')).resolves.toBeUndefined();
});
