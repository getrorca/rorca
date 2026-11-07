-- 027_rate_limits.sql — Rate limit configuration

CREATE TABLE IF NOT EXISTS rate_limits (
  id SERIAL PRIMARY KEY,
  endpoint_pattern TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'default',
  max_requests INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(endpoint_pattern, tier)
);

-- Seed default limits
INSERT INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES
  ('*', 'authenticated', 100, 60),
  ('*', 'unauthenticated', 20, 60),
  ('POST /api/specs/generate', 'authenticated', 10, 60),
  ('POST /api/specs/generate', 'unauthenticated', 3, 60),
  ('POST /api/specs/:id/add-stories', 'authenticated', 10, 60),
  ('POST /api/specs/:id/add-stories', 'unauthenticated', 3, 60),
  ('POST /api/pipeline/trigger', 'authenticated', 10, 60),
  ('POST /api/pipeline/trigger', 'unauthenticated', 3, 60),
  ('POST /api/context/extract', 'authenticated', 10, 60),
  ('POST /api/context/extract', 'unauthenticated', 3, 60)
ON CONFLICT (endpoint_pattern, tier) DO NOTHING;
