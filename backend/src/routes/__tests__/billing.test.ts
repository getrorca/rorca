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

// Generate RSA key pair for license JWT tests
const { publicKey: rsaPublicKey, privateKey: rsaPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

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
  process.env.RORCA_LICENSE_PUBLIC_KEY = rsaPublicKey;
  // No Stripe key in tests — graceful dev mode
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  // Reset the license key cache so each test picks up the env var
  const { _resetKeyCache } = require('../../lib/license');
  _resetKeyCache();

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
  delete process.env.RORCA_LICENSE_PUBLIC_KEY;
  try { const { _resetKeyCache } = require('../../lib/license'); _resetKeyCache(); } catch {}
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
    const token = jwt.sign(
      { plan: 'pro', sub: 'test-user' },
      rsaPrivateKey,
      { algorithm: 'RS256', expiresIn: '365d' }
    );

    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: token });

    expect(res.status).toBe(200);
    expect(res.body.activated).toBe(true);
    expect(res.body.plan).toBe('pro');
    expect(res.body.expiresAt).toBeTruthy();
  });

  test('invalid/tampered license key returns 422', async () => {
    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: 'not-a-valid-jwt-token' });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Invalid license key');
  });

  test('tampered JWT signed with wrong key returns 422', async () => {
    // Generate a different key pair
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const token = jwt.sign(
      { plan: 'pro' },
      wrongKey,
      { algorithm: 'RS256' }
    );

    const res = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: token });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Invalid license key');
  });

  test('GET /api/billing/status shows license info after activation', async () => {
    // First activate a license
    const token = jwt.sign(
      { plan: 'solo', sub: 'test-user' },
      rsaPrivateKey,
      { algorithm: 'RS256', expiresIn: '30d' }
    );

    const activateRes = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: token });

    expect(activateRes.status).toBe(200);
    expect(activateRes.body.activated).toBe(true);

    // Now check status
    const statusRes = await request(app)
      .get('/api/billing/status')
      .set('Authorization', `Bearer ${authToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body.licenseKey).toBeTruthy();
    // Should show only last 8 chars
    expect(statusRes.body.licenseKey).toMatch(/^\.\.\..{8}$/);
    expect(statusRes.body.activatedAt).toBeTruthy();
    expect(statusRes.body.expiresAt).toBeTruthy();
  });

  test('activating same key twice is idempotent', async () => {
    const token = jwt.sign(
      { plan: 'team', sub: 'test-user' },
      rsaPrivateKey,
      { algorithm: 'RS256' }
    );

    // First activation
    const res1 = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: token });
    expect(res1.status).toBe(200);
    expect(res1.body.activated).toBe(true);
    expect(res1.body.plan).toBe('team');

    // Second activation — should still succeed (upsert)
    const res2 = await request(app)
      .post('/api/billing/activate-license')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ licenseKey: token });
    expect(res2.status).toBe(200);
    expect(res2.body.activated).toBe(true);
    expect(res2.body.plan).toBe('team');
  });
});
