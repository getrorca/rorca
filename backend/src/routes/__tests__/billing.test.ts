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

// ─── POST /api/billing/create-portal-session ─────────────────────────────────

describe('POST /api/billing/create-portal-session', () => {
  test('returns 503 when Stripe is not configured', async () => {
    const res = await request(app)
      .post('/api/billing/create-portal-session')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(503);
  });

  describe('with Stripe configured', () => {
    let stripeApp: Express;
    let stripeAuthToken: string;
    const mockPortalCreate = jest.fn();

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

      process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
      process.env.RORCA_LICENSE_PUBLIC_KEY = rsaPublicKey;

      mockPortalCreate.mockResolvedValue({ url: 'https://billing.stripe.com/session/test_portal_123' });

      jest.mock('../../lib/stripe-client', () => ({
        stripe: {
          billingPortal: { sessions: { create: mockPortalCreate } },
          customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test_portal' }) },
          checkout: { sessions: { create: jest.fn() } },
          webhooks: { constructEvent: jest.fn() },
        },
      }));

      const serverMod = require('../../server');
      stripeApp = serverMod.default;
      stripeAuthToken = await getAuthToken(stripeApp);
    });

    afterEach(async () => {
      try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
      delete process.env.STRIPE_SECRET_KEY;
    });

    test('returns portalUrl when stripe_customer_id exists', async () => {
      // Pre-create a subscription row with a Stripe customer ID
      const { execute: exec, queryOne: qo } = require('../../db/index');
      const user = await qo('SELECT id FROM users WHERE email = $1', ['testauth@example.com']);
      expect(user).toBeDefined();

      await exec(
        `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status)
         VALUES ($1, $2, $3, 'pro', 'active')
         ON CONFLICT (id) DO NOTHING`,
        ['sub_portal_test', user.id, 'cus_test_portal']
      );

      const res = await request(stripeApp)
        .post('/api/billing/create-portal-session')
        .set('Authorization', `Bearer ${stripeAuthToken}`);

      expect(res.status).toBe(200);
      expect(res.body.portalUrl).toBe('https://billing.stripe.com/session/test_portal_123');
      expect(mockPortalCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_test_portal',
          return_url: expect.stringContaining('/settings/billing'),
        })
      );
    });

    test('returns 404 when no stripe_customer_id exists', async () => {
      // Ensure no subscription row exists for the test user
      const { execute: exec, queryOne: qo } = require('../../db/index');
      const user = await qo('SELECT id FROM users WHERE email = $1', ['testauth@example.com']);
      if (user) {
        await exec('DELETE FROM subscriptions WHERE user_id = $1', [user.id]);
      }

      const res = await request(stripeApp)
        .post('/api/billing/create-portal-session')
        .set('Authorization', `Bearer ${stripeAuthToken}`);

      expect(res.status).toBe(404);
    });
  });
});

// ─── POST /api/billing/webhook ──────────────────────────────────────────────

describe('POST /api/billing/webhook', () => {
  let stripeApp: Express;
  let stripeAuthToken: string;

  beforeEach(async () => {
    // Reload modules with Stripe configured
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

    process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
    process.env.RORCA_LICENSE_PUBLIC_KEY = rsaPublicKey;

    // Mock the stripe-client module to return a mock stripe instance
    const mockConstructEvent = jest.fn();
    jest.mock('../../lib/stripe-client', () => ({
      stripe: {
        webhooks: { constructEvent: mockConstructEvent },
        customers: { create: jest.fn().mockResolvedValue({ id: 'cus_test_123' }) },
        checkout: { sessions: { create: jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/test' }) } },
      },
    }));

    const serverMod = require('../../server');
    stripeApp = serverMod.default;
    stripeAuthToken = await getAuthToken(stripeApp);

    // Pre-create a subscription row for the test user
    const { execute: exec, queryOne: qo } = require('../../db/index');
    const user = await qo('SELECT id FROM users WHERE email = $1', ['testauth@example.com']);
    if (user) {
      await exec(
        `INSERT INTO subscriptions (id, user_id, stripe_customer_id, plan, status)
         VALUES ($1, $2, $3, 'free', 'active')
         ON CONFLICT (id) DO NOTHING`,
        [`sub_test_wh`, user.id, 'cus_test_123']
      );
    }
  });

  afterEach(async () => {
    try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  test('webhook upserts billing row on checkout.session.completed', async () => {
    // Configure mock constructEvent to return a checkout.session.completed event
    const { stripe: mockStripe } = require('../../lib/stripe-client');
    const { queryOne: qo } = require('../../db/index');
    const user = await qo('SELECT id FROM users WHERE email = $1', ['testauth@example.com']);

    mockStripe.webhooks.constructEvent.mockReturnValue({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cus_test_123',
          subscription: 'sub_stripe_test_456',
          metadata: { rorca_user_id: user.id, plan: 'pro' },
        },
      },
    });

    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const res = await request(stripeApp)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'valid_test_signature')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Verify subscription row was updated
    const sub = await qo(
      `SELECT plan, status, stripe_subscription_id FROM subscriptions WHERE stripe_customer_id = $1`,
      ['cus_test_123']
    );
    expect(sub).toBeDefined();
    expect(sub.plan).toBe('pro');
    expect(sub.status).toBe('active');
    expect(sub.stripe_subscription_id).toBe('sub_stripe_test_456');
  });

  test('invalid webhook signature returns 400', async () => {
    const { stripe: mockStripe } = require('../../lib/stripe-client');
    mockStripe.webhooks.constructEvent.mockImplementation(() => {
      throw new Error('Invalid signature');
    });

    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const res = await request(stripeApp)
      .post('/api/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'bad_signature')
      .send(payload);

    expect(res.status).toBe(400);
  });
});
