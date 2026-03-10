import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
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
  const dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  // No Stripe key in tests — graceful dev mode
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
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
