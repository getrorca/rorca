-- V2-042: Spec and story assignment tracking
-- Supports both spec-level (story_id = '') and story-level assignments
-- story_id = '' means spec-level assignment; non-empty means story-level
CREATE TABLE IF NOT EXISTS spec_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  story_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(spec_id, story_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_spec_assignments_assignee ON spec_assignments(assignee_id);
CREATE INDEX IF NOT EXISTS idx_spec_assignments_spec ON spec_assignments(spec_id, workspace_id);
