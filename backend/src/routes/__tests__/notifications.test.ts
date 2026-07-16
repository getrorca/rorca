/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import request from 'supertest';
import crypto from 'crypto';
import app from '../../server';
import { createNotification } from '../notifications';
import { execute } from '../../db/index';

async function createUser(overrides: { email?: string } = {}) {
  const id = crypto.randomUUID();
  const email = overrides.email || `user-${id.slice(0, 8)}@test.com`;
  await execute(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3)`, [id, email, 'Test User']);
  return { id, email };
}

afterEach(async () => {
  await execute(`DELETE FROM notification_preferences`);
  await execute(`DELETE FROM notifications`);
  await execute(`DELETE FROM users`);
});

describe('GET /api/notifications', () => {
  it('returns empty list for user with no notifications', async () => {
    const user = await createUser();
    const res = await request(app)
      .get('/api/notifications')
      .set('x-test-user-id', user.id)
      .set('x-test-user-email', user.email)
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it('returns notifications for the authenticated user', async () => {
    const user = await createUser();
    await createNotification(user.id, 'spec_approved', 'Spec approved', 'Your spec was approved', '/specs/test');

    const res = await request(app)
      .get('/api/notifications')
      .set('x-test-user-id', user.id)
      .set('x-test-user-email', user.email)
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].title).toBe('Spec approved');
    expect(res.body.unreadCount).toBe(1);
  });

  it('does not return notifications for other users', async () => {
    const user1 = await createUser();
    const user2 = await createUser();
    await createNotification(user1.id, 'spec_approved', 'For user 1', 'body');

    const res = await request(app)
      .get('/api/notifications')
      .set('x-test-user-id', user2.id)
      .set('x-test-user-email', user2.email)
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns correct unread count', async () => {
    const user = await createUser();
    await createNotification(user.id, 'spec_approved', 'N1', 'b1');
    await createNotification(user.id, 'pipeline_completed', 'N2', 'b2');

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('x-test-user-id', user.id)
      .set('x-test-user-email', user.email)
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks a notification as read', async () => {
    const user = await createUser();
    const nId = await createNotification(user.id, 'mention', 'Mentioned', 'You were mentioned');

    const res = await request(app)
      .post(`/api/notifications/${nId}/read`)
      .set('x-test-user-id', user.id)
      .set('x-test-user-email', user.email)
    expect(res.status).toBe(200);

    const countRes = await request(app)
      .get('/api/notifications/unread-count')
      .set('x-test-user-id', user.id)
      .set('x-test-user-email', user.email)
    expect(countRes.body.count).toBe(0);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks all notifications as read', async () => {
    const user = await createUser();
    await createNotification(user.id, 'spec_approved', 'N1', 'b1');
    await createNotification(user.id, 'spec_rejected', 'N2', 'b2');
    await createNotification(user.id, 'pipeline_completed', 'N3', 'b3');

    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('x-test-user-id', user.id)
      .set('x-test-user-email', user.email)
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(3);

    const countRes = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(countRes.body.count).toBe(0);
  });
});

describe('DELETE /api/notifications/:id', () => {
  it('deletes a notification', async () => {
    const user = await createUser();
    const nId = await createNotification(user.id, 'mention', 'Mentioned', 'body');

    const res = await request(app)
      .delete(`/api/notifications/${nId}`)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);

    const listRes = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(listRes.body.items).toHaveLength(0);
  });
});

describe('Notification preferences', () => {
  it('returns default preferences (all enabled)', async () => {
    const user = await createUser();
    const res = await request(app)
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.preferences.spec_approved).toEqual({ inApp: true, email: true });
    expect(res.body.preferences.mention).toEqual({ inApp: true, email: true });
  });

  it('saves and retrieves user preferences', async () => {
    const user = await createUser();
    const putRes = await request(app)
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({
        preferences: {
          spec_approved: { inApp: true, email: false },
          mention: { inApp: false, email: true },
        },
      });
    expect(putRes.status).toBe(200);

    const getRes = await request(app)
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(getRes.body.preferences.spec_approved).toEqual({ inApp: true, email: false });
    expect(getRes.body.preferences.mention).toEqual({ inApp: false, email: true });
  });

  it('respects in_app=false preference when creating notifications', async () => {
    const user = await createUser();
    // Disable in-app for spec_approved
    await request(app)
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({
        preferences: { spec_approved: { inApp: false, email: true } },
      });

    // Try to create notification — should be skipped
    const nId = await createNotification(user.id, 'spec_approved', 'Should not appear', 'body');
    expect(nId).toBe('');

    const countRes = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(countRes.body.count).toBe(0);
  });
});
