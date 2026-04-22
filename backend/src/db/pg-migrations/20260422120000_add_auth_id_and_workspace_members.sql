-- Add Supabase auth linkage, direct workspace membership mapping, and RLS helper.
-- This migration is intentionally atomic because future workspace-scoped RLS
-- policies depend on both `workspace_members` and `get_user_workspace_ids()`.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_id UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.schemata
    WHERE schema_name = 'auth'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'users_auth_id_fkey'
        AND conrelid = 'users'::regclass
    ) THEN
      ALTER TABLE users
        ADD CONSTRAINT users_auth_id_fkey
        FOREIGN KEY (auth_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;
  ELSE
    RAISE NOTICE 'Skipping users.auth_id foreign key to auth.users(id) because auth schema does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_auth_id_key'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_auth_id_key UNIQUE (auth_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_auth_id ON users(auth_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_auth_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, user_auth_id)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.schemata
    WHERE schema_name = 'auth'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'workspace_members_user_auth_id_fkey'
        AND conrelid = 'workspace_members'::regclass
    ) THEN
      ALTER TABLE workspace_members
        ADD CONSTRAINT workspace_members_user_auth_id_fkey
        FOREIGN KEY (user_auth_id) REFERENCES auth.users(id) ON DELETE CASCADE;
    END IF;
  ELSE
    RAISE NOTICE 'Skipping workspace_members.user_auth_id foreign key to auth.users(id) because auth schema does not exist';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_members_user_auth_id ON workspace_members(user_auth_id);

CREATE OR REPLACE FUNCTION get_user_workspace_ids(p_auth_id UUID)
RETURNS TABLE(workspace_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rorca, public
AS $$
BEGIN
  RETURN QUERY
  SELECT wm.workspace_id
  FROM workspace_members wm
  WHERE wm.user_auth_id = p_auth_id;
END;
$$;

ALTER FUNCTION get_user_workspace_ids(UUID) OWNER TO postgres;
