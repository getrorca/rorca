/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { JWT_SECRET } from '../lib/auth-utils';
import { getMcpToolDefinitions } from '../lib/mcp-http';
import { swaggerSpec } from '../lib/swagger';
import { ensureTestUser, getAuthToken } from '../routes/__tests__/helpers/auth-helper';

jest.mock('../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

describe('Anti-tamper: server-side gate must hold even if the client lies', () => {
  let app: Express;
  let tmpHome: string;
  let freeUser: { id: string; authId: string; email: string };
  let freeToken: string;

  beforeEach(async () => {
    jest.resetModules();
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-anti-tamper-'));
    process.env.HOME = tmpHome;
    process.env.NODE_ENV = 'test';
    process.env.AUTH_REQUIRED = 'true';

    const serverMod = require('../server');
    app = serverMod.default;

    await ensureTestUser({
      email: 'seed-admin@example.com',
      authId: crypto.randomUUID(),
      role: 'admin',
      plan: 'pro',
    });

    freeUser = await ensureTestUser({
      email: 'free-user@example.com',
      authId: crypto.randomUUID(),
      plan: 'free',
      role: 'user',
    });
    freeToken = await getAuthToken(app, { email: freeUser.email, authId: freeUser.authId });
  });

  afterEach(async () => {
    try { const { closePool } = require('../db/index'); await closePool(); } catch {}
    fs.rmSync(tmpHome, { recursive: true, force: true });
    delete process.env.AUTH_REQUIRED;
    delete process.env.NODE_ENV;
  });

  it('rejects a paid route even when X-Plan claims enterprise', async () => {
    const res = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${freeToken}`)
      .set('X-Plan', 'enterprise');

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PLAN_REQUIRED');
    expect(res.body.currentPlan).toBe('free');
  });

  it('rejects a paid route even when a valid JWT claims plan=enterprise', async () => {
    const misleadingJwt = jwt.sign(
      { sub: freeUser.authId, email: freeUser.email, plan: 'enterprise' },
      JWT_SECRET,
      { expiresIn: '15m' },
    );

    const res = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${misleadingJwt}`);

    expect(res.status).toBe(402);
    expect(res.body.code).toBe('PLAN_REQUIRED');
    expect(res.body.currentPlan).toBe('free');
  });

  it('rejects a spoofed JWT with plan=enterprise when the signature is invalid', async () => {
    const forgedJwt = jwt.sign(
      { sub: freeUser.authId, email: freeUser.email, plan: 'enterprise' },
      'attacker-secret',
      { expiresIn: '15m' },
    );

    const res = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${forgedJwt}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid token/i);
  });

  it('rejects a real JWT whose payload is tampered after signing', async () => {
    const realJwt = jwt.sign(
      { sub: freeUser.authId, email: freeUser.email, plan: 'free' },
      JWT_SECRET,
      { expiresIn: '15m' },
    );
    const [headerB64, payloadB64, signatureB64] = realJwt.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({
      ...JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')),
      plan: 'enterprise',
    })).toString('base64url');
    const tamperedJwt = `${headerB64}.${tamperedPayload}.${signatureB64}`;

    const res = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${tamperedJwt}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid token/i);
  });

  it('keeps paid routes out of MCP tools and rejects raw admin MCP tokens on HTTP routes', async () => {
    const { ensureMcpToken } = require('../lib/mcp-auth.ts') as typeof import('../lib/mcp-auth');
    const tokens = ensureMcpToken();
    const toolNames = getMcpToolDefinitions(swaggerSpec as any).map((tool) => tool.toolName);
    expect(toolNames).not.toContain('rorca_get_teams');
    expect(toolNames).not.toContain('rorca_post_teams');

    const rawHttpRes = await request(app)
      .get('/api/teams')
      .set('Authorization', `Bearer ${tokens.adminToken}`);

    expect(rawHttpRes.status).toBe(401);
  });
});
