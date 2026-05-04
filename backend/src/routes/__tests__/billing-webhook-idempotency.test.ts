/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

// Mock Stripe to bypass signature verification
const mockConstructEvent = jest.fn();
jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: mockConstructEvent,
    },
    customers: { create: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
    invoices: { list: jest.fn().mockResolvedValue({ data: [] }) },
  }));
});

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

function makeStripeEvent(id: string, type: string, data: Record<string, unknown> = {}) {
  return {
    id,
    type,
    data: {
      object: {
        id: 'sub_test123',
        customer: 'cus_test123',
        status: 'active',
        items: { data: [{ price: { id: 'price_test' } }] },
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 2592000,
        ...data,
      },
    },
  };
}

beforeEach(async () => {
  jest.resetModules();

  jest.mock('stripe', () => {
    return jest.fn().mockImplementation(() => ({
      webhooks: {
        constructEvent: mockConstructEvent,
      },
      customers: { create: jest.fn() },
      checkout: { sessions: { create: jest.fn() } },
      billingPortal: { sessions: { create: jest.fn() } },
      invoices: { list: jest.fn().mockResolvedValue({ data: [] }) },
    }));
  });

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-billing-idem-test-'));
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  mockConstructEvent.mockReset();
});

afterEach(async () => {
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

describe('POST /api/billing/webhook — idempotency (BL-012)', () => {
  test('new event ID processes and inserts idempotency record', async () => {
    const event = makeStripeEvent('evt_new_001', 'customer.subscription.updated');
    mockConstructEvent.mockReturnValue(event);

    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event));

    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);

    // Verify idempotency record was created
    const { queryOne } = require('../../db/index');
    const record = await queryOne(
      `SELECT id, event_type FROM stripe_webhook_events WHERE id = $1`,
      ['evt_new_001']
    );
    expect(record).toBeDefined();
    expect(record.id).toBe('evt_new_001');
    expect(record.event_type).toBe('customer.subscription.updated');
  });

  test('duplicate event ID returns 200 without re-processing', async () => {
    const event = makeStripeEvent('evt_dup_001', 'customer.subscription.created');
    mockConstructEvent.mockReturnValue(event);

    // First call — processes the event
    const res1 = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event));

    expect(res1.status).toBe(200);
    expect(res1.body.received).toBe(true);

    // Second call — same event ID, should be idempotent
    const res2 = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event));

    expect(res2.status).toBe(200);
    expect(res2.body.received).toBe(true);

    // Verify only one idempotency record exists (PK constraint ensures this)
    const { query } = require('../../db/index');
    const records = await query(
      `SELECT id FROM stripe_webhook_events WHERE id = $1`,
      ['evt_dup_001']
    );
    expect(records.length).toBe(1);
  });

  test('different event IDs are processed independently', async () => {
    const event1 = makeStripeEvent('evt_a_001', 'customer.subscription.updated');
    const event2 = makeStripeEvent('evt_b_002', 'customer.subscription.updated');

    mockConstructEvent.mockReturnValueOnce(event1);
    const res1 = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event1));
    expect(res1.status).toBe(200);

    mockConstructEvent.mockReturnValueOnce(event2);
    const res2 = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event2));
    expect(res2.status).toBe(200);

    // Both should have idempotency records
    const { query } = require('../../db/index');
    const records = await query(
      `SELECT id FROM stripe_webhook_events ORDER BY id`
    );
    const ids = records.map((r: { id: string }) => r.id);
    expect(ids).toContain('evt_a_001');
    expect(ids).toContain('evt_b_002');
  });

  test('subscription.deleted event is also idempotent', async () => {
    const event = makeStripeEvent('evt_del_001', 'customer.subscription.deleted');
    mockConstructEvent.mockReturnValue(event);

    const res1 = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event));
    expect(res1.status).toBe(200);

    // Duplicate
    const res2 = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'sig_fake')
      .set('content-type', 'application/json')
      .send(JSON.stringify(event));
    expect(res2.status).toBe(200);

    const { query } = require('../../db/index');
    const records = await query(
      `SELECT id FROM stripe_webhook_events WHERE id = $1`,
      ['evt_del_001']
    );
    expect(records.length).toBe(1);
  });
});
