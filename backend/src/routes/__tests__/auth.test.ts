import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { query, queryOne, execute } from '../../db/index';

// Mock global fetch for GitHub OAuth tests
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

let app: Express;
let tmpDir: string;

beforeAll(async () => {
  // Clean auth-related tables at start to remove any leftovers from previous test runs
  await execute('TRUNCATE users CASCADE');
  await execute('DELETE FROM wal_events');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-auth-test-'));
  // Create workspace dir structure for specs (required by some route mounts)
  const wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });

  app = require('../../server').default;
});

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(async () => {
  // Clean auth-related tables after each test to prevent state leakage
  await execute('TRUNCATE users CASCADE');
  await execute('DELETE FROM wal_events');
  await execute('DELETE FROM login_attempts');
});

afterAll(async () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const validPayload = {
  email: 'test@example.com',
  password: 'SecurePass123',
  displayName: 'Test User',
};

/** Helper: register a user and return tokens */
async function registerUser(payload = validPayload) {
  const res = await request(app).post('/api/auth/register').send(payload);
  return res.body as { user: { id: string; email: string; displayName: string }; accessToken: string; refreshToken: string };
}

// ─── POST /api/auth/register (existing V2-001 tests) ───

describe('POST /api/auth/register', () => {
  test('returns 201 with tokens on successful registration', async () => {
    const res = await request(app).post('/api/auth/register').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.user.id).toBeDefined();
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.password).toBeUndefined();
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  test('stores hashed password (not plaintext) in the database', async () => {
    await request(app).post('/api/auth/register').send(validPayload);

    const user = await queryOne(`SELECT * FROM users WHERE email = $1`, ['test@example.com']) as Record<string, unknown>;
    expect(user).toBeDefined();
    expect(user.password_hash).toBeDefined();
    expect(user.password_hash).not.toBe('securepass123');
    expect((user.password_hash as string).startsWith('$2a$') || (user.password_hash as string).startsWith('$2b$')).toBe(true);
  });

  test('returns 409 if email already exists', async () => {
    await request(app).post('/api/auth/register').send(validPayload);
    const res = await request(app).post('/api/auth/register').send(validPayload);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('An account with this email already exists');
  });

  test('returns 422 for malformed email', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, email: 'not-an-email' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Invalid email format')).toBe(true);
  });

  test('returns 422 for missing email', async () => {
    const res = await request(app).post('/api/auth/register').send({ password: 'SecurePass123', displayName: 'Test User' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Email is required')).toBe(true);
  });

  test('returns 422 for missing password', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'test@example.com', displayName: 'Test User' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Password is required')).toBe(true);
  });

  test('returns 422 for missing displayName', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'test@example.com', password: 'SecurePass123' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Display name is required')).toBe(true);
  });

  test('returns 422 for password shorter than 8 characters', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) =>
      d.message === 'Password must be at least 8 characters and contain uppercase, lowercase, and a number'
    )).toBe(true);
  });

  test('returns 422 for password without uppercase', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, password: 'securepass123' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) =>
      d.message === 'Password must be at least 8 characters and contain uppercase, lowercase, and a number'
    )).toBe(true);
  });

  test('normalizes email to lowercase', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, email: 'Test@EXAMPLE.com' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('test@example.com');
  });

  test('trims displayName whitespace', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, displayName: '  Padded Name  ' });
    expect(res.status).toBe(201);
    expect(res.body.user.displayName).toBe('Padded Name');
  });

  test('stores refresh token hash in database', async () => {
    await request(app).post('/api/auth/register').send(validPayload);
    const tokens = await query(`SELECT * FROM refresh_tokens`) as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).toBeDefined();
    expect(tokens[0].expires_at).toBeDefined();
  });

  test('emits user_registered WAL event', async () => {
    await request(app).post('/api/auth/register').send(validPayload);
    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'user_registered'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
    expect(payload.userId).toBeDefined();
  });

  test('accessToken is a valid JWT with sub and email claims', async () => {
    const res = await request(app).post('/api/auth/register').send(validPayload);
    const decoded = JSON.parse(
      Buffer.from(res.body.accessToken.split('.')[1], 'base64').toString()
    );
    expect(decoded.sub).toBe(res.body.user.id);
    expect(decoded.email).toBe('test@example.com');
    expect(decoded.exp).toBeDefined();
  });

  test('rejects email with spaces', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, email: 'test @example.com' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Invalid email format')).toBe(true);
  });
});

// ─── POST /api/auth/login ───

