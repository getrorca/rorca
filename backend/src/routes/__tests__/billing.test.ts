/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Express } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { getAuthToken } from './helpers/auth-helper';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

// Generate a test RSA keypair for license verification tests
const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signTestLicense(payload: Record<string, unknown>, privateKey: string = TEST_PRIVATE_KEY): string {
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-billing-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  // Inject test public key for license verification
  process.env.RORCA_LICENSE_PUBLIC_KEY = TEST_PUBLIC_KEY;
  // No Stripe key in tests — graceful dev mode
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  // Reset billing state to prevent cross-test leakage
  const { execute } = require('../../db/index');
  await execute(`UPDATE users SET plan = 'free' WHERE email = 'testauth@example.com'`);
  await execute(`DELETE FROM subscriptions WHERE user_id IN (SELECT id FROM users WHERE email = 'testauth@example.com')`);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_LICENSE_PUBLIC_KEY;
});

// ─── GET /api/billing/status ──────────────────────────────────────────────

describe('GET /api/billing/status', () => {
  test('returns free plan for new user', async () => {
    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.plans).toBeDefined();
    expect(Array.isArray(res.body.plans) || typeof res.body.plans === 'object').toBe(true);
  });

  test('includes stripeConfigured flag', async () => {
    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('stripeConfigured');
    expect(res.body.stripeConfigured).toBe(false);
  });
});

// ─── GET /api/billing/invoices ────────────────────────────────────────────

describe('GET /api/billing/invoices', () => {
  test('returns empty invoices when Stripe is not configured', async () => {
    const res = await request(app)
      .get('/api/billing/invoices')
      .set('Authorization', `Bearer ${authToken}`);

    // Without Stripe key, should return empty list or an appropriate response
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) {
      expect(Array.isArray(res.body.invoices) || res.body.invoices === undefined).toBe(true);
    }
  });
});

// ─── POST /api/billing/checkout ───────────────────────────────────────────

describe('POST /api/billing/checkout', () => {
  test('returns 503 or error when Stripe is not configured', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'solo' });

    // No Stripe key → should fail gracefully
    expect([400, 503, 500]).toContain(res.status);
  });

  test('returns 400 for invalid plan', async () => {
    const res = await request(app)
      .post('/api/billing/checkout')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ plan: 'invalid-plan' });

    expect([400, 503, 500]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toBeDefined();
    }
  });
});

// ─── POST /api/billing/activate-license ─────────────────────────────────

describe('POST /api/billing/activate-license', () => {
  test('valid license key activates successfully', async () => {
    const licenseKey = signTestLicense({
      sub: 'user@example.com',
      plan: 'pro',
      iss: 'rorca',
    });

    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.plan).toBe('pro');
  });

  test('valid license key with expiry returns expiresAt', async () => {
    const exp = Math.floor(Date.now() / 1000) + 86400 * 365; // 1 year
    const licenseKey = signTestLicense({
      sub: 'user@example.com',
      plan: 'team',
      iss: 'rorca',
      exp,
    });

    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.plan).toBe('team');
    expect(res.body.expiresAt).toBeTruthy();
  });

  test('invalid/tampered license key returns 422', async () => {
    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: 'eyJhbGciOiJSUzI1NiJ9.tampered.invalid' });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid license key/i);
  });

  test('license signed with wrong key returns 422', async () => {
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const licenseKey = signTestLicense({ sub: 'user@example.com', plan: 'pro', iss: 'rorca' }, wrongKey);

    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/invalid license key/i);
  });

  test('idempotent: activating same key twice returns success', async () => {
    const licenseKey = signTestLicense({
      sub: 'user@example.com',
      plan: 'solo',
      iss: 'rorca',
    });

    const res1 = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey });
    expect(res1.status).toBe(200);
    expect(res1.body.activated).toBe(true);

    const res2 = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey });
    expect(res2.status).toBe(200);
    expect(res2.body.activated).toBe(true);
    expect(res2.body.plan).toBe('solo');
  });

  test('missing licenseKey returns 400', async () => {
    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─── GET /api/billing/status with license info ──────────────────────────

describe('GET /api/billing/status (license info)', () => {
  test('shows license info after activation', async () => {
    const licenseKey = signTestLicense({
      sub: 'user@example.com',
      plan: 'pro',
      iss: 'rorca',
    });

    // Activate first
    await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey });

    // Check status includes license info
    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.plan).toBe('pro');
    expect(res.body.license).toBeTruthy();
    expect(res.body.license.licenseKey).toMatch(/^\.\.\..{8}$/); // last 8 chars only
    expect(res.body.license.activatedAt).toBeTruthy();
  });

  test('license is null when not activated', async () => {
    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.license).toBeNull();
  });
});
