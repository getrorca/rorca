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
import { getAuthToken } from './helpers/auth-helper';
import { execute } from '../../db/index';

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-onboarding-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
authToken = await getAuthToken(app);
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

describe('GET /api/onboarding', () => {
  it('returns default state on first call', async () => {
    const res = await request(app)
      .get('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe(0);
    expect(res.body.workspaceId).toBeNull();
    expect(res.body.directionDone).toBe(false);
    expect(res.body.completed).toBe(false);
  });

  it('returns existing state if row exists', async () => {
    await execute(`INSERT INTO onboarding_state (id, current_step, workspace_id, direction_done, completed) VALUES (1, 3, 'ws-123', 1, 0) ON CONFLICT (id) DO NOTHING`);

    const res = await request(app)
      .get('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe(3);
    expect(res.body.workspaceId).toBe('ws-123');
    expect(res.body.directionDone).toBe(true);
    expect(res.body.completed).toBe(false);
  });
});

describe('PUT /api/onboarding', () => {
  it('updates currentStep', async () => {
    const res = await request(app)
      .put('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ currentStep: 2 });

    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe(2);
  });

  it('updates workspaceId', async () => {
    const res = await request(app)
      .put('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-abc' });

    expect(res.status).toBe(200);
    expect(res.body.workspaceId).toBe('ws-abc');
  });

  it('updates directionDone', async () => {
    const res = await request(app)
      .put('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ directionDone: true });

    expect(res.status).toBe(200);
    expect(res.body.directionDone).toBe(true);
  });

  it('updates completed flag', async () => {
    const res = await request(app)
      .put('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ completed: true });

    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
  });

  it('updates multiple fields at once', async () => {
    const res = await request(app)
      .put('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ currentStep: 4, completed: true, workspaceId: 'ws-xyz' });

    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe(4);
    expect(res.body.completed).toBe(true);
    expect(res.body.workspaceId).toBe('ws-xyz');
  });

  it('returns 400 when no fields provided', async () => {
    const res = await request(app)
      .put('/api/onboarding')
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no fields to update/i);
  });
});