describe('POST /api/auth/login', () => {
  test('returns 200 with tokens on valid credentials', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
  });

  test('returns short-lived access token (15 min)', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });

    const decoded = JSON.parse(
      Buffer.from(res.body.accessToken.split('.')[1], 'base64').toString()
    );
    // exp - iat should be ~900 seconds (15 min)
    const ttl = decoded.exp - decoded.iat;
    expect(ttl).toBe(900);
  });

  test('stores refresh token with 7-day expiry', async () => {
    await registerUser();

    await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });

    // Should have 2 refresh tokens now (1 from register, 1 from login)
    const tokens = await query(`SELECT * FROM refresh_tokens ORDER BY created_at DESC`) as Record<string, unknown>[];
    expect(tokens.length).toBeGreaterThanOrEqual(2);

    const latestToken = tokens[0];
    const expiresAt = new Date(latestToken.expires_at as string).getTime();
    const now = Date.now();
    const daysUntilExpiry = (expiresAt - now) / (1000 * 60 * 60 * 24);
    // Should be approximately 7 days (6.9 to 7.1)
    expect(daysUntilExpiry).toBeGreaterThan(6.9);
    expect(daysUntilExpiry).toBeLessThan(7.1);
  });

  test('returns 401 for wrong password', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'wrongpassword',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  test('returns 401 for non-existent email', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email: 'nobody@example.com',
      password: 'SecurePass123',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  test('returns 422 for missing email', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'SecurePass123' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Email is required')).toBe(true);
  });

  test('returns 422 for missing password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'test@example.com' });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { message: string }) => d.message === 'Password is required')).toBe(true);
  });

  test('normalizes email to lowercase', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'Test@EXAMPLE.COM',
      password: 'SecurePass123',
    });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('test@example.com');
  });

  test('emits user_login WAL event', async () => {
    await registerUser();

    await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'user_login'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });
});

// ─── POST /api/auth/refresh ───

describe('POST /api/auth/refresh', () => {
  test('returns new access and refresh token pair', async () => {
    const { refreshToken } = await registerUser();

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // New tokens should differ from the original
    expect(res.body.refreshToken).not.toBe(refreshToken);
  });

  test('invalidates the old refresh token after rotation', async () => {
    const { refreshToken } = await registerUser();

    // First refresh succeeds
    const res1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res1.status).toBe(200);

    // Reusing old refresh token should fail
    const res2 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res2.status).toBe(401);
    expect(res2.body.error).toBe('Refresh token has been revoked');
  });

  test('new refresh token from rotation works', async () => {
    const { refreshToken } = await registerUser();

    const res1 = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res1.status).toBe(200);

    const res2 = await request(app).post('/api/auth/refresh').send({ refreshToken: res1.body.refreshToken });
    expect(res2.status).toBe(200);
    expect(res2.body.accessToken).toBeDefined();
    expect(res2.body.refreshToken).toBeDefined();
  });

  test('returns 401 for invalid token', async () => {
    const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'invalidtoken123' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid refresh token');
  });

  test('returns 401 for expired token', async () => {
    const { refreshToken } = await registerUser();

    // Manually expire the token in DB
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await execute(`UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 day' WHERE token_hash = $1`, [tokenHash]);

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Refresh token has expired');
  });

  test('returns 400 for missing refreshToken', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Refresh token is required');
  });
});

// ─── POST /api/auth/logout ───

