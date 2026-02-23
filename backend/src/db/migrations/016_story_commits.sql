-- V2-029: Story commits traceability — link commits to stories via push webhooks
CREATE TABLE IF NOT EXISTS story_commits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  commit_sha TEXT NOT NULL,
  commit_message TEXT NOT NULL,
  author TEXT NOT NULL,
  pushed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(story_id, spec_id, commit_sha)
);

CREATE INDEX IF NOT EXISTS idx_story_commits_story ON story_commits(spec_id, story_id);
CREATE INDEX IF NOT EXISTS idx_story_commits_sha ON story_commits(commit_sha);
