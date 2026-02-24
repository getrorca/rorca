-- V2-073: Notifications system
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,          -- review_request, spec_approved, spec_rejected, pipeline_completed, budget_alert, mention
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,                   -- in-app route to navigate to (e.g. /specs/slug)
  read_at TEXT,                -- null = unread, datetime = read
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);

-- Per-user, per-event-type notification preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,    -- review_request, spec_approved, spec_rejected, pipeline_completed, budget_alert, mention
  in_app INTEGER NOT NULL DEFAULT 1,   -- 1 = enabled, 0 = disabled
  email INTEGER NOT NULL DEFAULT 1,    -- 1 = enabled, 0 = disabled
  UNIQUE(user_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user ON notification_preferences(user_id);
