-- Add token lifecycle columns to github_connections for OAuth token health tracking.
-- revoked_at: set when GitHub returns 401 on token validation.
-- last_validated_at: set on successful validation against api.github.com/user.

ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE github_connections ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMPTZ;
