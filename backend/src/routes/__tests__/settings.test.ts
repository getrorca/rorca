/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

let app: Server;
let tmpDir: string;
let authToken: string;
let userId: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-settings-test-'));
  const authId = crypto.randomUUID();
  const email = `settings-${crypto.randomUUID()}@test.rorca.local`;
  const user = await ensureTestUser({ email, authId, role: 'admin', plan: 'pro' });
  userId = user.id;
  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  authToken = await getAuthToken(expressApp, { email, authId, role: 'admin', displayName: 'Settings Test User' });
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

beforeEach(async () => {
  await execute('DELETE FROM user_settings WHERE user_id = $1', [userId]);
  await execute(
    `UPDATE users SET display_name = 'Settings Test User', avatar_url = NULL WHERE id = $1`,
    [userId],
  );
});

afterAll(async () => {
  await execute('DELETE FROM user_settings WHERE user_id = $1', [userId]);
  await execute('DELETE FROM users WHERE id = $1', [userId]);
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('GET /api/settings/profile', () => {
  it('returns the current user profile', async () => {
    const res = await request(app)
      .get('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.email).toBeDefined();
    expect(res.body.displayName).toBeDefined();
    expect(res.body.id).toBeDefined();
  });
});

describe('PUT /api/settings/profile', () => {
  it('updates display name', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ displayName: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify in DB
    const profile = await request(app)
      .get('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`);
    expect(profile.body.displayName).toBe('Updated Name');
  });

  it('updates avatar URL', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ avatarUrl: 'https://example.com/avatar.png' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 4xx for empty displayName', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ displayName: '' });

    // Zod validation returns 422 for schema violations
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('returns 400 for empty body', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/settings/password retirement', () => {
  it.each([
    { currentPassword: 'definitelywrongpassword', newPassword: 'newpassword456' },
    { newPassword: 'newpassword456' },
    { currentPassword: 'securepass123', newPassword: 'abc' },
  ])('remains unavailable without reflecting password material', async (body) => {
    const res = await request(app)
      .put('/api/settings/password')
      .set('Authorization', `Bearer ${authToken}`)
      .send(body);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(JSON.stringify(res.body)).not.toContain(String(body.currentPassword ?? body.newPassword));
  });
});

describe('GET /api/settings/display', () => {
  it('returns default display settings', async () => {
    const res = await request(app)
      .get('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.defaultModel).toBeDefined();
    expect(res.body.itemsPerPage).toBeDefined();
    expect(typeof res.body.itemsPerPage).toBe('number');
  });
});

describe('PUT /api/settings/display', () => {
  it('updates display preferences', async () => {
    const res = await request(app)
      .put('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ defaultModel: 'claude-opus-4-6', itemsPerPage: 50 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.defaultModel).toBe('claude-opus-4-6');
    expect(res.body.itemsPerPage).toBe(50);
  });

  it('clamps itemsPerPage to valid range', async () => {
    const res = await request(app)
      .put('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ itemsPerPage: 200 }); // exceeds max of 100

    expect(res.status).toBe(200);
    expect(res.body.itemsPerPage).toBe(20); // falls back to default when out of range
  });

  it('persists display settings across requests', async () => {
    await request(app)
      .put('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ itemsPerPage: 75 });

    const getRes = await request(app)
      .get('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`);

    expect(getRes.body.itemsPerPage).toBe(75);
  });
});
