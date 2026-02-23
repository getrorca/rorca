import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';

let app: Express;
let db: Database.Database;
let tmpDir: string;

beforeEach(() => {
  jest.resetModules();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorcha-auth-test-'));
  process.env.DB_PATH = path.join(tmpDir, 'test.db');

  // Create workspace dir structure for specs (required by some route mounts)
  const wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'pending'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'scripts', 'ralph', 'specs', 'approved'), { recursive: true });

  db = require('../../db').db;
  app = require('../../server').default;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
});

const validPayload = {
  email: 'test@example.com',
  password: 'securepass123',
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

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get('test@example.com') as Record<string, unknown>;
    expect(user).toBeDefined();
    expect(user.password_hash).toBeDefined();
    expect(user.password_hash).not.toBe('securepass123');
    expect((user.password_hash as string).startsWith('$2a$12$') || (user.password_hash as string).startsWith('$2b$12$')).toBe(true);
  });

  test('returns 409 if email already exists', async () => {
    await request(app).post('/api/auth/register').send(validPayload);
    const res = await request(app).post('/api/auth/register').send(validPayload);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Email already registered');
  });

  test('returns 400 for malformed email', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/register').send({ password: 'securepass123', displayName: 'Test User' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for missing password', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'test@example.com', displayName: 'Test User' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password is required');
  });

  test('returns 400 for missing displayName', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'test@example.com', password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Display name is required');
  });

  test('returns 400 for password shorter than 8 characters', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...validPayload, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
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
    const tokens = db.prepare('SELECT * FROM refresh_tokens').all() as Record<string, unknown>[];
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token_hash).toBeDefined();
    expect(tokens[0].expires_at).toBeDefined();
  });

  test('emits user_registered WAL event', async () => {
    await request(app).post('/api/auth/register').send(validPayload);
    const event = db.prepare("SELECT * FROM wal_events WHERE event_type = 'user_registered'").get() as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = JSON.parse(event.payload as string);
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
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });
});

// ─── POST /api/auth/login ───

describe('POST /api/auth/login', () => {
  test('returns 200 with tokens on valid credentials', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'securepass123',
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
      password: 'securepass123',
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
      password: 'securepass123',
    });

    // Should have 2 refresh tokens now (1 from register, 1 from login)
    const tokens = db.prepare('SELECT * FROM refresh_tokens ORDER BY created_at DESC').all() as Record<string, unknown>[];
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
      password: 'securepass123',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/login').send({ password: 'securepass123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for missing password', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'test@example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password is required');
  });

  test('normalizes email to lowercase', async () => {
    await registerUser();

    const res = await request(app).post('/api/auth/login').send({
      email: 'Test@EXAMPLE.COM',
      password: 'securepass123',
    });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('test@example.com');
  });

  test('emits user_login WAL event', async () => {
    await registerUser();

    await request(app).post('/api/auth/login').send({
      email: 'test@example.com',
      password: 'securepass123',
    });

    const event = db.prepare("SELECT * FROM wal_events WHERE event_type = 'user_login'").get() as Record<string, unknown>;
    expect(event).toBeDefined();
    const payload = JSON.parse(event.payload as string);
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
    db.prepare("UPDATE refresh_tokens SET expires_at = datetime('now', '-1 day') WHERE token_hash = ?").run(tokenHash);

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
    const token = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as Record<string, unknown>;
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

// ─── requireAuth middleware ───

describe('requireAuth middleware', () => {
  test('returns 401 for missing Authorization header', async () => {
    // We need a protected route to test middleware — use a simple test
    const { requireAuth } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', requireAuth, (_req: any, res: any) => {
      res.json({ ok: true, userId: _req.userId });
    });

    const res = await request(testApp).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authorization required');
  });

  test('returns 401 with "Token expired" for expired access token', async () => {
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, requireAuth } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', requireAuth, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    // Create an already-expired token
    const expiredToken = jwt.sign({ sub: 'user123', email: 'test@example.com' }, JWT_SECRET, { expiresIn: '0s' });

    // Wait a tick so it's definitely expired
    await new Promise(resolve => setTimeout(resolve, 100));

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Token expired');
  });

  test('returns 401 with "Invalid token" for malformed JWT', async () => {
    const { requireAuth } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', requireAuth, (_req: any, res: any) => {
      res.json({ ok: true });
    });

    const res = await request(testApp).get('/protected').set('Authorization', 'Bearer invalidjwt');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token');
  });

  test('passes with valid access token and populates userId', async () => {
    const { accessToken, user } = await registerUser();

    const { requireAuth } = require('../auth');
    const express = require('express');
    const testApp = express();
    testApp.use(express.json());
    testApp.get('/protected', requireAuth, (req: any, res: any) => {
      res.json({ ok: true, userId: req.userId, userEmail: req.userEmail });
    });

    const res = await request(testApp).get('/protected').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(user.id);
    expect(res.body.userEmail).toBe('test@example.com');
  });
});
