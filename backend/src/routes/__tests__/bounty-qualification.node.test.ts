/** Copyright (c) 2026 Rorca Inc. SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { AdminRequiredError } from '../../lib/errors';
import { readBountyQualification, requireBountyAdmin } from '../bounty-policy';

function request(role: string): Request {
  return {
    user: {
      id: 'qualification-operator',
      email: 'operator@example.test',
      supabaseId: '11111111-1111-4111-8111-111111111111',
      role,
    },
    authSource: 'local-fallback',
  } as Request;
}

test('qualification route handler is non-enabling and exposes bounded counts without I/O', () => {
  let status = 0;
  let body: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as unknown as Response;

  readBountyQualification(request('admin'), response);

  assert.equal(status, 200);
  assert.deepEqual(body, {
    state: 'requalification-required',
    featureState: 'disabled',
    releaseEnableAvailable: false,
    qualificationMode: 'hermetic',
    requiredSuiteCount: 14,
    fixturePassedSuiteCount: 14,
    requiredControlProofCount: 7,
    requalificationTriggerCount: 14,
    reason: 'Hermetic fixture certification passed; an exact post-commit receipt is required before enablement.',
  });
});

test('qualification route middleware denies non-admin identities before the handler', () => {
  let error: unknown;
  const next: NextFunction = (value?: unknown) => { error = value; };
  requireBountyAdmin(request('user'), {} as Response, next);
  assert.ok(error instanceof AdminRequiredError);

  error = 'not-called';
  requireBountyAdmin(request('admin'), {} as Response, next);
  assert.equal(error, undefined);
});
