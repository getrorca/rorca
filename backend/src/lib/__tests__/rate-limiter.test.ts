/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from '../../routes/__tests__/helpers/auth-helper';

// Server initialization + migrations can take > 30s on first run
jest.setTimeout(90_000);

let app: Express;
let server: Server;
let query: typeof import('../../db/index').query;
let execute: typeof import('../../db/index').execute;
let authToken: string;
const secondaryEmail = `rate-limit-user-${process.pid}@example.com`;

function api() {
  return request(server);
}

async function restoreOwnedRateLimitFixtures(): Promise<void> {
  await execute(
    `DELETE FROM rate_limits
     WHERE endpoint_pattern = 'GET /api/workspaces' OR tier = 'premium'`,
  );
  await execute(
    `INSERT INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES
      ('*', 'authenticated', 100, 60),
      ('*', 'unauthenticated', 20, 60),
      ('POST /api/specs/generate', 'authenticated', 10, 60),
      ('POST /api/specs/generate', 'unauthenticated', 3, 60),
      ('POST /api/pipeline/trigger', 'authenticated', 10, 60),
      ('POST /api/pipeline/trigger', 'unauthenticated', 3, 60)
     ON CONFLICT (endpoint_pattern, tier) DO UPDATE
     SET max_requests = EXCLUDED.max_requests,
         window_seconds = EXCLUDED.window_seconds`,
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_ENABLED = 'true';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  query = dbMod.query;
  execute = dbMod.execute;
  authToken = await getAuthToken(app);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(async () => {
  await restoreOwnedRateLimitFixtures();
  const { resetRateLimitWindows, invalidateRateLimitCache } = require('../rate-limiter');
  resetRateLimitWindows();
  await invalidateRateLimitCache();
});

afterEach(async () => {
  await restoreOwnedRateLimitFixtures();
  const { resetRateLimitWindows, invalidateRateLimitCache, stopCleanupTimer } = require('../rate-limiter');
  resetRateLimitWindows();
  await invalidateRateLimitCache();
  stopCleanupTimer();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await execute('DELETE FROM users WHERE email = $1', [secondaryEmail]);
  delete process.env.RATE_LIMIT_ENABLED;
});

describe('rate_limits table', () => {
  test('migration creates rate_limits table with seeded defaults', async () => {
    const rows = await query<any>('SELECT * FROM rate_limits ORDER BY id');
    expect(rows.length).toBeGreaterThanOrEqual(4);

    // Check wildcard defaults
    const authDefault = rows.find((r: any) => r.endpoint_pattern === '*' && r.tier === 'authenticated');
    expect(authDefault).toBeDefined();
    expect(authDefault.max_requests).toBe(100);
    expect(authDefault.window_seconds).toBe(60);

    const unauthDefault = rows.find((r: any) => r.endpoint_pattern === '*' && r.tier === 'unauthenticated');
    expect(unauthDefault).toBeDefined();
    expect(unauthDefault.max_requests).toBe(20);
    expect(unauthDefault.window_seconds).toBe(60);

    // Check LLM endpoint limit
    const specGen = rows.find((r: any) => r.endpoint_pattern === 'POST /api/specs/generate' && r.tier === 'authenticated');
    expect(specGen).toBeDefined();
    expect(specGen.max_requests).toBe(10);
  });
});

describe('rate limiter middleware', () => {
  test('returns rate limit headers on successful requests', async () => {
    const res = await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  test('returns 429 after exceeding limit for authenticated users', async () => {
    // Set a very low limit for testing
    await execute(
      'UPDATE rate_limits SET max_requests = 3 WHERE endpoint_pattern = $1 AND tier = $2',
      ['*', 'authenticated'],
    );
    const { invalidateRateLimitCache } = require('../rate-limiter');
    await invalidateRateLimitCache();

    // Make 3 requests (should succeed)
    for (let i = 0; i < 3; i++) {
      const res = await api()
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    }

    // 4th request should be rate limited
    const res = await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Too many requests');
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
  });

  test('rate limits apply per-user (different users have independent windows)', async () => {
    // Set low limit
    await execute(
      'UPDATE rate_limits SET max_requests = 2 WHERE endpoint_pattern = $1 AND tier = $2',
      ['*', 'authenticated'],
    );
    const { invalidateRateLimitCache } = require('../rate-limiter');
    await invalidateRateLimitCache();

    // Mint a second authenticated fixture through the canonical test helper;
    // the retired public registration route must not be revived for this test.
    const token2 = await getAuthToken(app, {
      email: secondaryEmail,
      role: 'user',
      displayName: 'Rate Limit User Two',
    });

    // Exhaust user 1's limit
    for (let i = 0; i < 2; i++) {
      await api()
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${authToken}`);
    }

    // User 1 should be blocked
    const blockedRes = await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);
    expect(blockedRes.status).toBe(429);

    // User 2 should still work
    const okRes = await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${token2}`);
    expect(okRes.status).toBe(200);
  });

  test('unauthenticated routes are rate limited by IP', async () => {
    // Set low limit for unauthenticated
    await execute(
      'UPDATE rate_limits SET max_requests = 2 WHERE endpoint_pattern = $1 AND tier = $2',
      ['*', 'unauthenticated'],
    );
    const { invalidateRateLimitCache } = require('../rate-limiter');
    await invalidateRateLimitCache();

    // Auth endpoints are public — make requests without token
    for (let i = 0; i < 2; i++) {
      await api().post('/api/auth/login').send({
        email: 'nobody@example.com',
        password: 'wrong',
      });
    }

    // 3rd request should be rate limited
    const res = await api().post('/api/auth/login').send({
      email: 'nobody@example.com',
      password: 'wrong',
    });
    expect(res.status).toBe(429);
  });

  test('per-endpoint config overrides wildcard', async () => {
    // Wildcard allows 100, but we'll add a specific endpoint with limit 2
    await execute(
      'INSERT INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES ($1, $2, $3, $4) ON CONFLICT (endpoint_pattern, tier) DO UPDATE SET max_requests = EXCLUDED.max_requests, window_seconds = EXCLUDED.window_seconds',
      ['GET /api/workspaces', 'authenticated', 2, 60],
    );
    const { invalidateRateLimitCache } = require('../rate-limiter');
    await invalidateRateLimitCache();

    for (let i = 0; i < 2; i++) {
      const res = await api()
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    }

    // 3rd request should hit specific endpoint limit (2), not wildcard (100)
    const res = await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('2');
  });

  test('rate_limits table supports per-tier customization', async () => {
    // Insert a custom tier
    await execute(
      'INSERT INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES ($1, $2, $3, $4)',
      ['*', 'premium', 500, 60],
    );

    const rows = await query<any>('SELECT * FROM rate_limits WHERE tier = $1', ['premium']);
    expect(rows.length).toBe(1);
    expect(rows[0].max_requests).toBe(500);
    expect(rows[0].window_seconds).toBe(60);
  });

  test('health endpoint is not rate limited', async () => {
    // Health is mounted before rate limiter
    for (let i = 0; i < 25; i++) {
      const res = await api().get('/api/health');
      expect(res.status).toBe(200);
    }
  });

  test('SSE endpoints are exempt from rate limiting', async () => {
    // Set a very low limit to ensure they would be rate limited if not exempt
    await execute(
      'UPDATE rate_limits SET max_requests = 1 WHERE endpoint_pattern = $1 AND tier = $2',
      ['*', 'authenticated'],
    );
    const { invalidateRateLimitCache } = require('../rate-limiter');
    await invalidateRateLimitCache();

    // Normal endpoint should be rate limited after 1 request
    await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);
    const blockedRes = await api()
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);
    expect(blockedRes.status).toBe(429);

    // SSE endpoints should never return 429, even with very low limits
    // Test that first request to each SSE endpoint is not rate limited
    const sseEndpoints = [
      '/api/pipeline/stream',
      '/api/pipeline/runs/test-run-123/output',
      '/api/pipeline/runs/test-run-123/stories/US-001/output',
      '/api/pipeline/runs/test-run-123/stories/US-001/log',
    ];

    const { rateLimiter } = require('../rate-limiter') as typeof import('../rate-limiter');
    for (const endpoint of sseEndpoints) {
      const next = jest.fn();
      rateLimiter(
        { method: 'GET', path: endpoint } as any,
        {} as any,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
    }
  });
});
