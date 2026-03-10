-- 044_spec_search_index.sql — Full-text search for spec archive
-- Replaces SQLite FTS5 spec_search_index virtual table with tsvector + GIN

CREATE TABLE IF NOT EXISTS spec_search_index (
  id SERIAL PRIMARY KEY,
  spec_slug TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  spec_title TEXT,
  story_titles TEXT,
  story_descriptions TEXT,
  acceptance_criteria TEXT,
  status TEXT,
  generated_at TIMESTAMPTZ,
  search_vector tsvector
);

CREATE INDEX IF NOT EXISTS idx_spec_search_fts ON spec_search_index USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_spec_search_slug ON spec_search_index(spec_slug);
CREATE INDEX IF NOT EXISTS idx_spec_search_workspace ON spec_search_index(workspace_id);

-- Auto-update tsvector on INSERT/UPDATE
CREATE OR REPLACE FUNCTION spec_search_index_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(NEW.spec_title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(NEW.story_titles, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(NEW.story_descriptions, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(NEW.acceptance_criteria, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_spec_search_index ON spec_search_index;
CREATE TRIGGER trg_spec_search_index
  BEFORE INSERT OR UPDATE OF spec_title, story_titles, story_descriptions, acceptance_criteria ON spec_search_index
  FOR EACH ROW EXECUTE FUNCTION spec_search_index_update();