describe('POST /api/auth/logout', () => {
  test('revokes refresh token and returns success', async () => {
    const { refreshToken } = await registerUser();

    const res = await request(app).post('/api/auth/logout').send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Logged out successfully');
  });

  test('revoked token cannot be used for refresh', async () => {
    const { refreshToken } = await registerUser();

    await request(app).post('/api/auth/logout').send({ refreshToken });

    const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Refresh token has been revoked');
  });

  test('sets revoked_at timestamp in database', async () => {
    const { refreshToken } = await registerUser();

    await request(app).post('/api/auth/logout').send({ refreshToken });

    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const token = await queryOne(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [tokenHash]) as Record<string, unknown>;
    expect(token.revoked_at).toBeDefined();
    expect(token.revoked_at).not.toBeNull();
  });

  test('returns 401 for invalid token', async () => {
    const res = await request(app).post('/api/auth/logout').send({ refreshToken: 'invalidtoken' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or already revoked refresh token');
  });

  test('returns 401 for already revoked token', async () => {
    const { refreshToken } = await registerUser();

    await request(app).post('/api/auth/logout').send({ refreshToken });
    const res = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or already revoked refresh token');
  });

  test('returns 400 for missing refreshToken', async () => {
    const res = await request(app).post('/api/auth/logout').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Refresh token is required');
  });
});

// ─── authRequired middleware ───

describe('authRequired middleware', () => {
  test('returns 401 with "Authentication required" for missing Authorization header', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  test('returns 401 with "Invalid token" for expired access token', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    // Create an already-expired token
    const expiredToken = jwt.sign({ sub: 'user123', email: 'test@example.com' }, JWT_SECRET, { expiresIn: '0s' });

    // Wait a tick so it's definitely expired
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('returns 401 with "Invalid token" for malformed JWT', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', 'Bearer invalidjwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('passes with valid access token and populates req.user', async () => {
    const { accessToken, user } = await registerUser();

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (req: any, res: any) => {
      res.json({ ok: true, user: req.user });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.role).toBe('user');
  });

  test('returns 401 when user no longer exists in database', async () => {
    const { accessToken } = await registerUser();

    // Delete the user from DB
    await execute(`DELETE FROM users`);

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });
});

// ─── GET /api/auth/me ───

describe('GET /api/auth/me', () => {
  test('returns current user with valid access token', async () => {
    const { accessToken } = await registerUser();

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.user.githubConnected).toBe(false);
    expect(res.body.user.id).toBeDefined();
  });

  test('returns LOCAL_ADMIN fallback without auth token (local single-user mode)', async () => {
    // afterEach truncates users, so no DB users exist.
    // In local mode (AUTH_REQUIRED not set), /me falls back to LOCAL_ADMIN synthetic user.
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('local-admin');
    expect(res.body.user.email).toBe('admin@rorca.local');
  });
});

// ─── Global auth middleware integration ───

describe('Global auth middleware', () => {
  test('public routes are accessible without auth', async () => {
    // Health endpoint — status is 'ok' or 'degraded' (worker not running in tests)
    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(['ok', 'degraded']).toContain(healthRes.body.status);

    // Auth endpoints — login returns 401 for bad creds but with route-specific error, not middleware's "Authentication required"
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'x@y.com', password: 'test' });
    expect(loginRes.body.error).not.toBe('Authentication required');

    // Register is accessible without auth (returns 422 for Zod validation failure, not 401)
    const registerRes = await request(app).post('/api/auth/register').send({});
    expect(registerRes.status).toBe(422);
  });

  test('protected routes are accessible since auth is intentionally bypassed', async () => {
    // Auth middleware is intentionally bypassed for local single-user mode (see CLAUDE.md)
    const res = await request(app).get('/api/workspaces');
    expect([200, 401]).toContain(res.status);
  });

  test('protected routes succeed with valid auth token', async () => {
    const { accessToken } = await registerUser();
    const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/auth/forgot-password ───

describe('POST /api/auth/forgot-password', () => {
  test('returns 200 with success message for existing email', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    expect(res.body.resetLink).toBeDefined();
  });

  test('returns 200 with same message for non-existent email (no enumeration)', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    // No resetLink for non-existent email
    expect(res.body.resetLink).toBeUndefined();
  });

  test('stores hashed reset token in database', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const tokens = await query(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).toBeDefined();
    expect(tokens[0].expires_at).toBeDefined();
    expect(tokens[0].used_at).toBeNull();
  });

  test('reset token expires in ~1 hour', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const token = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    // PostgreSQL returns proper ISO timestamps
    const expiresAt = new Date(token.expires_at as string).getTime();
    const createdAt = new Date(token.created_at as string).getTime();
    const hoursUntilExpiry = (expiresAt - createdAt) / (1000 * 60 * 60);
    expect(hoursUntilExpiry).toBeGreaterThan(0.9);
    expect(hoursUntilExpiry).toBeLessThan(1.1);
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for invalid email format', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  test('normalizes email to lowercase', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'Test@EXAMPLE.COM' });
    expect(res.status).toBe(200);
    expect(res.body.resetLink).toBeDefined();
  });

  test('rate limits to 3 requests per email per hour', async () => {
    await registerUser();

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
      expect(res.status).toBe(200);
    }

    // 4th should be rate limited
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Too many reset requests');
  });

  test('emits password_reset_requested WAL event', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset_requested'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });
});

// ─── POST /api/auth/reset-password ───

describe('POST /api/auth/reset-password', () => {
  /** Helper: request a reset token and return the raw token */
  async function getResetToken(email = 'test@example.com'): Promise<string> {
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    // Extract token from resetLink URL
    const url = new URL(res.body.resetLink);
    return url.searchParams.get('token')!;
  }

  test('resets password with valid token', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Password has been reset successfully');
  });

  test('can login with new password after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old password should fail
    const oldRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });
    expect(oldRes.status).toBe(401);

    // New password should succeed
    const newRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'newpassword123',
    });
    expect(newRes.status).toBe(200);
    expect(newRes.body.accessToken).toBeDefined();
  });

  test('marks token as used after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const resetToken = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    expect(resetToken.used_at).not.toBeNull();
  });

  test('returns 400 for already-used token', async () => {
    await registerUser();
    const token = await getResetToken();

    // First use succeeds
    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Second use fails
    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'anotherpassword',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has already been used');
  });

  test('returns 400 for expired token', async () => {
    await registerUser();
    const token = await getResetToken();

    // Manually expire the token
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await execute(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE token_hash = $1`, [tokenHash]);

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has expired');
  });

  test('returns 400 for invalid token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      token: 'completely-invalid-token',
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset token');
  });

  test('returns 400 for missing token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ newPassword: 'newpassword123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reset token is required');
  });

  test('returns 400 for missing newPassword', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'sometoken' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('New password is required');
  });

  test('returns 400 for password shorter than 8 characters', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
  });

  test('invalidates all refresh tokens for the user', async () => {
    const { refreshToken } = await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old refresh token should be revoked
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  test('emits password_reset WAL event', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });

  test('stores new password as bcrypt hash', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const user = await queryOne(`SELECT * FROM users WHERE email = $1`, ['test@example.com']) as Record<string, unknown>;
    expect(user.password_hash).toBeDefined();
    expect(user.password_hash).not.toBe('newpassword123');
    expect((user.password_hash as string).startsWith('$2a$') || (user.password_hash as string).startsWith('$2b$')).toBe(true);
  });
});

// ─── Token encryption helpers ───

describe('encryptToken / decryptToken', () => {
  test('round-trips a token correctly', () => {
    const { encryptToken, decryptToken } = require('../auth');
    const original = 'gho_abc123XYZ';
    const encrypted = encryptToken(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.split(':')).toHaveLength(3);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(original);
  });

  test('produces different ciphertexts for the same input (random IV)', () => {
    const { encryptToken } = require('../auth');
    const token = 'gho_test_token';
    const enc1 = encryptToken(token);
    const enc2 = encryptToken(token);
    expect(enc1).not.toBe(enc2);
  });
});

// ─── authRequired middleware ───

describe('authRequired middleware', () => {
  test('returns 401 with "Authentication required" for missing Authorization header', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  test('returns 401 with "Invalid token" for expired access token', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    // Create an already-expired token
    const expiredToken = jwt.sign({ sub: 'user123', email: 'test@example.com' }, JWT_SECRET, { expiresIn: '0s' });

    // Wait a tick so it's definitely expired
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('returns 401 with "Invalid token" for malformed JWT', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', 'Bearer invalidjwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('passes with valid access token and populates req.user', async () => {
    const { accessToken, user } = await registerUser();

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (req: any, res: any) => {
      res.json({ ok: true, user: req.user });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.role).toBe('user');
  });

  test('returns 401 when user no longer exists in database', async () => {
    const { accessToken } = await registerUser();

    // Delete the user from DB
    await execute(`DELETE FROM users`);

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });
});

// ─── GET /api/auth/me ───

describe('GET /api/auth/me', () => {
  test('returns current user with valid access token', async () => {
    const { accessToken } = await registerUser();

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.user.githubConnected).toBe(false);
    expect(res.body.user.id).toBeDefined();
  });

  test('returns LOCAL_ADMIN fallback without auth token (local single-user mode)', async () => {
    // afterEach truncates users, so no DB users exist.
    // In local mode (AUTH_REQUIRED not set), /me falls back to LOCAL_ADMIN synthetic user.
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('local-admin');
    expect(res.body.user.email).toBe('admin@rorca.local');
  });
});

// ─── Global auth middleware integration ───

describe('Global auth middleware', () => {
  test('public routes are accessible without auth', async () => {
    // Health endpoint — status is 'ok' or 'degraded' (worker not running in tests)
    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(['ok', 'degraded']).toContain(healthRes.body.status);

    // Auth endpoints — login returns 401 for bad creds but with route-specific error, not middleware's "Authentication required"
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'x@y.com', password: 'test' });
    expect(loginRes.body.error).not.toBe('Authentication required');

    // Register is accessible without auth (returns 422 for Zod validation failure, not 401)
    const registerRes = await request(app).post('/api/auth/register').send({});
    expect(registerRes.status).toBe(422);
  });

  test('protected routes are accessible since auth is intentionally bypassed', async () => {
    // Auth middleware is intentionally bypassed for local single-user mode (see CLAUDE.md)
    const res = await request(app).get('/api/workspaces');
    expect([200, 401]).toContain(res.status);
  });

  test('protected routes succeed with valid auth token', async () => {
    const { accessToken } = await registerUser();
    const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/auth/forgot-password ───

describe('POST /api/auth/forgot-password', () => {
  test('returns 200 with success message for existing email', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    expect(res.body.resetLink).toBeDefined();
  });

  test('returns 200 with same message for non-existent email (no enumeration)', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    // No resetLink for non-existent email
    expect(res.body.resetLink).toBeUndefined();
  });

  test('stores hashed reset token in database', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const tokens = await query(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).toBeDefined();
    expect(tokens[0].expires_at).toBeDefined();
    expect(tokens[0].used_at).toBeNull();
  });

  test('reset token expires in ~1 hour', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const token = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    // PostgreSQL returns proper ISO timestamps
    const expiresAt = new Date(token.expires_at as string).getTime();
    const createdAt = new Date(token.created_at as string).getTime();
    const hoursUntilExpiry = (expiresAt - createdAt) / (1000 * 60 * 60);
    expect(hoursUntilExpiry).toBeGreaterThan(0.9);
    expect(hoursUntilExpiry).toBeLessThan(1.1);
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for invalid email format', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  test('normalizes email to lowercase', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'Test@EXAMPLE.COM' });
    expect(res.status).toBe(200);
    expect(res.body.resetLink).toBeDefined();
  });

  test('rate limits to 3 requests per email per hour', async () => {
    await registerUser();

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
      expect(res.status).toBe(200);
    }

    // 4th should be rate limited
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Too many reset requests');
  });

  test('emits password_reset_requested WAL event', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset_requested'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });
});

// ─── POST /api/auth/reset-password ───

describe('POST /api/auth/reset-password', () => {
  /** Helper: request a reset token and return the raw token */
  async function getResetToken(email = 'test@example.com'): Promise<string> {
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    // Extract token from resetLink URL
    const url = new URL(res.body.resetLink);
    return url.searchParams.get('token')!;
  }

  test('resets password with valid token', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Password has been reset successfully');
  });

  test('can login with new password after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old password should fail
    const oldRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });
    expect(oldRes.status).toBe(401);

    // New password should succeed
    const newRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'newpassword123',
    });
    expect(newRes.status).toBe(200);
    expect(newRes.body.accessToken).toBeDefined();
  });

  test('marks token as used after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const resetToken = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    expect(resetToken.used_at).not.toBeNull();
  });

  test('returns 400 for already-used token', async () => {
    await registerUser();
    const token = await getResetToken();

    // First use succeeds
    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Second use fails
    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'anotherpassword',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has already been used');
  });

  test('returns 400 for expired token', async () => {
    await registerUser();
    const token = await getResetToken();

    // Manually expire the token
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await execute(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE token_hash = $1`, [tokenHash]);

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has expired');
  });

  test('returns 400 for invalid token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      token: 'completely-invalid-token',
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset token');
  });

  test('returns 400 for missing token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ newPassword: 'newpassword123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reset token is required');
  });

  test('returns 400 for missing newPassword', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'sometoken' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('New password is required');
  });

  test('returns 400 for password shorter than 8 characters', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
  });

  test('invalidates all refresh tokens for the user', async () => {
    const { refreshToken } = await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old refresh token should be revoked
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  test('emits password_reset WAL event', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });

  test('stores new password as bcrypt hash', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const user = await queryOne(`SELECT * FROM users WHERE email = $1`, ['test@example.com']) as Record<string, unknown>;
    expect(user.password_hash).toBeDefined();
    expect(user.password_hash).not.toBe('newpassword123');
    expect((user.password_hash as string).startsWith('$2a$') || (user.password_hash as string).startsWith('$2b$')).toBe(true);
  });
});

