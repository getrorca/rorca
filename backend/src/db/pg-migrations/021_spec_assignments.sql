-- 021_spec_assignments.sql — Spec and story assignment tracking

CREATE TABLE IF NOT EXISTS spec_assignments (
  id SERIAL PRIMARY KEY,
  spec_id TEXT NOT NULL,
  story_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(spec_id, story_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_spec_assignments_assignee ON spec_assignments(assignee_id);
CREATE INDEX IF NOT EXISTS idx_spec_assignments_spec ON spec_assignments(spec_id, workspace_id);
