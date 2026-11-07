-- 003_spec_versions.sql — Versioned spec snapshots

CREATE TABLE IF NOT EXISTS spec_versions (
  id SERIAL PRIMARY KEY,
  spec_slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','completed')),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(spec_slug, version)
);
