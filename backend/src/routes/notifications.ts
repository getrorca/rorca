/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

import { Router } from 'express';
import crypto from 'crypto';
import { query, queryOne, execute, transaction } from '../db/index';
import type { AuthUser } from '../lib/auth-utils';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';
import { NotFoundError, ValidationError } from '../lib/errors';

const router = Router();

const NOTIFICATION_TYPES = [
  'review_request',
  'spec_approved',
  'spec_rejected',
  'pipeline_completed',
  'budget_alert',
  'mention',
] as const;

type NotificationType = (typeof NOTIFICATION_TYPES)[number];

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

interface PreferenceRow {
  id: string;
  user_id: string;
  event_type: string;
  in_app: number;
  email: number;
}

/**
 * @swagger
 * /api/notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: List notifications
 *     operationId: listNotifications
 *     description: Returns a paginated list of notifications for the authenticated user. Supports filtering to show only unread notifications.
 *     parameters:
 *       - in: query
 *         name: unread
 *         schema: { type: string, enum: ['true', 'false'] }
 *         description: "Set to 'true' to return only unread notifications"
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *         description: Page number
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, maximum: 100 }
 *         description: Items per page (max 100, default 30)
 *     responses:
 *       200:
 *         description: Paginated notification list with unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       type: { type: string }
 *                       title: { type: string }
 *                       body: { type: string }
 *                       link: { type: string, nullable: true }
 *                       readAt: { type: string, format: date-time, nullable: true }
 *                       createdAt: { type: string, format: date-time }
 *                 total: { type: integer }
 *                 hasMore: { type: boolean }
 *                 cursor: { type: string, nullable: true }
 *                 unreadCount: { type: integer }
 */
router.get('/', async (req, res) => {
  const user = (req as any).user as AuthUser;
  const pagination = parsePaginationParams(req, { limit: 30, maxLimit: 100 });
  const unreadOnly = req.query.unread === 'true';

  const whereClause = unreadOnly
    ? 'WHERE user_id = $1 AND read_at IS NULL'
    : 'WHERE user_id = $1';

  const result = await paginateQuery<NotificationRow>({
    query: `SELECT * FROM notifications ${whereClause}`,
    countQuery: `SELECT COUNT(*)::int as total FROM notifications ${whereClause}`,
    params: [user.id],
    pagination,
    orderBy: 'created_at DESC',
    cursorColumn: 'id',
    cursorDirection: 'desc',
  });

  const unreadRow = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [user.id],
  );

  res.json({
    items: result.items.map(r => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      readAt: r.read_at,
      createdAt: r.created_at,
    })),
    total: result.total,
    hasMore: result.hasMore,
    cursor: result.cursor,
    unreadCount: unreadRow?.count ?? 0,
  });
});

/**
 * @swagger
 * /api/notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: Get unread notification count
 *     operationId: getUnreadNotificationCount
 *     description: Returns the count of unread notifications for the authenticated user. Designed as a lightweight endpoint for polling badge counts. Returns 0 when no user session is active.
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count: { type: integer }
 */
router.get('/unread-count', async (req, res) => {
  const user = (req as any).user as AuthUser | undefined;
  // Auth bypassed in local mode — return 0 when no user session
  if (!user?.id) { res.json({ count: 0 }); return; }
  const row = await queryOne<{ count: number }>(
    'SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [user.id],
  );
  res.json({ count: row?.count ?? 0 });
});

/**
 * @swagger
 * /api/notifications/{id}/read:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark notification as read
 *     operationId: markNotificationRead
 *     description: Marks a single notification as read by setting its read_at timestamp. No-ops if the notification is already read.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       404: { description: "Notification not found or already read" }
 */
router.post('/:id/read', async (req, res) => {
  const user = (req as any).user as AuthUser;
  const result = await execute(
    'UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
    [req.params.id, user.id],
  );
  if (result.rowCount === 0) {
    throw new NotFoundError('Notification not found or already read');
  }
  res.json({ ok: true });
});

/**
 * @swagger
 * /api/notifications/read-all:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark all notifications as read
 *     operationId: markAllNotificationsRead
 *     description: Marks all unread notifications for the authenticated user as read. Returns the number of notifications that were marked.
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 marked: { type: integer, description: "Number of notifications marked as read" }
 */
