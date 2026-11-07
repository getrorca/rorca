/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

let app: Server;
let authToken: string;
let userId: string;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const authId = crypto.randomUUID();
  const email = `settings-contract-${crypto.randomUUID()}@test.rorca.local`;
  const user = await ensureTestUser({ email, authId, role: 'admin', plan: 'pro' });
  userId = user.id;
  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  authToken = await getAuthToken(expressApp, { email, authId, role: 'admin' });
  app = expressApp.listen(0, '127.0.0.1');
  await once(app, 'listening');
});

afterAll(async () => {
  await execute('DELETE FROM user_settings WHERE user_id = $1', [userId]);
  await execute('DELETE FROM users WHERE id = $1', [userId]);
  app.closeAllConnections();
  await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
  delete process.env.NODE_ENV;
});

describe('settings validation and retired password contract', () => {
  it('returns 400 for empty profile body', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 4xx for empty displayName', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ displayName: '' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('keeps password mutation unregistered and redacts submitted credentials', async () => {
    const currentPassword = 'definitelywrongpassword';
    const res = await request(app)
      .put('/api/settings/password')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ currentPassword, newPassword: 'newpassword456' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(JSON.stringify(res.body)).not.toContain(currentPassword);
  });

  it('returns defaults for display settings', async () => {
    const res = await request(app)
      .get('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
  });
});
