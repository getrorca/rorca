-- PR-042: Spec research cache for marketplace queries
CREATE TABLE IF NOT EXISTS spec_research_cache (
  spec_id TEXT NOT NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  results_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (spec_id, query, provider)
);

CREATE INDEX IF NOT EXISTS idx_spec_research_cache_spec_id ON spec_research_cache(spec_id);
