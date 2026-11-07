/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { ValidationError } from '../../lib/errors';
import {
  SUPABASE_CREDENTIAL_CEREMONY_CATALOG,
  type CredentialCeremonySnapshot,
} from '../../lib/supabase-credential-ceremony-authority';
import {
  createCredentialSecureCaptureHandler,
  requireCredentialSecureCaptureMediaType,
  type SupabaseCredentialCeremonyRouteService,
} from '../supabase-credential-ceremonies';

const CEREMONY_ID = '11111111-1111-4111-8111-111111111111';

class CaptureService implements SupabaseCredentialCeremonyRouteService {
  readonly catalog = SUPABASE_CREDENTIAL_CEREMONY_CATALOG;
  materialDuringCapture: Buffer | null = null;
  requestBufferAfterCapture: Buffer | null = null;
  captures = 0;

  async start(): Promise<never> {
    throw new Error('not used');
  }

  async get(): Promise<never> {
    throw new Error('not used');
  }

  async capture(_ceremonyId: string, _slotId: string, material: Buffer): Promise<CredentialCeremonySnapshot> {
    this.captures += 1;
    this.materialDuringCapture = Buffer.from(material);
    this.requestBufferAfterCapture = material;
    return undefined as unknown as CredentialCeremonySnapshot;
  }

  async verifyCanary(): Promise<never> {
    throw new Error('not used');
  }

  async cutover(): Promise<never> {
    throw new Error('not used');
  }

  async revokePrevious(): Promise<never> {
    throw new Error('not used');
  }
}

interface ResponseProbe {
  statusCode: number | null;
  ended: boolean;
  bodyWrites: number;
}

function responseProbe(): { response: Response; probe: ResponseProbe } {
  const probe: ResponseProbe = { statusCode: null, ended: false, bodyWrites: 0 };
  const response = {
    status(code: number) {
      probe.statusCode = code;
      return this;
    },
    end() {
      probe.ended = true;
      return this;
    },
    json() {
      probe.bodyWrites += 1;
      return this;
    },
    send() {
      probe.bodyWrites += 1;
      return this;
    },
  } as unknown as Response;
  return { response, probe };
}

test('secure capture handler returns 204 without a body and zeroes the request buffer', async () => {
  const service = new CaptureService();
  const material = Buffer.from('dashboard-captured-signing-value');
  const req = {
    params: { ceremonyId: CEREMONY_ID, slotId: 'signing-key' },
    body: material,
  } as unknown as Request;
  const { response, probe } = responseProbe();

  await createCredentialSecureCaptureHandler(service)(req, response);

  assert.equal(probe.statusCode, 204);
  assert.equal(probe.ended, true);
  assert.equal(probe.bodyWrites, 0);
  assert.equal(service.captures, 1);
  assert.equal(service.materialDuringCapture?.toString(), 'dashboard-captured-signing-value');
  assert.ok(service.requestBufferAfterCapture?.every((byte) => byte === 0));
  assert.equal(req.body, undefined);
});

test('secure capture media guard rejects ordinary JSON without echoing its value', () => {
  const req = {
    is(mediaType: string) {
      assert.equal(mediaType, 'application/octet-stream');
      return false;
    },
    body: { signingKey: 'must-not-enter-json' },
  } as unknown as Request;
  const { response } = responseProbe();
  let routedError: unknown;
  const next = ((error?: unknown) => {
    routedError = error;
  }) as NextFunction;

  requireCredentialSecureCaptureMediaType(req, response, next);

  assert.ok(routedError instanceof ValidationError);
  assert.doesNotMatch(JSON.stringify(routedError.toJSON()), /must-not-enter-json/);
});

test('secure capture handler rejects non-buffer bodies before calling SecretStore authority', async () => {
  const service = new CaptureService();
  const req = {
    params: { ceremonyId: CEREMONY_ID, slotId: 'signing-key' },
    body: { signingKey: 'must-not-enter-json' },
  } as unknown as Request;
  const { response } = responseProbe();

  await assert.rejects(
    createCredentialSecureCaptureHandler(service)(req, response),
    (error: unknown) => error instanceof ValidationError
      && !JSON.stringify(error.toJSON()).includes('must-not-enter-json'),
  );
  assert.equal(service.captures, 0);
});
