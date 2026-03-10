-- 010_spec_tags.sql — Spec tags for organizing and filtering

CREATE TABLE IF NOT EXISTS spec_tags (
  id SERIAL PRIMARY KEY,
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(spec_id, tag_name, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_spec_tags_spec ON spec_tags(spec_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_spec_tags_tag ON spec_tags(tag_name, workspace_id);