router.post('/read-all', async (req, res) => {
  const user = (req as any).user as AuthUser;
  const result = await execute(
    'UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
    [user.id],
  );
  res.json({ ok: true, marked: result.rowCount });
});

/**
 * @swagger
 * /api/notifications/{id}:
 *   delete:
 *     tags: [Notifications]
 *     summary: Delete a notification
 *     operationId: deleteNotification
 *     description: Permanently deletes a single notification. Only the notification owner can delete it.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       404: { description: "Notification not found" }
 */
router.delete('/:id', async (req, res) => {
  const user = (req as any).user as AuthUser;
  const result = await execute(
    'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
    [req.params.id, user.id],
  );
  if (result.rowCount === 0) {
    throw new NotFoundError('Notification not found');
  }
  res.json({ ok: true });
});

// ─── Notification Preferences ───

/**
 * @swagger
 * /api/notifications/preferences:
 *   get:
 *     tags: [Notifications]
 *     summary: Get notification preferences
 *     operationId: getNotificationPreferences
 *     description: Returns the authenticated user's notification preferences for each event type. Missing event types default to both in-app and email enabled.
 *     responses:
 *       200:
 *         description: Notification preferences map
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 preferences:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       inApp: { type: boolean }
 *                       email: { type: boolean }
 */
router.get('/preferences', async (req, res) => {
  const user = (req as any).user as AuthUser;
  const rows = await query<PreferenceRow>(
    'SELECT * FROM notification_preferences WHERE user_id = $1',
    [user.id],
  );

  // Build full map with defaults for any missing event types
  const prefsMap: Record<string, { inApp: boolean; email: boolean }> = {};
  for (const t of NOTIFICATION_TYPES) {
    prefsMap[t] = { inApp: true, email: true }; // defaults
  }
  for (const row of rows) {
    prefsMap[row.event_type] = { inApp: !!row.in_app, email: !!row.email };
  }

  res.json({ preferences: prefsMap });
});

/**
 * @swagger
 * /api/notifications/preferences:
 *   put:
 *     tags: [Notifications]
 *     summary: Update notification preferences
 *     operationId: updateNotificationPreferences
 *     description: Creates or updates the authenticated user's notification preferences. Each event type can independently toggle in-app and email delivery. Unknown event types are silently ignored.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [preferences]
 *             properties:
 *               preferences:
 *                 type: object
 *                 description: "Map of event type to preference settings"
 *                 additionalProperties:
 *                   type: object
 *                   properties:
 *                     inApp: { type: boolean }
 *                     email: { type: boolean }
 *     responses:
 *       200:
 *         description: Preferences updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       400: { description: "preferences object required" }
 */
router.put('/preferences', async (req, res) => {
  const user = (req as any).user as AuthUser;
  const { preferences } = req.body as {
    preferences: Record<string, { inApp: boolean; email: boolean }>;
  };

  if (!preferences || typeof preferences !== 'object') {
    throw new ValidationError('preferences object required');
  }

  await transaction(async (client) => {
    for (const [eventType, pref] of Object.entries(preferences)) {
      if (!NOTIFICATION_TYPES.includes(eventType as NotificationType)) continue;
      await client.query(
        `INSERT INTO notification_preferences (id, user_id, event_type, in_app, email)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(user_id, event_type) DO UPDATE SET in_app = excluded.in_app, email = excluded.email`,
        [
          crypto.randomUUID(),
          user.id,
          eventType,
          pref.inApp ? 1 : 0,
          pref.email ? 1 : 0,
        ],
      );
    }
  });

  res.json({ ok: true });
});

// ─── Helper: create notification (used by WAL subscriber) ───

export async function createNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  link?: string,
): Promise<string> {
  // Check user preferences — skip if in_app disabled
  const pref = await queryOne<{ in_app: number }>(
    'SELECT in_app FROM notification_preferences WHERE user_id = $1 AND event_type = $2',
    [userId, type],
  );

  if (pref && !pref.in_app) return ''; // user opted out of in-app for this type

  const id = crypto.randomUUID();
  await execute(
    'INSERT INTO notifications (id, user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, userId, type, title, body, link ?? null],
  );
  return id;
}

export default router;
