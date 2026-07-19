/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requireProviderMutationAuthority } from '../provider-mutation-authority';

function req(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST', path: '/ws-one/github/app/bind', headers: {},
    ...overrides,
  } as Request;
}

const response = {} as Response;
const next = jest.fn() as NextFunction;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

afterAll(() => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

test('no-Origin localhost-style provider mutation is disabled without an explicit capability digest', () => {
  expect(() => requireProviderMutationAuthority(req({
    headers: { host: '127.0.0.1:3030' },
  }), response, next)).toThrow(/disabled in local mode/);
  expect(next).not.toHaveBeenCalled();
});

test('direct-socket headers cannot substitute for the local operator capability', () => {
  process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = crypto.createHash('sha256').update('operator-only').digest('hex');
  expect(() => requireProviderMutationAuthority(req({
    headers: { host: 'localhost:3030', origin: 'http://localhost:5173' },
  }), response, next)).toThrow(/operator capability/);
  expect(() => requireProviderMutationAuthority(req({
    headers: { 'x-rorca-operator-capability': 'wrong' },
  }), response, next)).toThrow(/operator capability/);
  expect(next).not.toHaveBeenCalled();
});

test('explicit digest preimage authorizes only the provider boundary', () => {
  process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = crypto.createHash('sha256').update('operator-only').digest('hex');
  requireProviderMutationAuthority(req({
    headers: { 'x-rorca-operator-capability': 'operator-only' },
  }), response, next);
  expect(next).toHaveBeenCalledTimes(1);
});

test('AUTH_REQUIRED mode rejects local and internal principals but accepts a real authenticated operator', () => {
  process.env.AUTH_REQUIRED = 'true';
  for (const user of [
    { id: 'local-admin' },
    { id: 'rorca-internal-service' },
    { id: 'system' },
    { id: 'hermes-service', email: 'hermes@rorca.internal' },
    { id: 'scheduler-alias', supabaseId: '00000000-0000-0000-0000-000000000000' },
  ]) {
    expect(() => requireProviderMutationAuthority({
      ...req(), user,
    } as unknown as Request, response, next)).toThrow(/Authenticated operator authority/);
  }
  requireProviderMutationAuthority({ ...req(), user: { id: 'user-1' } } as Request, response, next);
  expect(next).toHaveBeenCalledTimes(1);
});

test('authority middleware is path-agnostic and always fails closed when attached without local configuration', () => {
  for (const [method, requestPath] of [
    ['POST', '/ws-one/github/connect'],
    ['POST', '/ws-one/github/disconnect-oauth'],
    ['DELETE', '/ws-one/github'],
    ['POST', '/ws-one/github/delivery-evidence'],
    ['POST', '/api/github/checks/abc'],
    ['POST', '/api/webhooks/dlq/1/retry'],
  ]) {
    expect(() => requireProviderMutationAuthority(req({ method, path: requestPath }), response, next))
      .toThrow(/disabled in local mode/);
  }
  expect(next).not.toHaveBeenCalled();
});
