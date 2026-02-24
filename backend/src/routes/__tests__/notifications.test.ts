import request from 'supertest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import app from '../../server';
import { db } from '../../db';
import { JWT_SECRET } from '../auth';
import { createNotification } from '../notifications';

function createUser(overrides: { email?: string } = {}) {
  const id = crypto.randomUUID();
  const email = overrides.email || `user-${id.slice(0, 8)}@test.com`;
  const passwordHash = bcrypt.hashSync('password123', 4);
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)'
  ).run(id, email, 'Test User', passwordHash);
  return { id, email };
}

function tokenFor(user: { id: string; email: string }): string {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '15m' });
}

afterEach(() => {
  db.prepare('DELETE FROM notification_preferences').run();
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM users').run();
});

describe('GET /api/notifications', () => {
  it('returns empty list for user with no notifications', async () => {
    const user = createUser();
    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
    expect(res.body.unreadCount).toBe(0);
  });

  it('returns notifications for the authenticated user', async () => {
    const user = createUser();
    createNotification(user.id, 'spec_approved', 'Spec approved', 'Your spec was approved', '/specs/test');

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].title).toBe('Spec approved');
    expect(res.body.unreadCount).toBe(1);
  });

  it('does not return notifications for other users', async () => {
    const user1 = createUser();
    const user2 = createUser();
    createNotification(user1.id, 'spec_approved', 'For user 1', 'body');

    const res = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(user2)}`);
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(0);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns correct unread count', async () => {
    const user = createUser();
    createNotification(user.id, 'spec_approved', 'N1', 'b1');
    createNotification(user.id, 'pipeline_completed', 'N2', 'b2');

    const res = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks a notification as read', async () => {
    const user = createUser();
    const nId = createNotification(user.id, 'mention', 'Mentioned', 'You were mentioned');

    const res = await request(app)
      .post(`/api/notifications/${nId}/read`)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);

    const countRes = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(countRes.body.count).toBe(0);
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks all notifications as read', async () => {
    const user = createUser();
    createNotification(user.id, 'spec_approved', 'N1', 'b1');
    createNotification(user.id, 'spec_rejected', 'N2', 'b2');
    createNotification(user.id, 'pipeline_completed', 'N3', 'b3');

    const res = await request(app)
      .post('/api/notifications/read-all')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
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
    const user = createUser();
    const nId = createNotification(user.id, 'mention', 'Mentioned', 'body');

    const res = await request(app)
      .delete(`/api/notifications/${nId}`)
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);

    const listRes = await request(app)
      .get('/api/notifications')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(listRes.body.notifications).toHaveLength(0);
  });
});

describe('Notification preferences', () => {
  it('returns default preferences (all enabled)', async () => {
    const user = createUser();
    const res = await request(app)
      .get('/api/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(res.status).toBe(200);
    expect(res.body.preferences.spec_approved).toEqual({ inApp: true, email: true });
    expect(res.body.preferences.mention).toEqual({ inApp: true, email: true });
  });

  it('saves and retrieves user preferences', async () => {
    const user = createUser();
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
    const user = createUser();
    // Disable in-app for spec_approved
    await request(app)
      .put('/api/notifications/preferences')
      .set('Authorization', `Bearer ${tokenFor(user)}`)
      .send({
        preferences: { spec_approved: { inApp: false, email: true } },
      });

    // Try to create notification — should be skipped
    const nId = createNotification(user.id, 'spec_approved', 'Should not appear', 'body');
    expect(nId).toBe('');

    const countRes = await request(app)
      .get('/api/notifications/unread-count')
      .set('Authorization', `Bearer ${tokenFor(user)}`);
    expect(countRes.body.count).toBe(0);
  });
});
