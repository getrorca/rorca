-- Drop legacy password-based auth artifacts now replaced by Supabase auth.

DROP TABLE IF EXISTS email_verification_tokens;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS refresh_tokens;

ALTER TABLE users
  DROP COLUMN IF EXISTS password_hash;
