/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;
let extraUserEmail: string | null;

const WORKSPACE_ID = 'ws-users-test';

beforeEach(async () => {
  extraUserEmail = null;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-users-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
await execute(`INSERT INTO workspaces (id, label, path) VALUES ($1, 'Test Workspace', $2) ON CONFLICT (id) DO NOTHING`, [WORKSPACE_ID, tmpDir]);

  authToken = await getAuthToken(app);
});

afterEach(async () => {
  if (extraUserEmail) await execute('DELETE FROM users WHERE email = $1', [extraUserEmail]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('GET /api/users/me/assigned', () => {
  it('returns empty assignments when no assignments exist', async () => {
    const res = await request(app)
      .get('/api/users/me/assigned')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([]);
  });

  it('response has correct shape with assignments key', async () => {
    const res = await request(app)
      .get('/api/users/me/assigned')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assignments)).toBe(true);
  });
});

describe('GET /api/users/workspace-members', () => {
  it('returns users when workspaceId is provided', async () => {
    const res = await request(app)
      .get(`/api/users/workspace-members?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.members)).toBe(true);
    // At least the registered test user should be present
    expect(res.body.members.length).toBeGreaterThan(0);

    const member = res.body.members[0];
    expect(member).toHaveProperty('id');
    expect(member).toHaveProperty('displayName');
    expect(member).toHaveProperty('email');
  });

  it('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/users/workspace-members')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspaceId/i);
  });

  it('returns all users regardless of workspace (single-user mode)', async () => {
    // Register additional user
    extraUserEmail = `extra-${process.pid}-${Date.now()}@example.com`;
    await ensureTestUser({ email: extraUserEmail });

    const res = await request(app)
      .get(`/api/users/workspace-members?workspaceId=${WORKSPACE_ID}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.members.length).toBeGreaterThanOrEqual(2);
  });
});
