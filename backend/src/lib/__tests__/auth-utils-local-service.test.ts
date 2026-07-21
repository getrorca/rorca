/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import { authRequired, INTERNAL_SERVICE_TOKEN } from '../auth-utils';

function app() {
  const instance = express();
  instance.use(authRequired);
  instance.get('/identity', (req, res) => res.json({ user: req.user }));
  return instance;
}

const originalAuthRequired = process.env.AUTH_REQUIRED;

afterEach(() => {
  if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED;
  else process.env.AUTH_REQUIRED = originalAuthRequired;
});

describe('local topology service authentication', () => {
  test('omitted credentials retain the explicit local-human fallback', async () => {
    process.env.AUTH_REQUIRED = 'false';
    const response = await request(app()).get('/identity');
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({ id: 'local-admin', email: 'admin@rorca.local' });
  });

  test('the exact internal Bearer and Hermes label resolve as service authority before local fallback', async () => {
    process.env.AUTH_REQUIRED = 'false';
    const response = await request(app())
      .get('/identity')
      .set('Authorization', `Bearer ${INTERNAL_SERVICE_TOKEN}`)
      .set('X-Rorca-Service', 'hermes');
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      id: 'rorca-hermes-service',
      email: 'hermes@rorca.internal',
      role: 'admin',
    });
  });

  test.each([
    ['service label without a credential', { 'X-Rorca-Service': 'hermes' }],
    ['invalid service Bearer', { Authorization: 'Bearer invalid-service-credential', 'X-Rorca-Service': 'hermes' }],
    ['invalid internal header', { 'X-Rorca-Internal': 'invalid-service-credential' }],
    ['valid internal header plus contradictory Bearer', { 'X-Rorca-Internal': INTERNAL_SERVICE_TOKEN, Authorization: 'Bearer invalid-service-credential' }],
    ['unsupported service label', { Authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}`, 'X-Rorca-Service': 'unknown-service' }],
  ])('denies %s instead of converting it to local-human authority', async (_label, headers) => {
    process.env.AUTH_REQUIRED = 'false';
    const response = await request(app()).get('/identity').set(headers);
    expect(response.status).toBe(401);
    expect(response.body.user).toBeUndefined();
  });
});
