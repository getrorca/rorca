/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * BL-013: Self-hosted license activation via RORCA_LICENSE_KEY env var.
 *
 * Tests:
 * 1. Valid RORCA_LICENSE_KEY allows requirePlan (env var wins over DB)
 * 2. Expired RORCA_LICENSE_KEY falls through to DB check (does not hard-reject)
 * 3. GET /api/billing/status returns selfHostedLicense status
 * 4. POST /api/admin/generate-license works with proper admin key
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Express } from 'express';
import express from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { createSignedLicense, verifyLicense } from '../../lib/license-verifier';
import { authRequired } from '../../lib/auth-utils';
import { requirePlan } from '../../lib/require-plan';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

// Generate a test RSA keypair
const { publicKey: TEST_PUBLIC_KEY, privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signTestLicense(payload: Record<string, unknown>, privateKey: string = TEST_PRIVATE_KEY): string {
  return createSignedLicense(payload as any, privateKey);
}

let app: Express;
let tmpDir: string;
let authToken: string;
let adminToken: string;

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-license-env-'));
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  process.env.RORCA_LICENSE_PUBLIC_KEY = TEST_PUBLIC_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.RORCA_LICENSE_KEY;
  delete process.env.RORCA_ADMIN_KEY;
  delete process.env.RORCA_LICENSE_PRIVATE_KEY;

  // Clean stale auth state BEFORE requiring server (prevents login 401 from prior runs)
  const { Pool } = require('pg');
  const cleanPool = new Pool({ connectionString: process.env.DATABASE_URL });
  await cleanPool.query("DELETE FROM login_attempts WHERE email = 'testauth@example.com'");
  await cleanPool.query("DELETE FROM users WHERE email = 'testauth@example.com'");
  await cleanPool.end();

  const serverMod = require('../../server');
  app = serverMod.default;
  const seedAdmin = await ensureTestUser({
    email: 'seed-admin@example.com',
    authId: crypto.randomUUID(),
    role: 'admin',
    plan: 'pro',
  });
  adminToken = await getAuthToken(app, { email: seedAdmin.email, authId: seedAdmin.authId });
  authToken = await getAuthToken(app);

  // Clean billing state
  const { execute } = require('../../db/index');
  await execute('DELETE FROM subscriptions');
  await execute("UPDATE users SET plan = 'free'");
});

afterEach(async () => {
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.RORCA_LICENSE_KEY;
  delete process.env.RORCA_LICENSE_PUBLIC_KEY;
  delete process.env.RORCA_ADMIN_KEY;
  delete process.env.RORCA_LICENSE_PRIVATE_KEY;
  delete process.env.AUTH_REQUIRED;
});

describe('BL-013: RORCA_LICENSE_KEY env var in requirePlan', () => {
  test('valid RORCA_LICENSE_KEY allows requirePlan', async () => {
    const licenseKey = signTestLicense({
      sub: 'selfhosted@example.com',
      plan: 'pro',
      iss: 'rorca',
    });
    process.env.RORCA_LICENSE_KEY = licenseKey;

    const gatedApp = express();
    gatedApp.use(express.json());
    gatedApp.post('/gated', authRequired, requirePlan('workspaces'), (_req, res) => {
      res.status(201).json({ ok: true });
    });

    const res = await request(gatedApp)
      .post('/gated')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(201);
  });

  test('expired RORCA_LICENSE_KEY falls through to DB check (does not hard-reject)', async () => {
    // Expired license — should fall through to DB, not hard-reject
    const licenseKey = signTestLicense({
      sub: 'expired@example.com',
      plan: 'pro',
      iss: 'rorca',
      expiresAt: new Date(Date.now() - 86400 * 1000).toISOString(),
    });
    process.env.RORCA_LICENSE_KEY = licenseKey;

    // Insert an expired trial subscription — requirePlan checks for this and returns 402
    const { execute, queryOne } = require('../../db/index');
    const user = await queryOne(
      'SELECT id FROM users WHERE email = $1',
      ['testauth@example.com'],
    ) as { id: string } | undefined;
    if (user) {
      await execute(
        `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status, trial_started_at, trial_ends_at)
         VALUES ($1, $2, 'license', 'pro', 'trialing', NOW() - INTERVAL '15 days', NOW() - INTERVAL '1 day')`,
        [`sub_test_expired_${Date.now()}`, user.id]
      );
    }

    const gatedApp = express();
    gatedApp.use(express.json());
    gatedApp.post('/gated', authRequired, requirePlan('workspaces'), (_req, res) => {
      res.status(201).json({ ok: true });
    });

    const res = await request(gatedApp)
      .post('/gated')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    // Should fail — expired env var falls through, expired trial in DB → 402
    expect(res.status).toBe(402);
    expect(res.body.trialExpired).toBe(true);
  });
});

