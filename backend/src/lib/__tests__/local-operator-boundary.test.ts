/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { LOCAL_ADMIN } from '../auth-utils';
import {
  configuredLocalOrigins,
  isConfiguredLocalOrigin,
  requireLocalOperatorBoundary,
} from '../local-operator-boundary';

const CAPABILITY = 'focused-local-operator-capability';

function invoke(overrides: {
  origin?: string;
  address?: string;
  capability?: string;
} = {}) {
  const headers: Record<string, string> = {};
  if (overrides.origin !== undefined) headers.origin = overrides.origin;
  if (overrides.capability !== undefined) headers['x-rorca-operator-capability'] = overrides.capability;
  const req = {
    user: LOCAL_ADMIN,
    headers,
    socket: { remoteAddress: overrides.address ?? '127.0.0.1' },
  } as unknown as Request;
  const errors: unknown[] = [];
  const next: NextFunction = (error?: unknown) => { if (error !== undefined) errors.push(error); };
  requireLocalOperatorBoundary(req, {} as Response, next);
  return errors;
}

beforeEach(() => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.CORS_ORIGIN;
  delete process.env.RORCA_SERVE_STATIC;
  process.env.RORCA_OPERATOR_CAPABILITY_SHA256 = crypto.createHash('sha256').update(CAPABILITY).digest('hex');
});

afterEach(() => {
  delete process.env.RORCA_OPERATOR_CAPABILITY_SHA256;
});

test('accepts an exact configured local browser origin and capability', () => {
  expect(invoke({ origin: 'http://localhost:5210', capability: CAPABILITY })).toEqual([]);
});

test('rejects forged origins, remote peers, and missing capability independently', () => {
  expect(invoke({ origin: 'http://localhost.attacker.test:5210', capability: CAPABILITY })[0]).toMatchObject({ statusCode: 403 });
  expect(invoke({ address: '10.0.0.5', capability: CAPABILITY })[0]).toMatchObject({ statusCode: 403 });
  expect(() => invoke()).toThrow(/operator capability/i);
});

test('static mode never reflects arbitrary browser origins', () => {
  process.env.RORCA_SERVE_STATIC = '1';
  expect(configuredLocalOrigins()).toEqual(expect.objectContaining({ size: 4 }));
  expect(isConfiguredLocalOrigin('https://attacker.example')).toBe(false);
  expect(isConfiguredLocalOrigin('http://localhost:3030')).toBe(true);
});
