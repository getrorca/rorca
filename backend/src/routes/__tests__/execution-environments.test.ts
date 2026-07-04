/*
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import request from 'supertest';
import app from '../../server';
import { execute } from '../../db/index';

describe('execution environments routes', () => {
  it('lists default environments with readiness', async () => {
    const res = await request(app).get('/api/execution-environments');
    expect(res.status).toBe(200);
    expect(res.body.environments.map((env: any) => env.id)).toEqual(expect.arrayContaining(['remote-rorca', 'local-user']));
  });

  it('pairs runner token, accepts heartbeat, then exposes local readiness', async () => {
    const token = 'test-local-runner-token-that-is-long-enough';
    const setToken = await request(app)
      .post('/api/execution-environments/local-user/runner-token')
      .send({ token });
    expect(setToken.status).toBe(200);

    const hb = await request(app)
      .post('/api/execution-environments/local-user/runner/heartbeat')
      .set('Authorization', `Bearer ${token}`)
      .send({
        runnerId: 'test-runner',
        agents: {
          claude: { installed: true, credentialsReady: true, version: 'test' },
          codex: { installed: true, credentialsReady: false, version: 'test' },
        },
      });
    expect(hb.status).toBe(200);
    expect(hb.body.environment.ready).toBe(true);
    expect(hb.body.environment.agents.claude.ready).toBe(true);
    expect(hb.body.environment.agents.codex.ready).toBe(false);
  });

  it('runner can poll and complete an outbound job', async () => {
    const token = 'test-local-runner-token-two-that-is-long-enough';
    await request(app).post('/api/execution-environments/local-user/runner-token').send({ token });
    await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-test', 'Test Workspace', '/tmp/ws-test') ON CONFLICT (id) DO NOTHING`);
    await execute(`INSERT INTO pipeline_runs (id, spec_path, workspace_id, status, execution_environment) VALUES (99000001, 'spec.json', 'ws-test', 'queued', 'local-user') ON CONFLICT (id) DO NOTHING`);
    await execute(`INSERT INTO execution_runner_jobs (run_id, environment_id, payload, status) VALUES (99000001, 'local-user', $1::jsonb, 'queued') ON CONFLICT (run_id) DO UPDATE SET status = 'queued', payload = EXCLUDED.payload`, [JSON.stringify({ runId: 99000001, specPath: 'spec.json' })]);

    const poll = await request(app)
      .post('/api/execution-environments/local-user/runner/poll')
      .set('Authorization', `Bearer ${token}`)
      .send({ runnerId: 'test-runner-2' });
    expect(poll.status).toBe(200);
    expect(poll.body.job.runId).toBe(99000001);

    const running = await request(app)
      .post(`/api/execution-environments/local-user/runner/jobs/${poll.body.job.id}/running`)
      .set('Authorization', `Bearer ${token}`)
      .send({ runnerId: 'test-runner-2' });
    expect(running.status).toBe(200);

    const complete = await request(app)
      .post(`/api/execution-environments/local-user/runner/jobs/${poll.body.job.id}/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ runnerId: 'test-runner-2', status: 'succeeded', result: { ok: true } });
    expect(complete.status).toBe(200);
    expect(complete.body.job.status).toBe('succeeded');
  });
});
