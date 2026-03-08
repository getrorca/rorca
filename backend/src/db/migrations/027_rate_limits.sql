-- V2-065: Rate limit configuration table
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_pattern TEXT NOT NULL,        -- e.g. 'POST /api/specs/generate', '*' for default
  tier TEXT NOT NULL DEFAULT 'default',  -- 'default', 'authenticated', 'unauthenticated', or custom tier
  max_requests INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL DEFAULT 60,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(endpoint_pattern, tier)
);

-- Seed default limits
-- Note: SSE endpoints (/api/pipeline/stream, /api/pipeline/runs/:id/output, etc.)
-- are exempt from rate limiting in rate-limiter.ts — they support long-lived connections
-- and frequent polling by monitoring tools. No DB entries needed.
INSERT OR IGNORE INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds) VALUES
  ('*', 'authenticated', 100, 60),
  ('*', 'unauthenticated', 20, 60),
  ('POST /api/specs/generate', 'authenticated', 10, 60),
  ('POST /api/specs/generate', 'unauthenticated', 3, 60),
  ('POST /api/specs/:id/add-stories', 'authenticated', 10, 60),
  ('POST /api/specs/:id/add-stories', 'unauthenticated', 3, 60),
  ('POST /api/pipeline/trigger', 'authenticated', 10, 60),
  ('POST /api/pipeline/trigger', 'unauthenticated', 3, 60),
  ('POST /api/context/extract', 'authenticated', 10, 60),
  ('POST /api/context/extract', 'unauthenticated', 3, 60);
