/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import express from 'express';
import request from 'supertest';
import { planGate } from '../plan-gate';

jest.mock('../get-user', () => ({
  getEffectiveUser: jest.fn(async () => ({
    id: 'local-admin',
    email: 'local@rorca.internal',
    role: 'admin',
    plan: 'enterprise',
  })),
}));

function gatedApp() {
  const app = express();
  app.use(planGate());
  app.use((_req, res) => res.status(204).end());
  return app;
}

describe('planGate exact OpenAPI default-deny', () => {
  test('passes an exact public operation to its protected router', async () => {
    const response = await request(gatedApp()).get('/api/workspaces');
    expect(response.status).toBe(204);
  });

  test('passes an exact admin operation for the local admin principal', async () => {
    const response = await request(gatedApp()).get('/api/pipeline/runs/42/context-inspector-events');
    expect(response.status).toBe(204);
  });

  test('passes an explicitly classified native operation to its route-level authority', async () => {
    const response = await request(gatedApp()).post('/api/workspaces');
    expect(response.status).toBe(204);
  });

  test('denies an explicitly classified sensitive operation', async () => {
    const response = await request(gatedApp()).get('/api/auth/me');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });

  test('denies an unmatched protected method/path instead of falling through', async () => {
    const response = await request(gatedApp()).post('/api/pipeline/not-a-real-operation');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });
});
