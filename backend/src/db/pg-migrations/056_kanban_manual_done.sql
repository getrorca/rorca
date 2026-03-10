-- Track specs manually moved to "Done" column on kanban board
CREATE TABLE IF NOT EXISTS kanban_manual_done (
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (spec_id, workspace_id)
);
