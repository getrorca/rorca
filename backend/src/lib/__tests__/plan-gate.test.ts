/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import type { Request, Response } from 'express';
import { planGate } from '../plan-gate';
import { getEffectiveUser } from '../get-user';
import { matchOperationFromRoute } from '../tier-auth';

jest.mock('../get-user', () => ({
  getEffectiveUser: jest.fn(),
}));

jest.mock('../tier-auth', () => {
  const actual = jest.requireActual('../tier-auth');
  return {
    ...actual,
    matchOperationFromRoute: jest.fn(),
  };
});

const mockedGetEffectiveUser = getEffectiveUser as jest.MockedFunction<typeof getEffectiveUser>;
const mockedMatchOperationFromRoute = matchOperationFromRoute as jest.MockedFunction<typeof matchOperationFromRoute>;

function createRes(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createReq(method = 'GET', path = '/api/test'): Request {
  return { method, path } as Request;
}

describe('planGate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.RORCA_LICENSE_KEY;
  });

  test('public route passes without auth', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({ 'x-rorca-tier': 'public' });
    mockedGetEffectiveUser.mockResolvedValue(null);

    const req = createReq();
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('auth route without auth returns 401', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({ 'x-rorca-tier': 'auth' });
    mockedGetEffectiveUser.mockResolvedValue(null);

    const req = createReq();
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required', code: 'AUTH_ERROR' });
    expect(next).not.toHaveBeenCalled();
  });

  test('auth route allows LOCAL_ADMIN', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({ 'x-rorca-tier': 'auth' });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: '00000000-0000-0000-0000-000000000001',
      role: 'admin',
      plan: 'pro',
    });

    const req = createReq();
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('paid route on free plan returns 402', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({
      'x-rorca-tier': 'paid',
      'x-rorca-capability': 'teams',
    });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'user-1',
      email: 'free@example.com',
      supabaseId: 'supabase-1',
      role: 'user',
      plan: 'free',
    });

    const req = createReq('POST', '/api/teams');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Payment Required',
      code: 'PLAN_REQUIRED',
      requiredCapability: 'teams',
      currentPlan: 'free',
      upgradeUrl: 'https://rorca.app/pricing',
      hint: "This feature requires a plan with 'teams'. Current plan: free.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('paid route on pro plan with required capability passes', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({
      'x-rorca-tier': 'paid',
      'x-rorca-capability': 'teams',
    });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'user-2',
      email: 'pro@example.com',
      supabaseId: 'supabase-2',
      role: 'user',
      plan: 'pro',
    });

    const req = createReq('POST', '/api/teams');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('paid route on pro plan without required capability returns 402', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({
      'x-rorca-tier': 'paid',
      'x-rorca-capability': 'multiEntity',
    });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'user-3',
      email: 'pro@example.com',
      supabaseId: 'supabase-3',
      role: 'user',
      plan: 'pro',
    });

    const req = createReq('GET', '/api/some-multi-entity');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Payment Required',
      code: 'PLAN_REQUIRED',
      requiredCapability: 'multiEntity',
      currentPlan: 'pro',
      upgradeUrl: 'https://rorca.app/pricing',
      hint: "This feature requires a plan with 'multiEntity'. Current plan: pro.",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test('paid route allows LOCAL_ADMIN in local single-user mode', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({
      'x-rorca-tier': 'paid',
      'x-rorca-capability': 'teams',
    });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'local-admin',
      email: 'admin@rorca.local',
      supabaseId: '00000000-0000-0000-0000-000000000001',
      role: 'admin',
      plan: 'pro',
    });

    const req = createReq('POST', '/api/teams');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('admin route on non-admin user returns 403', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({ 'x-rorca-tier': 'admin' });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'user-4',
      email: 'user@example.com',
      supabaseId: 'supabase-4',
      role: 'user',
      plan: 'team',
    });

    const req = createReq('POST', '/api/admin/generate-license');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Admin role required', code: 'ADMIN_REQUIRED' });
    expect(next).not.toHaveBeenCalled();
  });

  test('admin route on admin user passes', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({ 'x-rorca-tier': 'admin' });
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      supabaseId: 'supabase-5',
      role: 'admin',
      plan: 'enterprise',
    });

    const req = createReq('POST', '/api/admin/generate-license');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('denied route returns 404', async () => {
    mockedMatchOperationFromRoute.mockReturnValue({});
    mockedGetEffectiveUser.mockResolvedValue({
      id: 'user-5',
      email: 'user@example.com',
      supabaseId: 'supabase-6',
      role: 'user',
      plan: 'team',
    });

    const req = createReq('GET', '/api/internal');
    const res = createRes();
    const next = jest.fn();

    await planGate()(req, res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' });
    expect(next).not.toHaveBeenCalled();
  });
});
