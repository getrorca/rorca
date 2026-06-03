-- 009_user_auth_id.sql — Supabase/auth subject mapping for local users

ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_id UUID UNIQUE;
CREATE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id);