describe('BL-013: GET /api/billing/status selfHostedLicense', () => {
  test('returns selfHostedLicense.set=false when env var not set', async () => {
    delete process.env.RORCA_LICENSE_KEY;

    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.selfHostedLicense).toBeDefined();
    expect(res.body.selfHostedLicense.set).toBe(false);
    expect(res.body.selfHostedLicense.valid).toBe(false);
  });

  test('returns selfHostedLicense.valid=true for valid env var license', async () => {
    const licenseKey = signTestLicense({
      sub: 'selfhosted@example.com',
      plan: 'pro',
      iss: 'rorca',
    });
    process.env.RORCA_LICENSE_KEY = licenseKey;

    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.selfHostedLicense.set).toBe(true);
    expect(res.body.selfHostedLicense.valid).toBe(true);
    expect(res.body.selfHostedLicense.plan).toBe('pro');
    // Plan should reflect the env var license plan
    expect(res.body.plan).toBe('pro');
  });

  test('returns selfHostedLicense.valid=true with plan downgraded to free for expired env var license', async () => {
    const licenseKey = signTestLicense({
      sub: 'expired@example.com',
      plan: 'pro',
      iss: 'rorca',
      expiresAt: new Date(Date.now() - 86400 * 1000).toISOString(),
    });
    process.env.RORCA_LICENSE_KEY = licenseKey;

    const res = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.selfHostedLicense.set).toBe(true);
    expect(res.body.selfHostedLicense.valid).toBe(true);
    expect(res.body.selfHostedLicense.plan).toBe('free');
    expect(res.body.selfHostedLicense.error).toMatch(/expired/i);
    expect(res.body.plan).toBe('free');
  });
});

describe('BL-013: POST /api/admin/generate-license', () => {
  test('generates license with valid admin key', async () => {
    process.env.RORCA_ADMIN_KEY = 'test-admin-secret';
    process.env.RORCA_LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/admin/generate-license')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Rorca-Admin-Key', 'test-admin-secret')
      .send({ plan: 'pro', email: 'user@example.com', expiresInDays: 30 });

    expect(res.status).toBe(200);
    expect(res.body.licenseKey).toBeTruthy();
    expect(res.body.plan).toBe('pro');
    expect(res.body.email).toBe('user@example.com');
    expect(res.body.expiresAt).toBeTruthy();

    // Verify the generated license key is valid
    const decoded = verifyLicense(res.body.licenseKey);
    expect(decoded.valid).toBe(true);
    expect(decoded.payload?.sub).toBe('user@example.com');
    expect(decoded.payload?.plan).toBe('pro');
    expect(decoded.payload?.iss).toBe('rorca');
  });

  test('generates perpetual license when expiresInDays omitted', async () => {
    process.env.RORCA_ADMIN_KEY = 'test-admin-secret';
    process.env.RORCA_LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/admin/generate-license')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Rorca-Admin-Key', 'test-admin-secret')
      .send({ plan: 'team', email: 'team@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeNull();

    const decoded = verifyLicense(res.body.licenseKey);
    expect(decoded.valid).toBe(true);
    expect(decoded.expiresAt).toBeNull();
  });

  test('rejects request with missing admin key header', async () => {
    process.env.RORCA_ADMIN_KEY = 'test-admin-secret';
    process.env.RORCA_LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/admin/generate-license')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan: 'pro', email: 'user@example.com' });

    expect(res.status).toBe(401);
  });

  test('rejects request with wrong admin key', async () => {
    process.env.RORCA_ADMIN_KEY = 'test-admin-secret';
    process.env.RORCA_LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/admin/generate-license')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Rorca-Admin-Key', 'wrong-key')
      .send({ plan: 'pro', email: 'user@example.com' });

    expect(res.status).toBe(401);
  });

  test('rejects request with invalid plan', async () => {
    process.env.RORCA_ADMIN_KEY = 'test-admin-secret';
    process.env.RORCA_LICENSE_PRIVATE_KEY = TEST_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/admin/generate-license')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Rorca-Admin-Key', 'test-admin-secret')
      .send({ plan: 'invalid-plan', email: 'user@example.com' });

    expect(res.status).toBe(400);
  });

  test('returns 503 when RORCA_LICENSE_PRIVATE_KEY not set', async () => {
    process.env.RORCA_ADMIN_KEY = 'test-admin-secret';
    delete process.env.RORCA_LICENSE_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/admin/generate-license')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Rorca-Admin-Key', 'test-admin-secret')
      .send({ plan: 'pro', email: 'user@example.com' });

    expect(res.status).toBe(503);
  });
});
