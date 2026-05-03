/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * BL-002: Auto-provision 14-day Pro trial on first workspace registration.
 *
 * Tests:
 * 1. First workspace creates billing trial row
 * 2. Second workspace does NOT create duplicate billing row
 * 3. Expired trial causes requirePlan to return 402
 */
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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-billing-trial-'));
  process.env.NODE_ENV = 'test';
  delete process.env.AUTH_REQUIRED;

  const serverMod = require('../../server');
  app = serverMod.default;

  // Ensure a test user exists (trial provisioning requires a user row)
  await getAuthToken(app);

  // Clean billing state using the fresh pool (same instance as server's)
  const { execute } = require('../../db/index');
  await execute('DELETE FROM subscriptions');
  await execute("UPDATE users SET plan = 'free'");
});

afterEach(async () => {
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('BL-002: Trial auto-provisioning', () => {
  test('first workspace registration creates billing trial row', async () => {
    const wsPath = path.join(tmpDir, 'test-ws');
    fs.mkdirSync(wsPath, { recursive: true });

    const res = await request(app)
      .post('/api/workspaces')
      .send({ id: 'bl002-ws1', label: 'Test WS', path: wsPath, domains: ['saas'] });

    expect(res.status).toBe(201);

    const { query, queryOne } = require('../../db/index');
    const rows = await query('SELECT * FROM subscriptions');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('trialing');
    expect(rows[0].plan).toBe('pro');
    expect(rows[0].trial_started_at).toBeTruthy();
    expect(rows[0].trial_ends_at).toBeTruthy();

    // User plan should be updated to 'pro'
    const user = await queryOne('SELECT plan FROM users WHERE id = $1', [rows[0].user_id]);
    expect(user!.plan).toBe('pro');
  });

  test('second workspace does NOT create duplicate billing row', async () => {
    const wsPath1 = path.join(tmpDir, 'ws1');
    fs.mkdirSync(wsPath1, { recursive: true });
    await request(app)
      .post('/api/workspaces')
      .send({ id: 'bl002-ws2a', label: 'WS 2a', path: wsPath1, domains: ['saas'] });

    const wsPath2 = path.join(tmpDir, 'ws2');
    fs.mkdirSync(wsPath2, { recursive: true });
    await request(app)
      .post('/api/workspaces')
      .send({ id: 'bl002-ws2b', label: 'WS 2b', path: wsPath2, domains: ['saas'] });

    const { query } = require('../../db/index');
    const rows = await query('SELECT * FROM subscriptions');
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('trialing');
  });

  test('expired trial causes requirePlan to return 402', async () => {
    // Create workspace (provisions trial)
    const wsPath = path.join(tmpDir, 'ws-expire');
    fs.mkdirSync(wsPath, { recursive: true });
    await request(app)
      .post('/api/workspaces')
      .send({ id: 'bl002-expire', label: 'Expire WS', path: wsPath, domains: ['saas'] });

    // Expire the trial and reset user plan
    const { execute } = require('../../db/index');
    await execute(`UPDATE subscriptions SET trial_ends_at = NOW() - INTERVAL '1 day'`);
    await execute(`UPDATE users SET plan = 'free'`);

    // This request should be blocked by requirePlan with 402
    const wsPath2 = path.join(tmpDir, 'ws-blocked');
    fs.mkdirSync(wsPath2, { recursive: true });
    const res = await request(app)
      .post('/api/workspaces')
      .send({ id: 'bl002-blocked', label: 'Blocked WS', path: wsPath2, domains: ['saas'] });

    expect(res.status).toBe(402);
    expect(res.body.trialExpired).toBe(true);
  });
});
