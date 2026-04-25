import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

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
let tmpDir: string;
let authToken: string;
let authId: string;

const WORKSPACE_ID = 'ws-env-test';

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-envvars-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
// Seed a workspace
  await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`, [WORKSPACE_ID, tmpDir]);
  await execute(`DELETE FROM workspace_env_vars WHERE workspace_id = $1`, [WORKSPACE_ID]);

  authId = crypto.randomUUID();
  const email = `testauth+${authId}@example.com`;
  authToken = await getAuthToken(app, { authId, email });
  await execute(
    `INSERT INTO workspace_members (workspace_id, user_auth_id, role)
     VALUES ($1, $2::uuid, 'admin')
     ON CONFLICT (workspace_id, user_auth_id) DO UPDATE SET role = EXCLUDED.role`,
    [WORKSPACE_ID, authId],
  );
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

// ─── POST /api/workspaces/:id/env-vars ──────────────────────────────────────

describe('POST /api/workspaces/:id/env-vars', () => {
  test('creates a secret env var and returns 201 with masked value', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'DATABASE_URL', value: 'postgres://localhost/mydb', isSecret: true });

    expect(res.status).toBe(201);
    expect(res.body.key).toBe('DATABASE_URL');
    expect(res.body.value).toBe('••••••');
    expect(res.body.isSecret).toBe(true);
    expect(res.body.id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
    expect(res.body.updatedAt).toBeDefined();
  });

  test('creates a non-secret env var and returns plaintext value', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'NODE_ENV', value: 'production', isSecret: false });

    expect(res.status).toBe(201);
    expect(res.body.key).toBe('NODE_ENV');
    expect(res.body.value).toBe('production');
    expect(res.body.isSecret).toBe(false);
  });

  test('defaults to secret when isSecret is not provided', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'API_KEY', value: 'sk-12345' });

    expect(res.status).toBe(201);
    expect(res.body.isSecret).toBe(true);
    expect(res.body.value).toBe('••••••');
  });

  test('upserts existing env var (returns 200)', async () => {
    // Create
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'MY_VAR', value: 'old-value', isSecret: false });

    // Update
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'MY_VAR', value: 'new-value', isSecret: false });

    expect(res.status).toBe(200);
    expect(res.body.key).toBe('MY_VAR');
    expect(res.body.value).toBe('new-value');
  });

  test('missing key → 400', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ value: 'some-value' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('key');
  });

  test('missing value → 400', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'MY_VAR' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('value');
  });

  test('invalid key format → 400', async () => {
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'invalid-key!', value: 'val' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid key format');
  });

  test('non-member access to nonexistent workspace is forbidden before route lookup', async () => {
    const res = await request(app)
      .post('/api/workspaces/nonexistent/env-vars')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'MY_VAR', value: 'val' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });
});

// ─── GET /api/workspaces/:id/env-vars ───────────────────────────────────────

describe('GET /api/workspaces/:id/env-vars', () => {
  test('returns empty array when no env vars exist', async () => {
    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.envVars).toEqual([]);
  });

  test('lists env vars with secrets masked', async () => {
    // Create a secret and a non-secret var
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'API_KEY', value: 'secret-key-123', isSecret: true });
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'APP_MODE', value: 'debug', isSecret: false });

    const res = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.envVars).toHaveLength(2);

    // Sorted by key ASC
    const apiKey = res.body.envVars.find((v: any) => v.key === 'API_KEY');
    const appMode = res.body.envVars.find((v: any) => v.key === 'APP_MODE');

    expect(apiKey.value).toBe('••••••');
    expect(apiKey.isSecret).toBe(true);
    expect(appMode.value).toBe('debug');
    expect(appMode.isSecret).toBe(false);
  });

  test('non-member access to nonexistent workspace is forbidden before route lookup', async () => {
    const res = await request(app)
      .get('/api/workspaces/nonexistent/env-vars')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Forbidden');
  });
});

// ─── DELETE /api/workspaces/:id/env-vars/:key ───────────────────────────────

describe('DELETE /api/workspaces/:id/env-vars/:key', () => {
  test('deletes an env var and returns 204', async () => {
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'TO_DELETE', value: 'byebye' });

    const deleteRes = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/env-vars/TO_DELETE`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(deleteRes.status).toBe(204);

    // Verify it's gone
    const listRes = await request(app)
      .get(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(listRes.body.envVars).toHaveLength(0);
  });

  test('nonexistent key → 404', async () => {
    const res = await request(app)
      .delete(`/api/workspaces/${WORKSPACE_ID}/env-vars/NONEXISTENT`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Env var not found');
  });
});

// ─── getWorkspaceEnvVars helper ─────────────────────────────────────────────

describe('getWorkspaceEnvVars', () => {
  test('returns decrypted env vars as a plain object', async () => {
    // Create some vars
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'SECRET_KEY', value: 'my-secret', isSecret: true });
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'PUBLIC_VAR', value: 'public-val', isSecret: false });

    const { getWorkspaceEnvVars } = require('../env-vars');
    const vars = await getWorkspaceEnvVars(WORKSPACE_ID);

    expect(vars).toEqual({
      SECRET_KEY: 'my-secret',
      PUBLIC_VAR: 'public-val',
    });
  });

  test('returns empty object for workspace with no env vars', async () => {
    const { getWorkspaceEnvVars } = require('../env-vars');
    const vars = await getWorkspaceEnvVars(WORKSPACE_ID);
    expect(vars).toEqual({});
  });
});

// ─── Encryption validation ──────────────────────────────────────────────────

describe('encryption', () => {
  test('values are stored encrypted in the database', async () => {
    await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/env-vars`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ key: 'ENCRYPTED_TEST', value: 'plaintext-value' });

    const row = await queryOne(`SELECT encrypted_value FROM workspace_env_vars WHERE workspace_id = $1 AND key = $2`, [WORKSPACE_ID, 'ENCRYPTED_TEST']) as { encrypted_value: string };

    // Encrypted value should NOT be the plaintext
    expect(row.encrypted_value).not.toBe('plaintext-value');
    // Should be in iv:authTag:ciphertext hex format
    expect(row.encrypted_value.split(':')).toHaveLength(3);
  });
});
