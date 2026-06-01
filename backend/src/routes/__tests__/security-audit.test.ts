/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import request from 'supertest';
import app from '../../server';

describe('security audit regressions', () => {
  test('state-changing route rejects missing CSRF token with 403', async () => {
    const res = await request(app)
      .post('/api/workspaces')
      .send({ path: '/tmp/demo', label: 'Demo' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
    expect(JSON.stringify(res.body)).not.toMatch(/token|bearer|jwt/i);
  });

  test('invalid bearer token is rejected with 401 in local fallback mode', async () => {
    const res = await request(app)
      .get('/api/workspaces')
      .set('Authorization', 'Bearer forged.invalid.token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/forged\.invalid\.token/);
  });
});