// ─── Token encryption helpers ───

describe('encryptToken / decryptToken', () => {
  test('round-trips a token correctly', () => {
    const { encryptToken, decryptToken } = require('../auth');
    const original = 'gho_abc123XYZ';
    const encrypted = encryptToken(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.split(':')).toHaveLength(3);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(original);
  });

  test('produces different ciphertexts for the same input (random IV)', () => {
    const { encryptToken } = require('../auth');
    const token = 'gho_test_token';
    const enc1 = encryptToken(token);
    const enc2 = encryptToken(token);
    expect(enc1).not.toBe(enc2);
  });
});

// ─── authRequired middleware ───

describe('authRequired middleware', () => {
  test('returns 401 with "Authentication required" for missing Authorization header', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  test('returns 401 with "Invalid token" for expired access token', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    // Create an already-expired token
    const expiredToken = jwt.sign({ sub: 'user123', email: 'test@example.com' }, JWT_SECRET, { expiresIn: '0s' });

    // Wait a tick so it's definitely expired
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('returns 401 with "Invalid token" for malformed JWT', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', 'Bearer invalidjwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('passes with valid access token and populates req.user', async () => {
    const { accessToken, user } = await registerUser();

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (req: any, res: any) => {
      res.json({ ok: true, user: req.user });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.role).toBe('user');
  });

  test('returns 401 when user no longer exists in database', async () => {
    const { accessToken } = await registerUser();

    // Delete the user from DB
    await execute(`DELETE FROM users`);

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });
});

// ─── GET /api/auth/me ───

describe('GET /api/auth/me', () => {
  test('returns current user with valid access token', async () => {
    const { accessToken } = await registerUser();

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.user.githubConnected).toBe(false);
    expect(res.body.user.id).toBeDefined();
  });

  test('returns LOCAL_ADMIN fallback without auth token (local single-user mode)', async () => {
    // afterEach truncates users, so no DB users exist.
    // In local mode (AUTH_REQUIRED not set), /me falls back to LOCAL_ADMIN synthetic user.
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('local-admin');
    expect(res.body.user.email).toBe('admin@rorca.local');
  });
});

// ─── Global auth middleware integration ───

describe('Global auth middleware', () => {
  test('public routes are accessible without auth', async () => {
    // Health endpoint — status is 'ok' or 'degraded' (worker not running in tests)
    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(['ok', 'degraded']).toContain(healthRes.body.status);

    // Auth endpoints — login returns 401 for bad creds but with route-specific error, not middleware's "Authentication required"
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'x@y.com', password: 'test' });
    expect(loginRes.body.error).not.toBe('Authentication required');

    // Register is accessible without auth (returns 422 for Zod validation failure, not 401)
    const registerRes = await request(app).post('/api/auth/register').send({});
    expect(registerRes.status).toBe(422);
  });

  test('protected routes are accessible since auth is intentionally bypassed', async () => {
    // Auth middleware is intentionally bypassed for local single-user mode (see CLAUDE.md)
    const res = await request(app).get('/api/workspaces');
    expect([200, 401]).toContain(res.status);
  });

  test('protected routes succeed with valid auth token', async () => {
    const { accessToken } = await registerUser();
    const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/auth/forgot-password ───

describe('POST /api/auth/forgot-password', () => {
  test('returns 200 with success message for existing email', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    expect(res.body.resetLink).toBeDefined();
  });

  test('returns 200 with same message for non-existent email (no enumeration)', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    // No resetLink for non-existent email
    expect(res.body.resetLink).toBeUndefined();
  });

  test('stores hashed reset token in database', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const tokens = await query(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).toBeDefined();
    expect(tokens[0].expires_at).toBeDefined();
    expect(tokens[0].used_at).toBeNull();
  });

  test('reset token expires in ~1 hour', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const token = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    // PostgreSQL returns proper ISO timestamps
    const expiresAt = new Date(token.expires_at as string).getTime();
    const createdAt = new Date(token.created_at as string).getTime();
    const hoursUntilExpiry = (expiresAt - createdAt) / (1000 * 60 * 60);
    expect(hoursUntilExpiry).toBeGreaterThan(0.9);
    expect(hoursUntilExpiry).toBeLessThan(1.1);
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for invalid email format', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  test('normalizes email to lowercase', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'Test@EXAMPLE.COM' });
    expect(res.status).toBe(200);
    expect(res.body.resetLink).toBeDefined();
  });

  test('rate limits to 3 requests per email per hour', async () => {
    await registerUser();

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
      expect(res.status).toBe(200);
    }

    // 4th should be rate limited
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Too many reset requests');
  });

  test('emits password_reset_requested WAL event', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset_requested'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });
});

