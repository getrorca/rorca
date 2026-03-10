-- 043_plan_quotas.sql — Plan-based feature gating

CREATE TABLE IF NOT EXISTS plan_quotas (
  id SERIAL PRIMARY KEY,
  plan_name TEXT NOT NULL,
  feature TEXT NOT NULL,
  quota_limit INTEGER NOT NULL DEFAULT -1,
  UNIQUE(plan_name, feature)
);

-- Free plan: limited
INSERT INTO plan_quotas (plan_name, feature, quota_limit) VALUES
  ('free', 'specs_per_month', 5),
  ('free', 'workspaces', 1),
  ('free', 'marketplace_publish', 0),
  ('free', 'exa_search', 0),
  ('free', 'team_members', 1)
ON CONFLICT (plan_name, feature) DO NOTHING;

-- Solo plan: moderate
INSERT INTO plan_quotas (plan_name, feature, quota_limit) VALUES
  ('solo', 'specs_per_month', -1),
  ('solo', 'workspaces', 3),
  ('solo', 'marketplace_publish', -1),
  ('solo', 'exa_search', -1),
  ('solo', 'team_members', 1)
ON CONFLICT (plan_name, feature) DO NOTHING;

-- Pro plan: generous
INSERT INTO plan_quotas (plan_name, feature, quota_limit) VALUES
  ('pro', 'specs_per_month', -1),
  ('pro', 'workspaces', -1),
  ('pro', 'marketplace_publish', -1),
  ('pro', 'exa_search', -1),
  ('pro', 'team_members', 5)
ON CONFLICT (plan_name, feature) DO NOTHING;

-- Team plan: unlimited
INSERT INTO plan_quotas (plan_name, feature, quota_limit) VALUES
  ('team', 'specs_per_month', -1),
  ('team', 'workspaces', -1),
  ('team', 'marketplace_publish', -1),
  ('team', 'exa_search', -1),
  ('team', 'team_members', -1)
ON CONFLICT (plan_name, feature) DO NOTHING;

-- Spec research cache (was duplicate 043 in SQLite)
CREATE TABLE IF NOT EXISTS spec_research_cache (
  spec_id TEXT NOT NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  results_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (spec_id, query, provider)
);

CREATE INDEX IF NOT EXISTS idx_spec_research_cache_spec_id ON spec_research_cache(spec_id);
