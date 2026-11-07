-- 045_kanban_columns.sql — Custom kanban columns per workspace

CREATE TABLE IF NOT EXISTS kanban_columns (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'indigo',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kanban_columns_workspace ON kanban_columns(workspace_id, position);

-- Track which specs are assigned to custom columns
CREATE TABLE IF NOT EXISTS kanban_spec_assignments (
  id SERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  spec_id TEXT NOT NULL,
  column_id INTEGER NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (column_id) REFERENCES kanban_columns(id) ON DELETE CASCADE,
  UNIQUE(workspace_id, spec_id)
);
