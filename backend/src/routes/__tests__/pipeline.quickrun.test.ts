/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/** DB-free behavioral proof that retired quick-run returns before every mutation. */

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockExecute = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../../db/index', () => ({
  query: mockQuery,
  queryOne: mockQueryOne,
  execute: mockExecute,
  transaction: mockTransaction,
  getPool: jest.fn(),
  pool: {},
}));

jest.mock('../../lib/pg-boss', () => ({
  getBoss: jest.fn(),
  getBossState: jest.fn(() => 'stopped'),
}));

import pipelineRouter from '../pipeline';

function quickRunHandler(): (req: unknown, res: unknown) => unknown {
  const layer = (pipelineRouter as any).stack.find((entry: any) => entry.route?.path === '/quick-run');
  if (!layer) throw new Error('quick-run route not mounted');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

beforeEach(() => jest.clearAllMocks());

test('returns truthful 409 without DB, model, environment, filesystem, WAL, or spawn mutation', async () => {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();
  await quickRunHandler()(
    { body: { workspaceId: 'must-not-be-read', brief: 'must-not-be-read' } },
    { status, json },
  );

  expect(status).toHaveBeenCalledWith(409);
  expect(json).toHaveBeenCalledWith({
    error: 'quick_run_retired',
    message: 'Quick-run is retired. Persist and approve a spec, then use the canonical pipeline trigger API.',
  });
  expect(mockQuery).not.toHaveBeenCalled();
  expect(mockQueryOne).not.toHaveBeenCalled();
  expect(mockExecute).not.toHaveBeenCalled();
  expect(mockTransaction).not.toHaveBeenCalled();
});
