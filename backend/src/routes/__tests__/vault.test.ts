import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

// Mock llm-client before any imports that use it
jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockImplementation((m: string) =>
    ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
  ),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
}));

let app: Express;
let db: Database.Database;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockImplementation((m: string) =>
      ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'].includes(m)
    ),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-vault-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  process.env.DB_PATH = dbPath;
  process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
  const dbMod = require('../../db/index');
  db = dbMod.db;

  authToken = await getAuthToken(app);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DB_PATH;
  delete process.env.NODE_ENV;
});

// ─── POST /api/vault/keys ──────────────────────────────────────────────────

describe('POST /api/vault/keys', () => {
  test('stores a key and returns masked version', async () => {
    const res = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'anthropic', key: 'sk-ant-api03-test1234', label: 'My Anthropic Key' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.provider).toBe('anthropic');
    expect(res.body.label).toBe('My Anthropic Key');
    expect(res.body.masked_key).toBe('****1234');
    expect(res.body).not.toHaveProperty('key');
    expect(res.body).not.toHaveProperty('encrypted_key');
  });

  test('rejects missing provider', async () => {
    const res = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'sk-test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/provider/i);
  });

  test('rejects missing key', async () => {
    const res = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'anthropic' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key/i);
  });

  test('rejects invalid provider', async () => {
    const res = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'invalid-provider', key: 'sk-test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid provider/i);
  });

  test('plaintext key is never stored in DB', async () => {
    const plainKey = 'sk-ant-api03-plaintext-check';
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'anthropic', key: plainKey, label: 'Check' });

    const row = db.prepare('SELECT encrypted_key FROM api_key_vault LIMIT 1').get() as { encrypted_key: string };
    expect(row.encrypted_key).not.toBe(plainKey);
    expect(row.encrypted_key).toContain(':'); // iv:authTag:ciphertext format
  });
});

// ─── GET /api/vault/keys ───────────────────────────────────────────────────

describe('GET /api/vault/keys', () => {
  test('lists stored keys with masked values', async () => {
    // Create two keys
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'anthropic', key: 'sk-ant-key-abcd', label: 'Key 1' });
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'openrouter', key: 'sk-or-key-wxyz', label: 'Key 2' });

    const res = await request(app)
      .get('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(2);

    const providers = res.body.keys.map((k: any) => k.provider).sort();
    expect(providers).toEqual(['anthropic', 'openrouter']);

    const anthropicKey = res.body.keys.find((k: any) => k.provider === 'anthropic');
    const openrouterKey = res.body.keys.find((k: any) => k.provider === 'openrouter');
    expect(anthropicKey.masked_key).toBe('****abcd');
    expect(openrouterKey.masked_key).toBe('****wxyz');
    expect(anthropicKey.spend_total_usd).toBe(0);

    // No plaintext or encrypted key in response
    for (const k of res.body.keys) {
      expect(k).not.toHaveProperty('encrypted_key');
    }
  });

  test('returns empty array when no keys stored', async () => {
    const res = await request(app)
      .get('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.keys).toEqual([]);
  });
});

// ─── DELETE /api/vault/keys/:id ────────────────────────────────────────────

describe('DELETE /api/vault/keys/:id', () => {
  test('deletes a key and returns spend total', async () => {
    const createRes = await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'anthropic', key: 'sk-ant-delete-me', label: 'Temp' });
    const keyId = createRes.body.id;

    const res = await request(app)
      .delete(`/api/vault/keys/${keyId}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.spend_total_usd).toBe(0);

    // Verify deleted
    const listRes = await request(app)
      .get('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`);
    expect(listRes.body.keys).toHaveLength(0);
  });

  test('returns 404 for non-existent key', async () => {
    const res = await request(app)
      .delete('/api/vault/keys/nonexistent-id')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});

// ─── getVaultKey helper ────────────────────────────────────────────────────

describe('getVaultKey', () => {
  test('returns decrypted key for matching provider', async () => {
    const plainKey = 'sk-ant-api03-vault-test-key';
    await request(app)
      .post('/api/vault/keys')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ provider: 'anthropic', key: plainKey, label: 'SDK' });

    // Get the user id from the DB
    const user = db.prepare("SELECT id FROM users WHERE email = 'testauth@example.com'").get() as { id: string };

    const { getVaultKey } = require('../vault');
    const result = getVaultKey(user.id, 'anthropic');
    expect(result).not.toBeNull();
    expect(result.key).toBe(plainKey);
    expect(result.baseUrl).toBeNull();
  });

  test('returns null when no key exists for provider', async () => {
    const user = db.prepare("SELECT id FROM users WHERE email = 'testauth@example.com'").get() as { id: string };

    const { getVaultKey } = require('../vault');
    const result = getVaultKey(user.id, 'openai');
    expect(result).toBeNull();
  });
});
