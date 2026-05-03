/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

jest.mock('../../lib/llm-client', () => ({
  chatComplete: jest.fn(),
  getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
  isValidModel: jest.fn().mockReturnValue(true),
  DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
  resolveVaultProvider: jest.fn().mockReturnValue(null),
  getModelInfo: jest.fn().mockReturnValue(undefined),
  SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
}));

let app: Express;
let tmpDir: string;
let authToken: string;

beforeEach(async () => {
  jest.resetModules();

  jest.mock('../../lib/llm-client', () => ({
    chatComplete: jest.fn(),
    getActiveProvider: jest.fn().mockReturnValue('claude-cli'),
    isValidModel: jest.fn().mockReturnValue(true),
    DEFAULT_MODEL: 'claude-sonnet-4-5-20250929',
    resolveVaultProvider: jest.fn().mockReturnValue(null),
    getModelInfo: jest.fn().mockReturnValue(undefined),
    SUPPORTED_MODELS: ['claude-sonnet-4-5-20250929'],
  }));

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sched-test-'));
  const _dbPath = path.join(tmpDir, 'test.db');
process.env.NODE_ENV = 'test';

  const serverMod = require('../../server');
  app = serverMod.default;
await execute(`INSERT INTO workspaces (id, label, path) VALUES ('ws-sched', 'Sched WS', $1) ON CONFLICT (id) DO NOTHING`, [tmpDir]);

  authToken = await getAuthToken(app);
});

afterEach(() => {
fs.rmSync(tmpDir, { recursive: true, force: true });
delete process.env.NODE_ENV;
});

describe('POST /api/pipeline/schedules', () => {
  it('creates a schedule with valid cron expression', async () => {
    const res = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-sched',
        specId: 'my-spec',
        cronExpression: '0 2 * * *',
      });

    expect(res.status).toBe(201);
    expect(res.body.schedule).toBeDefined();
    expect(res.body.schedule.workspace_id).toBe('ws-sched');
    expect(res.body.schedule.spec_id).toBe('my-spec');
    expect(res.body.schedule.cron_expression).toBe('0 2 * * *');
    expect(res.body.schedule.enabled).toBe(true);
    expect(res.body.schedule.next_run_at).toBeTruthy();
  });

  it('rejects an invalid cron expression', async () => {
    const res = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-sched',
        specId: 'my-spec',
        cronExpression: 'not-a-cron',
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Invalid cron expression/);
  });

  it('returns 400 when missing required fields', async () => {
    const res = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched' });

    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent workspace', async () => {
    const res = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        workspaceId: 'ws-nonexistent',
        specId: 'my-spec',
        cronExpression: '0 2 * * *',
      });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/pipeline/schedules', () => {
  it('lists schedules for a workspace', async () => {
    // Create two schedules
    await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'spec-a', cronExpression: '0 2 * * *' });
    await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'spec-b', cronExpression: '30 3 * * 1' });

    const res = await request(app)
      .get('/api/pipeline/schedules?workspaceId=ws-sched')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].next_run_at).toBeTruthy();
  });

  it('returns 400 when workspaceId is missing', async () => {
    const res = await request(app)
      .get('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/pipeline/schedules/:id', () => {
  it('updates a schedule cron expression', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'spec-a', cronExpression: '0 2 * * *' });

    const id = createRes.body.schedule.id;

    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ cronExpression: '0 4 * * *' });

    expect(res.status).toBe(200);
    expect(res.body.schedule.cron_expression).toBe('0 4 * * *');
  });

  it('can disable a schedule', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'spec-a', cronExpression: '0 2 * * *' });

    const id = createRes.body.schedule.id;

    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(false);
    expect(res.body.schedule.next_run_at).toBeNull();
  });

  it('rejects invalid cron on update', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'spec-a', cronExpression: '0 2 * * *' });

    const id = createRes.body.schedule.id;

    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ cronExpression: 'bad' });

    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/pipeline/schedules/:id', () => {
  it('deletes a schedule', async () => {
    const createRes = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'spec-a', cronExpression: '0 2 * * *' });

    const id = createRes.body.schedule.id;

    const res = await request(app)
      .delete(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verify it's gone
    const listRes = await request(app)
      .get('/api/pipeline/schedules?workspaceId=ws-sched')
      .set('Authorization', `Bearer ${authToken}`);
    expect(listRes.body.items).toHaveLength(0);
  });

  it('returns 404 for non-existent schedule', async () => {
    const res = await request(app)
      .delete('/api/pipeline/schedules/9999')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});

describe('pipeline_runs trigger_type', () => {
  it('pipeline_runs table has trigger_type column defaulting to manual', async () => {
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status) VALUES ('spec.json', 'ws-sched', 'running')`);
    const run = await queryOne(`SELECT * FROM pipeline_runs WHERE workspace_id = $1`, ['ws-sched']) as Record<string, unknown>;
    expect(run.trigger_type).toBe('manual');
  });

  it('can insert pipeline_runs with trigger_type=scheduled', async () => {
    await execute(`INSERT INTO pipeline_runs (spec_path, workspace_id, status, trigger_type) VALUES ('spec.json', 'ws-sched', 'running', 'scheduled')`);
    const run = await queryOne(`SELECT * FROM pipeline_runs WHERE workspace_id = $1`, ['ws-sched']) as Record<string, unknown>;
    expect(run.trigger_type).toBe('scheduled');
  });
});
