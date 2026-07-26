/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import type { Server } from 'node:http';
import request from 'supertest';
import expressApp from '../../server';
import { closePool } from '../../db/index';

let app: Server;

describe('execution environments routes', () => {
  beforeAll(async () => {
    app = expressApp.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      app.once('listening', resolve);
      app.once('error', reject);
    });
  });

  afterAll(async () => {
    app.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    await closePool();
  });

  it('lists default environments with readiness', async () => {
    const res = await request(app).get('/api/execution-environments');
    expect(res.status).toBe(200);
    expect(res.body.environments.map((env: any) => env.id)).toEqual(['remote-rorca']);
    expect(res.body.unavailable).toContainEqual({
      id: 'local-user', deprecated: true, reason: 'LOCAL_USER_EXECUTION_UNAVAILABLE',
    });
  });

  it('rejects execution-environment control-plane mutation in Release-1', async () => {
    const response = await request(app)
      .put('/api/execution-environments/future-runner')
      .send({ label: 'Future runner', kind: 'local-runner' });
    expect(response.status).toBe(422);
    expect(response.body.details).toMatchObject({ capabilityId: 'unattended_control_plane_mutation' });
  });

  it('rejects local-user readiness and token pairing at the immutable Release-1 gate', async () => {
    const readiness = await request(app).get('/api/execution-environments/local-user/readiness');
    expect(readiness.status).toBe(422);
    expect(readiness.body.details).toMatchObject({ capabilityId: 'local_user_execution_bridge' });

    const setToken = await request(app)
      .post('/api/execution-environments/local-user/runner-token')
      .send({ token: 'test-local-runner-token-that-is-long-enough' });
    expect(setToken.status).toBe(422);
    expect(setToken.body.details).toMatchObject({ capabilityId: 'local_user_execution_bridge' });
  });

  it('rejects every outbound runner actuator before token, job, or result mutation', async () => {
    const cases = [
      { path: '/api/execution-environments/local-user/runner/heartbeat', body: { runnerId: 'runner', agents: {} } },
      { path: '/api/execution-environments/local-user/runner/poll', body: { runnerId: 'runner' } },
      { path: '/api/execution-environments/local-user/runner/jobs/job-1/running', body: { runnerId: 'runner' } },
      { path: '/api/execution-environments/local-user/runner/jobs/job-1/revalidate', body: { runnerId: 'runner' } },
      { path: '/api/execution-environments/local-user/runner/jobs/job-1/complete', body: { runnerId: 'runner', status: 'succeeded', result: { ok: true } } },
    ];

    for (const item of cases) {
      const response = await request(app)
        .post(item.path)
        .send(item.body);
      expect(response.status).toBe(422);
      expect(response.body.details).toMatchObject({ capabilityId: 'local_user_execution_bridge' });
    }
  });
});
