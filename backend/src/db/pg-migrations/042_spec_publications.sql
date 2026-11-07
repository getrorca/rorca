-- 042_spec_publications.sql — Marketplace spec publications + full-text search

CREATE TABLE IF NOT EXISTS spec_publications (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  publisher_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags JSONB NOT NULL DEFAULT '[]',
  sanitized_spec_json JSONB NOT NULL,
  redaction_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'external')),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spec_publications_deleted ON spec_publications(deleted_at);
CREATE INDEX IF NOT EXISTS idx_spec_publications_download ON spec_publications(download_count DESC);
CREATE INDEX IF NOT EXISTS idx_spec_publications_publisher ON spec_publications(publisher_id);

-- FTS replacement: tsvector column + GIN index (replaces SQLite FTS5)
ALTER TABLE spec_publications ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_spec_publications_fts ON spec_publications USING GIN(search_vector);

-- Trigger function to auto-update tsvector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION spec_publications_search_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.tags::text, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_spec_publications_search ON spec_publications;
CREATE TRIGGER trg_spec_publications_search
  BEFORE INSERT OR UPDATE OF title, description, tags ON spec_publications
  FOR EACH ROW EXECUTE FUNCTION spec_publications_search_update();
