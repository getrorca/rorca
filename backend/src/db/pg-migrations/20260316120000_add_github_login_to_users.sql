-- 20260316120000_add_github_login_to_users.sql
-- Add github_login column to users table for storing the GitHub username
-- alongside the existing github_id (numeric ID) and avatar_url columns.

ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;
