/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';

let app: Express;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);
});

describe('PUT /api/settings/profile', () => {
  it('returns 400 for empty body', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});
    console.log('=== empty body status:', res.status, 'body:', JSON.stringify(res.body), '===');
    expect(res.status).toBe(400);
  });

  it('returns 4xx for empty displayName', async () => {
    const res = await request(app)
      .put('/api/settings/profile')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ displayName: '' });
    console.log('=== empty displayName status:', res.status, 'body:', JSON.stringify(res.body), '===');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('returns 403 for wrong password', async () => {
    const res = await request(app)
      .put('/api/settings/password')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ currentPassword: 'definitelywrongpassword', newPassword: 'newpassword456' });
    console.log('=== wrong password status:', res.status, 'body:', JSON.stringify(res.body), '===');
    expect(res.status).toBe(403);
  });

  it('returns defaults for display settings', async () => {
    const res = await request(app)
      .get('/api/settings/display')
      .set('Authorization', `Bearer ${authToken}`);
    console.log('=== display settings status:', res.status, 'body:', JSON.stringify(res.body), '===');
    expect(res.status).toBe(200);
  });
});
