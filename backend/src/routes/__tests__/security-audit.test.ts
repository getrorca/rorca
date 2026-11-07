/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { createServer, type Server } from 'node:http';
import request from 'supertest';
import app from '../../server';

let server: Server;

describe('security audit regressions', () => {
  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  test('state-changing route rejects missing CSRF token with 403', async () => {
    const res = await request(server)
      .post('/api/workspaces')
      .set('Origin', 'http://localhost:5210')
      .send({ path: '/tmp/demo', label: 'Demo' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
    expect(JSON.stringify(res.body)).not.toMatch(/token|bearer|jwt/i);
  });

  test('invalid bearer token is rejected with 401 in local fallback mode', async () => {
    const res = await request(server)
      .get('/api/workspaces')
      .set('Authorization', 'Bearer forged.invalid.token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/forged\.invalid\.token/);
  });
});
