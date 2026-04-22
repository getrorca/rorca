BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS password_hash;

DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS email_verification_tokens;

COMMIT;
