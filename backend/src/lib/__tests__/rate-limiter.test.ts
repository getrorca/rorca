import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from '../../routes/__tests__/helpers/auth-helper';

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-ratelimit-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_ENABLED = 'true';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  // Reset in-memory windows between tests
  const { resetRateLimitWindows, invalidateRateLimitCache } = require('../rate-limiter');
  resetRateLimitWindows();
  invalidateRateLimitCache();

  authToken = await getAuthToken(app);
});

afterEach(() => {
  const { stopCleanupTimer } = require('../rate-limiter');
  stopCleanupTimer();
  db.close();
  delete process.env.RATE_LIMIT_ENABLED;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

describe('rate_limits table', () => {
  test('migration creates rate_limits table with seeded defaults', () => {
    const rows = db.prepare('SELECT * FROM rate_limits ORDER BY id').all() as any[];
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
    const res = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('100');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
  });

  test('returns 429 after exceeding limit for authenticated users', async () => {
    // Set a very low limit for testing
    db.prepare('UPDATE rate_limits SET max_requests = 3 WHERE endpoint_pattern = ? AND tier = ?')
      .run('*', 'authenticated');
    const { invalidateRateLimitCache } = require('../rate-limiter');
    invalidateRateLimitCache();

    // Make 3 requests (should succeed)
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    }

    // 4th request should be rate limited
    const res = await request(app)
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
    db.prepare('UPDATE rate_limits SET max_requests = 2 WHERE endpoint_pattern = ? AND tier = ?')
      .run('*', 'authenticated');
    const { invalidateRateLimitCache } = require('../rate-limiter');
    invalidateRateLimitCache();

    // Register a second user
    const res2 = await request(app).post('/api/auth/register').send({
      email: 'user2@example.com',
      password: 'securepass123',
      displayName: 'User Two',
    });
    const token2 = res2.body.accessToken;

    // Exhaust user 1's limit
    for (let i = 0; i < 2; i++) {
      await request(app)
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${authToken}`);
    }

    // User 1 should be blocked
    const blockedRes = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);
    expect(blockedRes.status).toBe(429);

    // User 2 should still work
    const okRes = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${token2}`);
    expect(okRes.status).toBe(200);
  });

  test('unauthenticated routes are rate limited by IP', async () => {
    // Set low limit for unauthenticated
    db.prepare('UPDATE rate_limits SET max_requests = 2 WHERE endpoint_pattern = ? AND tier = ?')
      .run('*', 'unauthenticated');
    const { invalidateRateLimitCache } = require('../rate-limiter');
    invalidateRateLimitCache();

    // Auth endpoints are public — make requests without token
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/auth/login').send({
        email: 'nobody@example.com',
        password: 'wrong',
      });
    }

    // 3rd request should be rate limited
    const res = await request(app).post('/api/auth/login').send({
      email: 'nobody@example.com',
      password: 'wrong',
    });
    expect(res.status).toBe(429);
  });

  test('per-endpoint config overrides wildcard', async () => {
    // Wildcard allows 100, but we'll add a specific endpoint with limit 2
    db.prepare('INSERT OR REPLACE INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES (?, ?, ?, ?)')
      .run('GET /api/workspaces', 'authenticated', 2, 60);
    const { invalidateRateLimitCache } = require('../rate-limiter');
    invalidateRateLimitCache();

    for (let i = 0; i < 2; i++) {
      const res = await request(app)
        .get('/api/workspaces')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
    }

    // 3rd request should hit specific endpoint limit (2), not wildcard (100)
    const res = await request(app)
      .get('/api/workspaces')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('2');
  });

  test('rate_limits table supports per-tier customization', () => {
    // Insert a custom tier
    db.prepare('INSERT INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES (?, ?, ?, ?)')
      .run('*', 'premium', 500, 60);

    const row = db.prepare('SELECT * FROM rate_limits WHERE tier = ?').get('premium') as any;
    expect(row).toBeDefined();
    expect(row.max_requests).toBe(500);
    expect(row.window_seconds).toBe(60);
  });

  test('health endpoint is not rate limited', async () => {
    // Health is mounted before rate limiter
    for (let i = 0; i < 25; i++) {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
    }
  });
});
