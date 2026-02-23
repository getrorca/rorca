-- V2-040: Team-scoped direction layers (L1/L2)
-- Adds team_id to direction_layers so L1/L2 can be shared across all team workspaces

-- Step 1: Recreate direction_layers with team_id and updated unique index
-- (SQLite can't alter unique indexes, so we rebuild the table)

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS direction_layers_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT,
  domain TEXT,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  layer INTEGER NOT NULL CHECK(layer IN (1,2,3)),
  content_yaml TEXT NOT NULL DEFAULT '',
  preferred_model TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unique index includes team_id: global (all null) vs team-scoped vs workspace-scoped
CREATE UNIQUE INDEX IF NOT EXISTS idx_direction_layers_new_unique
  ON direction_layers_new(layer, COALESCE(workspace_id,''), COALESCE(domain,''), COALESCE(team_id,''));

-- Copy existing data (team_id will be NULL for all existing rows)
-- Note: preferred_model may not exist on old table (added idempotently in db/index.ts),
-- so we only copy base columns. preferred_model will remain NULL on migrated rows.
INSERT OR IGNORE INTO direction_layers_new (id, workspace_id, domain, layer, content_yaml, updated_at)
  SELECT id, workspace_id, domain, layer, content_yaml, updated_at
  FROM direction_layers;

DROP TABLE IF EXISTS direction_layers;
ALTER TABLE direction_layers_new RENAME TO direction_layers;

PRAGMA foreign_keys = ON;
