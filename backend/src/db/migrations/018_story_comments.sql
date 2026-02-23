-- 018_story_comments.sql
-- Per-story review comments with Markdown body and resolution tracking

CREATE TABLE IF NOT EXISTS story_comments (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_story_comments_spec_story
  ON story_comments(spec_id, story_id);
