-- 018_story_comments.sql — Per-story review comments with resolution tracking

CREATE TABLE IF NOT EXISTS story_comments (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  story_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_name TEXT,
  review_persona TEXT,
  review_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_story_comments_spec_story
  ON story_comments(spec_id, story_id);
