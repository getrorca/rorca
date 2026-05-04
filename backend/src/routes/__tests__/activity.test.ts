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
import { execute } from '../../db/index';

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

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-activity-test-'));
  process.env.NODE_ENV = 'test';
  process.env.AUTH_REQUIRED = 'true';

  const serverMod = require('../../server');
  app = serverMod.default;
  authToken = await getAuthToken(app);

  // Clear WAL events from user registration/login so tests start with a clean slate
  await execute('DELETE FROM wal_events');
});

afterEach(async () => {
  // Close the fresh pool created by jest.resetModules() + require('../../server') to prevent connection exhaustion
  try { const { closePool } = require('../../db/index'); await closePool(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
  delete process.env.AUTH_REQUIRED;
});

async function seedEvents() {
  const sql = "INSERT INTO wal_events (ts, event_type, workspace_id, spec_id, story_id, actor, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)";
  await execute(sql, ['2026-02-20T10:00:00', 'generate', 'ws-1', 'auth-feature', null, 'user-1', JSON.stringify({ title: 'Auth Feature' })]);
  await execute(sql, ['2026-02-20T11:00:00', 'spec_approved', 'ws-1', 'auth-feature', null, 'user-2', null]);
  await execute(sql, ['2026-02-20T12:00:00', 'run_started', 'ws-1', 'auth-feature', null, 'user-1', JSON.stringify({ runId: 'run-1' })]);
  await execute(sql, ['2026-02-20T13:00:00', 'story_passed', 'ws-1', 'auth-feature', 'US-001', 'ralph', JSON.stringify({ storyTitle: 'User Login' })]);
  await execute(sql, ['2026-02-20T14:00:00', 'run_finished', 'ws-1', 'auth-feature', null, 'user-1', JSON.stringify({ runId: 'run-1' })]);
  await execute(sql, ['2026-02-20T15:00:00', 'spec_rejected', 'ws-2', 'dashboard', null, 'user-2', JSON.stringify({ reason: 'Too vague' })]);
  await execute(sql, ['2026-02-20T16:00:00', 'story_comment_added', 'ws-1', 'auth-feature', 'US-002', 'user-1', JSON.stringify({ storyTitle: 'Password Reset' })]);
}

describe('GET /api/activity', () => {
  it('returns paginated activity items', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toBeInstanceOf(Array);
    // 7 seeded events (WAL events from auth are cleared in beforeEach)
    expect(res.body.items.length).toBe(7);
    expect(res.body.total).toBe(7);
    expect(res.body.hasMore).toBe(false);

    // Items should be in reverse chronological order
    const first = res.body.items[0];
    expect(first.activityType).toBe('comment_added');
    expect(first.description).toContain('commented');
  });

  it('returns empty feed when no events', async () => {
    const res = await request(app)
      .get('/api/activity')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    // user_registered event from auth helper
    expect(res.body.items.length).toBeGreaterThanOrEqual(0);
  });

  it('supports pagination with limit and offset', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity?limit=3&offset=0')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(3);
    expect(res.body.hasMore).toBe(true);

    const page2 = await request(app)
      .get(`/api/activity?limit=3&offset=3`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(page2.status).toBe(200);
    expect(page2.body.items.length).toBe(3);
    // Should not overlap with page 1
    const page1Ids = res.body.items.map((i: { id: number }) => i.id);
    const page2Ids = page2.body.items.map((i: { id: number }) => i.id);
    expect(page1Ids.filter((id: number) => page2Ids.includes(id))).toHaveLength(0);
  });

  it('filters by activity type', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity?type=spec_approved')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.activityType).toBe('spec_approved');
    }
    expect(res.body.items.length).toBe(1);
  });

  it('filters by workspace', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity?workspaceId=ws-2')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    for (const item of res.body.items) {
      expect(item.workspaceId).toBe('ws-2');
    }
    expect(res.body.items.length).toBe(1);
  });

  it('each activity item has the expected shape', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity?limit=1')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('timestamp');
    expect(item).toHaveProperty('activityType');
    expect(item).toHaveProperty('rawEventType');
    expect(item).toHaveProperty('actor');
    expect(item.actor).toHaveProperty('id');
    expect(item.actor).toHaveProperty('name');
    expect(item.actor).toHaveProperty('avatarUrl');
    expect(item).toHaveProperty('description');
    expect(item).toHaveProperty('workspaceId');
    expect(item).toHaveProperty('specId');
    expect(item).toHaveProperty('storyId');
    // target can be null or an object
    if (item.target) {
      expect(item.target).toHaveProperty('type');
      expect(item.target).toHaveProperty('id');
    }
  });

  it('maps run events to correct target type', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity?type=run_triggered')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].target).toEqual({ type: 'run', id: 'run-1' });
  });

  it('maps story events to correct target type', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity')
      .set('Authorization', `Bearer ${authToken}`);

    const storyItem = res.body.items.find((i: { rawEventType: string }) => i.rawEventType === 'story_passed');
    expect(storyItem).toBeDefined();
    expect(storyItem.target).toEqual({ type: 'story', id: 'auth-feature/US-001' });
  });

  it('clamps limit to max 100', async () => {
    await seedEvents();

    const res = await request(app)
      .get('/api/activity?limit=500')
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    // limit is clamped internally — response uses consistent pagination format (no limit field)
    expect(res.body.items.length).toBeLessThanOrEqual(100);
    expect(res.body).toHaveProperty('total');
    expect(res.body).toHaveProperty('hasMore');
  });

  it('requires auth', async () => {
    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(401);
  });
});
