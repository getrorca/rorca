-- 20260316000014_github_connections_scope.sql — Add DEFAULT to github_connections.scopes for minimal OAuth
-- BL-014: Initial OAuth requests only read:user user:email. Repo scope is lazy-elevated.

ALTER TABLE github_connections
  ALTER COLUMN scopes SET DEFAULT 'read:user user:email';

-- Backfill existing rows that have the old broad scopes with no change needed —
-- they already have their granted scopes recorded. No data migration required.
