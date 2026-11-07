/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { NextFunction, Request, Response } from 'express';
import { requirePlatformAdmin } from '../auth-utils';

function response() {
  const res = {
    status: jest.fn(), json: jest.fn(),
  } as unknown as Response;
  (res.status as jest.Mock).mockReturnValue(res);
  return res;
}

test('ordinary workspace administrator has no process-global App registration authority', () => {
  const req = { user: {
    id: 'workspace-admin', email: 'workspace@example.test', supabaseId: 'auth-workspace', role: 'user',
  } } as Request;
  const res = response();
  const next = jest.fn() as NextFunction;
  requirePlatformAdmin()(req, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});

test('explicit platform administrator may continue to the workspace membership gate/handler', () => {
  const req = { user: {
    id: 'platform-admin', email: 'platform@example.test', supabaseId: 'auth-platform', role: 'admin',
  } } as Request;
  const res = response();
  const next = jest.fn() as NextFunction;
  requirePlatformAdmin()(req, res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});
