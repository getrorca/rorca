import { Router } from 'express';
import crypto from 'crypto';
import { db } from '../db/index';
import type { AuthUser } from './auth';
import { parsePaginationParams, paginateQuery } from '../lib/paginate';

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

// GET /api/notifications — list current user's notifications
router.get('/', (req, res) => {
  const user = (req as any).user as AuthUser;
  const pagination = parsePaginationParams(req, { limit: 30, maxLimit: 100 });
  const unreadOnly = req.query.unread === 'true';

  const whereClause = unreadOnly
    ? 'WHERE user_id = ? AND read_at IS NULL'
    : 'WHERE user_id = ?';

  const result = paginateQuery<NotificationRow>(db, {
    query: `SELECT * FROM notifications ${whereClause}`,
    countQuery: `SELECT COUNT(*) as total FROM notifications ${whereClause}`,
    params: [user.id],
    pagination,
    orderBy: 'created_at DESC',
    cursorColumn: 'id',
    cursorDirection: 'desc',
  });

  const unreadRow = db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read_at IS NULL'
  ).get(user.id) as { count: number };

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
    unreadCount: unreadRow.count,
  });
});

// GET /api/notifications/unread-count — lightweight poll for badge
router.get('/unread-count', (req, res) => {
  const user = (req as any).user as AuthUser | undefined;
  // Auth bypassed in local mode — return 0 when no user session
  if (!user?.id) { res.json({ count: 0 }); return; }
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read_at IS NULL'
  ).get(user.id) as { count: number };
  res.json({ count: row.count });
});

// POST /api/notifications/:id/read — mark single notification as read
router.post('/:id/read', (req, res) => {
  const user = (req as any).user as AuthUser;
  const result = db.prepare(
    "UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL"
  ).run(req.params.id, user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Notification not found or already read' });
  }
  res.json({ ok: true });
});

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', (req, res) => {
  const user = (req as any).user as AuthUser;
  const result = db.prepare(
    "UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL"
  ).run(user.id);
  res.json({ ok: true, marked: result.changes });
});

// DELETE /api/notifications/:id — delete a single notification
router.delete('/:id', (req, res) => {
  const user = (req as any).user as AuthUser;
  const result = db.prepare(
    'DELETE FROM notifications WHERE id = ? AND user_id = ?'
  ).run(req.params.id, user.id);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  res.json({ ok: true });
});

// ─── Notification Preferences ───

// GET /api/notifications/preferences — get user's preferences
router.get('/preferences', (req, res) => {
  const user = (req as any).user as AuthUser;
  const rows = db.prepare(
    'SELECT * FROM notification_preferences WHERE user_id = ?'
  ).all(user.id) as PreferenceRow[];

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

// PUT /api/notifications/preferences — upsert user's preferences
router.put('/preferences', (req, res) => {
  const user = (req as any).user as AuthUser;
  const { preferences } = req.body as {
    preferences: Record<string, { inApp: boolean; email: boolean }>;
  };

  if (!preferences || typeof preferences !== 'object') {
    return res.status(400).json({ error: 'preferences object required' });
  }

  const upsert = db.prepare(`
    INSERT INTO notification_preferences (id, user_id, event_type, in_app, email)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, event_type) DO UPDATE SET in_app = excluded.in_app, email = excluded.email
  `);

  const runAll = db.transaction(() => {
    for (const [eventType, pref] of Object.entries(preferences)) {
      if (!NOTIFICATION_TYPES.includes(eventType as NotificationType)) continue;
      upsert.run(
        crypto.randomUUID(),
        user.id,
        eventType,
        pref.inApp ? 1 : 0,
        pref.email ? 1 : 0,
      );
    }
  });

  runAll();
  res.json({ ok: true });
});

// ─── Helper: create notification (used by WAL subscriber) ───

export function createNotification(
  userId: string,
  type: NotificationType,
  title: string,
  body: string,
  link?: string,
): string {
  // Check user preferences — skip if in_app disabled
  const pref = db.prepare(
    'SELECT in_app FROM notification_preferences WHERE user_id = ? AND event_type = ?'
  ).get(userId, type) as { in_app: number } | undefined;

  if (pref && !pref.in_app) return ''; // user opted out of in-app for this type

  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO notifications (id, user_id, type, title, body, link) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, userId, type, title, body, link ?? null);
  return id;
}

export default router;
