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

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);
});

beforeEach(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-sched-test-'));

  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-sched'`);
  await execute(`DELETE FROM pipeline_schedules WHERE workspace_id = 'ws-sched'`);
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ('ws-sched', 'Sched WS', $1)
     ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path`,
    [tmpDir],
  );
});

afterEach(async () => {
  await execute(`DELETE FROM pipeline_runs WHERE workspace_id = 'ws-sched'`);
  await execute(`DELETE FROM pipeline_schedules WHERE workspace_id = 'ws-sched'`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env.NODE_ENV;
});

async function seedSchedule(specId = 'spec-a', cronExpression = '0 2 * * *'): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO pipeline_schedules (workspace_id, spec_id, cron_expression, enabled)
     VALUES ('ws-sched', $1, $2, TRUE) RETURNING id`,
    [specId, cronExpression],
  );
  return row!.id;
}

describe('POST /api/pipeline/schedules', () => {
  it('Release-1 rejects schedule creation before validation or persistence', async () => {
    const before = await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM pipeline_schedules WHERE workspace_id = 'ws-sched'`,
    );
    const res = await request(app)
      .post('/api/pipeline/schedules')
      .set('Authorization', `Bearer ${authToken}`)
      .send({ workspaceId: 'ws-sched', specId: 'my-spec', cronExpression: '0 2 * * *' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'RELEASE_ONE_CAPABILITY_DISABLED',
      details: { profileId: 'release-1-supervised-core', capabilityId: 'scheduled_autonomy' },
    });
    expect(await queryOne<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM pipeline_schedules WHERE workspace_id = 'ws-sched'`,
    )).toEqual(before);
  });
});

describe('GET /api/pipeline/schedules', () => {
  it('lists schedules for a workspace', async () => {
    await seedSchedule('spec-a', '0 2 * * *');
    await seedSchedule('spec-b', '30 3 * * 1');

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
  it('rejects cron reconfiguration while scheduled autonomy is disabled', async () => {
    const id = await seedSchedule();
    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ cronExpression: '0 4 * * *' });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      code: 'RELEASE_ONE_CAPABILITY_DISABLED',
      details: { capabilityId: 'scheduled_autonomy' },
    });
    expect(await queryOne<{ cron_expression: string }>(
      'SELECT cron_expression FROM pipeline_schedules WHERE id = $1',
      [id],
    )).toEqual({ cron_expression: '0 2 * * *' });
  });

  it('can disable a schedule', async () => {
    const id = await seedSchedule();

    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.schedule.enabled).toBe(false);
    expect(res.body.schedule.next_run_at).toBeNull();
  });

  it('cancels an undispatched application occurrence when configuration changes', async () => {
    const id = await seedSchedule();
    const occurrence = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_schedule_occurrences
         (schedule_id, workspace_id, scheduled_for, request_key, status)
       VALUES ($1, 'ws-sched', NOW(), $2, 'claimed') RETURNING id`,
      [id, `schedule-route-patch:${id}`],
    );

    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(await queryOne<{ status: string }>(
      'SELECT status FROM pipeline_schedule_occurrences WHERE id = $1',
      [occurrence!.id],
    )).toEqual({ status: 'cancelled' });
  });

  it('rejects cron updates at the Release-1 capability gate before parsing', async () => {
    const id = await seedSchedule();
    const res = await request(app)
      .patch(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ cronExpression: 'bad' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('RELEASE_ONE_CAPABILITY_DISABLED');
  });
});

describe('DELETE /api/pipeline/schedules/:id', () => {
  it('deletes a schedule', async () => {
    const id = await seedSchedule();

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

  it('refuses deletion while an application occurrence owns a live dispatch lease', async () => {
    const id = await seedSchedule();
    const occurrence = await queryOne<{ id: number }>(
      `INSERT INTO pipeline_schedule_occurrences
         (schedule_id, workspace_id, scheduled_for, request_key, status, lease_owner, lease_expires_at)
       VALUES ($1, 'ws-sched', NOW(), $2, 'dispatching', 'route-test-worker', NOW() + INTERVAL '1 minute')
       RETURNING id`,
      [id, `schedule-route-delete:${id}`],
    );

    const blocked = await request(app)
      .delete(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(blocked.status).toBe(422);

    await execute(
      `UPDATE pipeline_schedule_occurrences
          SET status = 'claimed', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1`,
      [occurrence!.id],
    );
    const deleted = await request(app)
      .delete(`/api/pipeline/schedules/${id}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(deleted.status).toBe(200);
    expect(await queryOne('SELECT id FROM pipeline_schedule_occurrences WHERE id = $1', [occurrence!.id])).toBeUndefined();
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
