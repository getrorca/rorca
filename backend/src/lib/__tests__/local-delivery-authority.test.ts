/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { NextFunction, Request, Response } from 'express';

const queryOneMock = jest.fn();
jest.mock('../../db/index', () => ({ queryOne: (...args: unknown[]) => queryOneMock(...args) }));

import { LOCAL_ADMIN } from '../auth-utils';
import { requireLocalDeliveryCreationAuthority } from '../local-delivery-authority';

const originalAuthRequired = process.env.AUTH_REQUIRED;

afterEach(() => {
  jest.clearAllMocks();
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
});

async function invoke(user: Request['user']): Promise<jest.Mock> {
  const next = jest.fn();
  await requireLocalDeliveryCreationAuthority(
    { user, body: { workspaceId: 'workspace-one' } } as Request,
    {} as Response,
    next as NextFunction,
  );
  return next;
}

test('accepts only the exact local human in local mode', async () => {
  delete process.env.AUTH_REQUIRED;
  expect(await invoke(LOCAL_ADMIN)).toHaveBeenCalledWith();
  const rejected = await invoke({ ...LOCAL_ADMIN, id: 'system' });
  expect(rejected.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  expect(queryOneMock).not.toHaveBeenCalled();
});

test('hosted human creation is truthfully disabled without membership reads', async () => {
  process.env.AUTH_REQUIRED = 'true';
  for (const user of [
    { id: 'human-admin', email: 'owner@example.test', supabaseId: 'human-auth', role: 'admin' },
    { id: 'other-admin', email: 'other@example.test', supabaseId: 'other-auth', role: 'admin' },
    { id: 'human-member', email: 'member@example.test', supabaseId: 'member-auth', role: 'user' },
    { id: 'rorca-hermes-service', email: 'hermes@rorca.internal', supabaseId: 'service-auth', role: 'admin' },
    LOCAL_ADMIN,
  ]) {
    const rejected = await invoke(user);
    expect(rejected.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
  }
  expect(queryOneMock).not.toHaveBeenCalled();
});
