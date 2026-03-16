-- US-056: Login attempt tracking for brute-force protection
-- 5 failed attempts per email within 15 minutes triggers lockout

CREATE TABLE IF NOT EXISTS login_attempts (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email       TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  success     BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
  ON login_attempts (email, attempted_at DESC);

-- Auto-purge entries older than 1 hour (no need to keep stale data)
-- The application checks only the last 15 minutes; 1-hour TTL gives margin.
