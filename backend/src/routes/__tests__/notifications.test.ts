/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import crypto from 'crypto';
import { once } from 'events';
import type { Server } from 'http';
import type { Express } from 'express';
import request from 'supertest';
import { createNotification } from '../notifications';
import { execute } from '../../db/index';
import { ensureTestUser, getAuthToken } from './helpers/auth-helper';

let server: Server;
let authToken: string;
let user: { id: string; email: string };
const otherUserIds = new Set<string>();
const fixtureId = crypto.randomUUID();
const fixtureEmail = `notifications-${fixtureId}@test.rorca.local`;

async function createOtherUser() {
  const id = crypto.randomUUID();
  const email = `notifications-other-${id}@test.rorca.local`;
  await execute(
    `INSERT INTO users (id, email, display_name, role, plan)
     VALUES ($1, $2, $3, 'user', 'free')`,
    [id, email, 'Notification Isolation User'],
  );
  otherUserIds.add(id);
  return { id, email };
}

async function cleanFixtureState(): Promise<void> {
  await execute('DELETE FROM notification_preferences WHERE user_id = $1', [user.id]);
  await execute('DELETE FROM notifications WHERE user_id = $1', [user.id]);
  for (const id of otherUserIds) {
    await execute('DELETE FROM users WHERE id = $1', [id]);
  }
  otherUserIds.clear();
}

function api() {
  return request(server);
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const authId = crypto.randomUUID();
  user = await ensureTestUser({
    email: fixtureEmail,
    authId,
    role: 'admin',
    plan: 'pro',
  });
  const serverModule = require('../../server');
  const expressApp = serverModule.default as Express;
  authToken = await getAuthToken(expressApp, {
    email: fixtureEmail,
    authId,
    role: 'admin',
    displayName: 'Notification Test Admin',
  });
  server = expressApp.listen(0, '127.0.0.1');
  await once(server, 'listening');
});

beforeEach(cleanFixtureState);
afterEach(cleanFixtureState);

afterAll(async () => {
  await cleanFixtureState();
  await execute('DELETE FROM users WHERE id = $1', [user.id]);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
  delete process.env.NODE_ENV;
});

describe('GET /api/notifications', () => {
  it('returns empty list for user with no notifications', async () => {
    const res = await api()
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it('returns notifications for the authenticated user', async () => {
    await createNotification(user.id, 'spec_approved', 'Spec approved', 'Your spec was approved', '/specs/test');

    const res = await api()
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Spec approved');
    expect(res.body.unreadCount).toBe(1);
  });

  it('does not return notifications for other users', async () => {
    const otherUser = await createOtherUser();
    await createNotification(otherUser.id, 'spec_approved', 'For another user', 'body');

    const res = await api()
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns correct unread count', async () => {
    await createNotification(user.id, 'spec_approved', 'N1', 'b1');
    await createNotification(user.id, 'pipeline_completed', 'N2', 'b2');

    const res = await api()
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks a notification as read', async () => {
    const notificationId = await createNotification(user.id, 'mention', 'Mentioned', 'You were mentioned');

    const res = await api()
      .post(`/api/notifications/${notificationId}/read`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);

    const countRes = await api()
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${authToken}`);
    expect(countRes.body.count).toBe(0);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks all notifications as read', async () => {
    await createNotification(user.id, 'spec_approved', 'N1', 'b1');
    await createNotification(user.id, 'spec_rejected', 'N2', 'b2');
    await createNotification(user.id, 'pipeline_completed', 'N3', 'b3');

    const res = await api()
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(3);

    const countRes = await api()
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${authToken}`);
    expect(countRes.body.count).toBe(0);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('deletes a notification', async () => {
    const notificationId = await createNotification(user.id, 'mention', 'Mentioned', 'body');

    const res = await api()
      .delete(`/api/notifications/${notificationId}`)
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);

    const listRes = await api()
      .get('/api/notifications')
      .set('Authorization', `Bearer ${authToken}`);
    expect(listRes.body.items).toHaveLength(0);
  });
});

describe('Notification preferences', () => {
  it('returns default preferences (all enabled)', async () => {
    const res = await api()
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${authToken}`);
    expect(res.status).toBe(200);
    expect(res.body.preferences.spec_approved).toEqual({ inApp: true, email: true });
    expect(res.body.preferences.mention).toEqual({ inApp: true, email: true });
  });

  it('saves and retrieves user preferences', async () => {
    const putRes = await api()
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        preferences: {
          spec_approved: { inApp: true, email: false },
          mention: { inApp: false, email: true },
        },
      });
    expect(putRes.status).toBe(200);

    const getRes = await api()
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${authToken}`);
    expect(getRes.body.preferences.spec_approved).toEqual({ inApp: true, email: false });
    expect(getRes.body.preferences.mention).toEqual({ inApp: false, email: true });
  });

  it('respects in_app=false preference when creating notifications', async () => {
    const putRes = await api()
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${authToken}`)
      .send({
        preferences: { spec_approved: { inApp: false, email: true } },
      });
    expect(putRes.status).toBe(200);

    const notificationId = await createNotification(user.id, 'spec_approved', 'Should not appear', 'body');
    expect(notificationId).toBe('');

    const countRes = await api()
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${authToken}`);
    expect(countRes.body.count).toBe(0);
  });
});