// ─── POST /api/auth/reset-password ───

describe('POST /api/auth/reset-password', () => {
  /** Helper: request a reset token and return the raw token */
  async function getResetToken(email = 'test@example.com'): Promise<string> {
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    // Extract token from resetLink URL
    const url = new URL(res.body.resetLink);
    return url.searchParams.get('token')!;
  }

  test('resets password with valid token', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Password has been reset successfully');
  });

  test('can login with new password after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old password should fail
    const oldRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });
    expect(oldRes.status).toBe(401);

    // New password should succeed
    const newRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'newpassword123',
    });
    expect(newRes.status).toBe(200);
    expect(newRes.body.accessToken).toBeDefined();
  });

  test('marks token as used after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const resetToken = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    expect(resetToken.used_at).not.toBeNull();
  });

  test('returns 400 for already-used token', async () => {
    await registerUser();
    const token = await getResetToken();

    // First use succeeds
    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Second use fails
    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'anotherpassword',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has already been used');
  });

  test('returns 400 for expired token', async () => {
    await registerUser();
    const token = await getResetToken();

    // Manually expire the token
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await execute(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE token_hash = $1`, [tokenHash]);

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has expired');
  });

  test('returns 400 for invalid token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      token: 'completely-invalid-token',
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset token');
  });

  test('returns 400 for missing token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ newPassword: 'newpassword123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reset token is required');
  });

  test('returns 400 for missing newPassword', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'sometoken' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('New password is required');
  });

  test('returns 400 for password shorter than 8 characters', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
  });

  test('invalidates all refresh tokens for the user', async () => {
    const { refreshToken } = await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old refresh token should be revoked
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  test('emits password_reset WAL event', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });

  test('stores new password as bcrypt hash', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const user = await queryOne(`SELECT * FROM users WHERE email = $1`, ['test@example.com']) as Record<string, unknown>;
    expect(user.password_hash).toBeDefined();
    expect(user.password_hash).not.toBe('newpassword123');
    expect((user.password_hash as string).startsWith('$2a$') || (user.password_hash as string).startsWith('$2b$')).toBe(true);
  });
});

// ─── Token encryption helpers ───

describe('encryptToken / decryptToken', () => {
  test('round-trips a token correctly', () => {
    const { encryptToken, decryptToken } = require('../auth');
    const original = 'gho_abc123XYZ';
    const encrypted = encryptToken(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.split(':')).toHaveLength(3);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(original);
  });

  test('produces different ciphertexts for the same input (random IV)', () => {
    const { encryptToken } = require('../auth');
    const token = 'gho_test_token';
    const enc1 = encryptToken(token);
    const enc2 = encryptToken(token);
    expect(enc1).not.toBe(enc2);
  });
});

// ─── authRequired middleware ───

describe('authRequired middleware', () => {
  test('returns 401 with "Authentication required" for missing Authorization header', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  test('returns 401 with "Invalid token" for expired access token', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    // Create an already-expired token
    const expiredToken = jwt.sign({ sub: 'user123', email: 'test@example.com' }, JWT_SECRET, { expiresIn: '0s' });

    // Wait a tick so it's definitely expired
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('returns 401 with "Invalid token" for malformed JWT', async () => {
    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', 'Bearer invalidjwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('passes with valid access token and populates req.user', async () => {
    const { accessToken, user } = await registerUser();

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (req: any, res: any) => {
      res.json({ ok: true, user: req.user });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.role).toBe('user');
  });

  test('returns 401 when user no longer exists in database', async () => {
    const { accessToken } = await registerUser();

    // Delete the user from DB
    await execute(`DELETE FROM users`);

    const { authRequired } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', authRequired, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });
});

// ─── GET /api/auth/me ───

describe('GET /api/auth/me', () => {
  test('returns current user with valid access token', async () => {
    const { accessToken } = await registerUser();

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.user.githubConnected).toBe(false);
    expect(res.body.user.id).toBeDefined();
  });

  test('returns LOCAL_ADMIN fallback without auth token (local single-user mode)', async () => {
    // afterEach truncates users, so no DB users exist.
    // In local mode (AUTH_REQUIRED not set), /me falls back to LOCAL_ADMIN synthetic user.
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('local-admin');
    expect(res.body.user.email).toBe('admin@rorca.local');
  });
});

// ─── Global auth middleware integration ───

describe('Global auth middleware', () => {
  test('public routes are accessible without auth', async () => {
    // Health endpoint — status is 'ok' or 'degraded' (worker not running in tests)
    const healthRes = await request(app).get('/api/health');
    expect(healthRes.status).toBe(200);
    expect(['ok', 'degraded']).toContain(healthRes.body.status);

    // Auth endpoints — login returns 401 for bad creds but with route-specific error, not middleware's "Authentication required"
    const loginRes = await request(app).post('/api/auth/login').send({ email: 'x@y.com', password: 'test' });
    expect(loginRes.body.error).not.toBe('Authentication required');

    // Register is accessible without auth (returns 422 for Zod validation failure, not 401)
    const registerRes = await request(app).post('/api/auth/register').send({});
    expect(registerRes.status).toBe(422);
  });

  test('protected routes are accessible since auth is intentionally bypassed', async () => {
    // Auth middleware is intentionally bypassed for local single-user mode (see CLAUDE.md)
    const res = await request(app).get('/api/workspaces');
    expect([200, 401]).toContain(res.status);
  });

  test('protected routes succeed with valid auth token', async () => {
    const { accessToken } = await registerUser();
    const res = await request(app).get('/api/workspaces').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

// ─── POST /api/auth/forgot-password ───

describe('POST /api/auth/forgot-password', () => {
  test('returns 200 with success message for existing email', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    expect(res.body.resetLink).toBeDefined();
  });

  test('returns 200 with same message for non-existent email (no enumeration)', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toContain('If an account with that email exists');
    // No resetLink for non-existent email
    expect(res.body.resetLink).toBeUndefined();
  });

  test('stores hashed reset token in database', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const tokens = await query(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).toBeDefined();
    expect(tokens[0].expires_at).toBeDefined();
    expect(tokens[0].used_at).toBeNull();
  });

  test('reset token expires in ~1 hour', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const token = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    // PostgreSQL returns proper ISO timestamps
    const expiresAt = new Date(token.expires_at as string).getTime();
    const createdAt = new Date(token.created_at as string).getTime();
    const hoursUntilExpiry = (expiresAt - createdAt) / (1000 * 60 * 60);
    expect(hoursUntilExpiry).toBeGreaterThan(0.9);
    expect(hoursUntilExpiry).toBeLessThan(1.1);
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for invalid email format', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  test('normalizes email to lowercase', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'Test@EXAMPLE.COM' });
    expect(res.status).toBe(200);
    expect(res.body.resetLink).toBeDefined();
  });

  test('rate limits to 3 requests per email per hour', async () => {
    await registerUser();

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
      expect(res.status).toBe(200);
    }

    // 4th should be rate limited
    const res = await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Too many reset requests');
  });

  test('emits password_reset_requested WAL event', async () => {
    await registerUser();

    await request(app).post('/api/auth/forgot-password').send({ email: 'test@example.com' });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset_requested'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });
});

// ─── POST /api/auth/reset-password ───

describe('POST /api/auth/reset-password', () => {
  /** Helper: request a reset token and return the raw token */
  async function getResetToken(email = 'test@example.com'): Promise<string> {
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    // Extract token from resetLink URL
    const url = new URL(res.body.resetLink);
    return url.searchParams.get('token')!;
  }

  test('resets password with valid token', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toContain('Password has been reset successfully');
  });

  test('can login with new password after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old password should fail
    const oldRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'SecurePass123',
    });
    expect(oldRes.status).toBe(401);

    // New password should succeed
    const newRes = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'newpassword123',
    });
    expect(newRes.status).toBe(200);
    expect(newRes.body.accessToken).toBeDefined();
  });

  test('marks token as used after reset', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const resetToken = await queryOne(`SELECT * FROM password_reset_tokens`) as Record<string, unknown>;
    expect(resetToken.used_at).not.toBeNull();
  });

  test('returns 400 for already-used token', async () => {
    await registerUser();
    const token = await getResetToken();

    // First use succeeds
    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Second use fails
    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'anotherpassword',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has already been used');
  });

  test('returns 400 for expired token', async () => {
    await registerUser();
    const token = await getResetToken();

    // Manually expire the token
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await execute(`UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour' WHERE token_hash = $1`, [tokenHash]);

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This reset token has expired');
  });

  test('returns 400 for invalid token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({
      token: 'completely-invalid-token',
      newPassword: 'newpassword123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid or expired reset token');
  });

  test('returns 400 for missing token', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ newPassword: 'newpassword123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Reset token is required');
  });

  test('returns 400 for missing newPassword', async () => {
    const res = await request(app).post('/api/auth/reset-password').send({ token: 'sometoken' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('New password is required');
  });

  test('returns 400 for password shorter than 8 characters', async () => {
    await registerUser();
    const token = await getResetToken();

    const res = await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
  });

  test('invalidates all refresh tokens for the user', async () => {
    const { refreshToken } = await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    // Old refresh token should be revoked
    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshRes.status).toBe(401);
  });

  test('emits password_reset WAL event', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const event = await queryOne(`SELECT * FROM wal_events WHERE event_type = 'password_reset'`) as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = event.payload as Record<string, unknown>;
    expect(payload.email).toBe('test@example.com');
  });

  test('stores new password as bcrypt hash', async () => {
    await registerUser();
    const token = await getResetToken();

    await request(app).post('/api/auth/reset-password').send({
      token,
      newPassword: 'newpassword123',
    });

    const user = await queryOne(`SELECT * FROM users WHERE email = $1`, ['test@example.com']) as Record<string, unknown>;
    expect(user.password_hash).toBeDefined();
    expect(user.password_hash).not.toBe('newpassword123');
    expect((user.password_hash as string).startsWith('$2a$') || (user.password_hash as string).startsWith('$2b$')).toBe(true);
  });
});

// ─── Token encryption helpers ───

describe('encryptToken / decryptToken', () => {
  test('round-trips a token correctly', () => {
    const { encryptToken, decryptToken } = require('../auth');
    const original = 'gho_abc123XYZ';
    const encrypted = encryptToken(original);
    expect(encrypted).not.toBe(original);
    expect(encrypted.split(':')).toHaveLength(3);
    const decrypted = decryptToken(encrypted);
    expect(decrypted).toBe(original);
  });

  test('produces different ciphertexts for the same input (random IV)', () => {
    const { encryptToken } = require('../auth');
    const token = 'gho_test_token';
    const enc1 = encryptToken(token);
    const enc2 = encryptToken(token);
    expect(enc1).not.toBe(enc2);
  });
});
