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

describe('POST /api/auth/register', () => {
  const validPayload = {
    email: 'test@example.com',
    password: 'securepass123',
    displayName: 'Test User',
  };

  test('returns 201 with tokens on successful registration', async () => {
    const res = await request(app).post('/api/auth/register').send(validPayload);

    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.displayName).toBe('Test User');
    expect(res.body.user.id).toBeDefined();
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    // Ensure no password in response
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
    const res = await request(app).post('/api/auth/register').send({
      ...validPayload,
      email: 'not-an-email',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });

  test('returns 400 for missing email', async () => {
    const res = await request(app).post('/api/auth/register').send({
      password: 'securepass123',
      displayName: 'Test User',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email is required');
  });

  test('returns 400 for missing password', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      displayName: 'Test User',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password is required');
  });

  test('returns 400 for missing displayName', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email: 'test@example.com',
      password: 'securepass123',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Display name is required');
  });

  test('returns 400 for password shorter than 8 characters', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validPayload,
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Password must be at least 8 characters');
  });

  test('normalizes email to lowercase', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validPayload,
      email: 'Test@EXAMPLE.com',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('test@example.com');
  });

  test('trims displayName whitespace', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validPayload,
      displayName: '  Padded Name  ',
    });
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
    const res = await request(app).post('/api/auth/register').send({
      ...validPayload,
      email: 'test @example.com',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid email format');
  });
});
