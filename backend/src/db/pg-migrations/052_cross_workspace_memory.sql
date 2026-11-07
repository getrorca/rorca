-- PR-021: Cross-workspace memory sharing
-- Tracks accepted and dismissed cross-workspace memory suggestions

CREATE TABLE IF NOT EXISTS cross_workspace_memory (
  id            SERIAL PRIMARY KEY,
  target_workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  source_workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  source_date           TEXT NOT NULL,            -- YYYY-MM-DD from source entry
  source_title          TEXT NOT NULL,            -- title from source entry
  source_category       TEXT NOT NULL,
  source_rule           TEXT NOT NULL,
  source_context        TEXT NOT NULL DEFAULT '',
  source_source         TEXT NOT NULL DEFAULT '', -- source story ID
  status                TEXT NOT NULL DEFAULT 'suggested'
                        CHECK (status IN ('suggested', 'accepted', 'dismissed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at           TIMESTAMPTZ,
  UNIQUE (target_workspace_id, source_workspace_id, source_date, source_title)
);

CREATE INDEX IF NOT EXISTS idx_cross_ws_memory_target
  ON cross_workspace_memory (target_workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_cross_ws_memory_source
  ON cross_workspace_memory (source_workspace_id);
