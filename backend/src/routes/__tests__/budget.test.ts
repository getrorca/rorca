/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import type { Server } from 'http';
import * as os from 'os';
import * as path from 'path';
import type { Express } from 'express';
import request from 'supertest';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';
import { queryOne, execute } from '../../db/index';

let server: Server;
let tmpDir: string;
let authToken: string;
let userId: string;

const fixtureId = crypto.randomUUID();
const workspaceId = `budget-${fixtureId}`;
const fixtureEmail = `budget-${fixtureId}@test.rorca.local`;

function api() {
  return request(server);
}

async function cleanFixtureState(): Promise<void> {
  await execute('DELETE FROM budget_config WHERE workspace_id = $1', [workspaceId]);
  await execute('DELETE FROM token_usage WHERE workspace_id = $1', [workspaceId]);
  await execute(
    `DELETE FROM wal_events
     WHERE workspace_id = $1
       AND event_type IN ('budget_alert', 'budget_config_updated', 'budget_config_deleted')`,
    [workspaceId],
  );
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rorca-budget-test-'));

  const authId = crypto.randomUUID();
  const user = await ensureTestUser({
    email: fixtureEmail,
    authId,
    role: 'admin',
    plan: 'pro',
  });
  userId = user.id;

  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: fixtureEmail,
    authId,
    role: 'admin',
    displayName: 'Budget Test Admin',
  });
  await execute(
    `INSERT INTO workspaces (id, label, path) VALUES ($1, $2, $3)`,
    [workspaceId, 'Budget Test Workspace', tmpDir],
  );

  server = expressApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(cleanFixtureState);
afterEach(cleanFixtureState);

afterAll(async () => {
  await cleanFixtureState();
  await execute('DELETE FROM workspaces WHERE id = $1', [workspaceId]);
  await execute('DELETE FROM users WHERE id = $1', [userId]);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.NODE_ENV;
});

describe('GET /api/workspaces/:id/budget', () => {
  it('returns null config when no budget is set', async () => {
    const res = await api()
      .get(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.config).toBeNull();
    expect(res.body.spending_usd).toBe(0);
    expect(res.body.remaining_usd).toBeNull();
    expect(res.body.alert_triggered).toBe(false);
    expect(res.body.cap_exceeded).toBe(false);
  });

  it('returns driver-decoded JSONB config and spending status', async () => {
    await execute(
      `INSERT INTO budget_config
         (workspace_id, alert_threshold_usd, hard_cap_usd, period, notify_emails)
       VALUES ($1, 10, 50, 'monthly', $2::jsonb)`,
      [workspaceId, JSON.stringify(['admin@example.com'])],
    );

    const res = await api()
      .get(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.config).not.toBeNull();
    expect(res.body.config.period).toBe('monthly');
    expect(res.body.config.alert_threshold_usd).toBe(10);
    expect(res.body.config.hard_cap_usd).toBe(50);
    expect(res.body.config.notify_emails).toEqual(['admin@example.com']);
    expect(res.body.spending_usd).toBe(0);
    expect(res.body.remaining_usd).toBe(50);
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await api()
      .get(`/api/workspaces/missing-${fixtureId}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
  });
});

describe('POST /api/workspaces/:id/budget', () => {
  it('creates a new budget config', async () => {
    const res = await api()
      .post(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        alert_threshold_usd: 10,
        hard_cap_usd: 50,
        period: 'monthly',
        notify_emails: ['admin@example.com'],
      });

    expect(res.status).toBe(200);
    expect(res.body.config.alert_threshold_usd).toBe(10);
    expect(res.body.config.hard_cap_usd).toBe(50);
    expect(res.body.config.period).toBe('monthly');
    expect(res.body.config.notify_emails).toEqual(['admin@example.com']);
    expect(res.body.alert_triggered).toBe(false);
    expect(res.body.cap_exceeded).toBe(false);
  });

  it('upserts existing budget config', async () => {
    await execute(
      `INSERT INTO budget_config
         (workspace_id, alert_threshold_usd, hard_cap_usd, period, notify_emails)
       VALUES ($1, 5, 20, 'daily', $2::jsonb)`,
      [workspaceId, JSON.stringify([])],
    );

    const res = await api()
      .post(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ alert_threshold_usd: 25, hard_cap_usd: 100, period: 'weekly' });

    expect(res.status).toBe(200);
    expect(res.body.config.alert_threshold_usd).toBe(25);
    expect(res.body.config.hard_cap_usd).toBe(100);
    expect(res.body.config.period).toBe('weekly');

    const count = await queryOne<{ c: string }>(
      'SELECT COUNT(*) AS c FROM budget_config WHERE workspace_id = $1',
      [workspaceId],
    );
    expect(Number(count?.c)).toBe(1);
  });

  it('returns 400 for invalid period', async () => {
    const res = await api()
      .post(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ period: 'yearly' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/period must be one of/i);
  });

  it('returns 400 when alert_threshold >= hard_cap', async () => {
    const res = await api()
      .post(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ alert_threshold_usd: 100, hard_cap_usd: 50 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/alert_threshold_usd must be less than hard_cap_usd/i);
  });

  it('returns 400 for negative threshold', async () => {
    const res = await api()
      .post(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ alert_threshold_usd: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be negative/i);
  });

  it('rejects non-array notify emails without persisting config', async () => {
    const res = await api()
      .post(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ notify_emails: 'admin@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notify_emails must be an array of strings/i);
    expect(await queryOne('SELECT id FROM budget_config WHERE workspace_id = $1', [workspaceId]))
      .toBeUndefined();
  });

  it('returns 404 for nonexistent workspace', async () => {
    const res = await api()
      .post(`/api/workspaces/missing-${fixtureId}/budget`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ period: 'monthly' });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/workspaces/:id/budget', () => {
  it('deletes an existing budget config', async () => {
    await execute(
      `INSERT INTO budget_config (workspace_id, period, notify_emails)
       VALUES ($1, 'monthly', $2::jsonb)`,
      [workspaceId, JSON.stringify([])],
    );

    const res = await api()
      .delete(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const gone = await queryOne('SELECT id FROM budget_config WHERE workspace_id = $1', [workspaceId]);
    expect(gone).toBeUndefined();
  });

  it('returns 404 when no budget config exists', async () => {
    const res = await api()
      .delete(`/api/workspaces/${workspaceId}/budget`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no budget config found/i);
  });
});
