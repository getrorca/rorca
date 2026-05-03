/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'crypto';
import { createSignedLicense, verifyLicense } from '../license-verifier';

const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('license-verifier', () => {
  beforeEach(() => {
    process.env.RORCA_LICENSE_PUBLIC_KEY = TEST_PUBLIC_KEY;
  });

  afterEach(() => {
    delete process.env.RORCA_LICENSE_PUBLIC_KEY;
  });

  it('verifies a valid detached license key', () => {
    const licenseKey = createSignedLicense({
      sub: 'user@example.com',
      plan: 'pro',
      iss: 'rorca',
      issuedAt: new Date().toISOString(),
    }, TEST_PRIVATE_KEY);

    const result = verifyLicense(licenseKey);

    expect(result.valid).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.payload?.sub).toBe('user@example.com');
  });

  it('downgrades expired licenses to free without throwing', () => {
    const licenseKey = createSignedLicense({
      sub: 'user@example.com',
      plan: 'enterprise',
      iss: 'rorca',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, TEST_PRIVATE_KEY);

    const result = verifyLicense(licenseKey);

    expect(result.valid).toBe(true);
    expect(result.plan).toBe('free');
    expect(result.error).toMatch(/expired/i);
    expect(result.expiresAt).toBeInstanceOf(Date);
  });

  it('returns free on malformed or tampered keys', () => {
    const malformed = verifyLicense('not-a-license');
    expect(malformed.valid).toBe(false);
    expect(malformed.plan).toBe('free');

    const validKey = createSignedLicense({
      sub: 'user@example.com',
      plan: 'team',
      iss: 'rorca',
    }, TEST_PRIVATE_KEY);
    const [payloadB64] = validKey.split('.');
    const tampered = verifyLicense(`${payloadB64}.tampered`);

    expect(tampered.valid).toBe(false);
    expect(tampered.plan).toBe('free');
  });
});
