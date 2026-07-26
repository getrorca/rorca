-- Enforce Release-1 tenant/user visibility at PostgreSQL authority boundaries.
-- Application tables only; this migration never touches pgboss.* or authority roles.

-- The application sets both request.jwt.claim.sub and request.jwt.claims. Policies
-- accept either representation so direct authenticated clients and the user pool
-- use the same identity contract.

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_select_own ON workspaces;
CREATE POLICY workspace_select_own ON workspaces
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = workspaces.id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS workspace_insert_authenticated ON workspaces;
CREATE POLICY workspace_insert_authenticated ON workspaces
FOR INSERT TO authenticated
WITH CHECK (
  COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ) IS NOT NULL
);

DROP POLICY IF EXISTS workspace_update_admin ON workspaces;
CREATE POLICY workspace_update_admin ON workspaces
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = workspaces.id
      AND member.role IN ('owner', 'admin')
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = workspaces.id
      AND member.role IN ('owner', 'admin')
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS workspace_delete_owner ON workspaces;
CREATE POLICY workspace_delete_owner ON workspaces
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = workspaces.id
      AND member.role = 'owner'
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

ALTER TABLE direction_layers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS direction_layers_select_global_or_workspace_member ON direction_layers;
CREATE POLICY direction_layers_select_global_or_workspace_member ON direction_layers
FOR SELECT TO authenticated
USING (
  workspace_id IS NULL
  OR EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = direction_layers.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS direction_layers_insert_workspace_member_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_insert_workspace_member_or_admin_global ON direction_layers
FOR INSERT TO authenticated
WITH CHECK (
  (
    workspace_id IS NULL
    AND EXISTS (
      SELECT 1 FROM users actor
      WHERE actor.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
        AND actor.role = 'admin'
    )
  )
  OR EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = direction_layers.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS direction_layers_update_workspace_member_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_update_workspace_member_or_admin_global ON direction_layers
FOR UPDATE TO authenticated
USING (
  (
    workspace_id IS NULL
    AND EXISTS (
      SELECT 1 FROM users actor
      WHERE actor.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
        AND actor.role = 'admin'
    )
  )
  OR EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = direction_layers.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
)
WITH CHECK (
  (
    workspace_id IS NULL
    AND EXISTS (
      SELECT 1 FROM users actor
      WHERE actor.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
        AND actor.role = 'admin'
    )
  )
  OR EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = direction_layers.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS direction_layers_delete_workspace_member_or_admin_global ON direction_layers;
CREATE POLICY direction_layers_delete_workspace_member_or_admin_global ON direction_layers
FOR DELETE TO authenticated
USING (
  (
    workspace_id IS NULL
    AND EXISTS (
      SELECT 1 FROM users actor
      WHERE actor.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
        AND actor.role = 'admin'
    )
  )
  OR EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = direction_layers.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

ALTER TABLE wal_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wal_events_select_workspace_member ON wal_events;
CREATE POLICY wal_events_select_workspace_member ON wal_events
FOR SELECT TO authenticated
USING (
  workspace_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = wal_events.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS wal_events_insert_workspace_member ON wal_events;
CREATE POLICY wal_events_insert_workspace_member ON wal_events
FOR INSERT TO authenticated
WITH CHECK (
  workspace_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM workspace_members member
    WHERE member.workspace_id = wal_events.workspace_id
      AND member.user_auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

ALTER TABLE api_key_vault ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_key_vault_select_owner ON api_key_vault;
CREATE POLICY api_key_vault_select_owner ON api_key_vault
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users owner_user
    WHERE owner_user.id = api_key_vault.user_id
      AND owner_user.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS api_key_vault_insert_owner ON api_key_vault;
CREATE POLICY api_key_vault_insert_owner ON api_key_vault
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM users owner_user
    WHERE owner_user.id = api_key_vault.user_id
      AND owner_user.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS api_key_vault_update_owner ON api_key_vault;
CREATE POLICY api_key_vault_update_owner ON api_key_vault
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users owner_user
    WHERE owner_user.id = api_key_vault.user_id
      AND owner_user.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM users owner_user
    WHERE owner_user.id = api_key_vault.user_id
      AND owner_user.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);

DROP POLICY IF EXISTS api_key_vault_delete_owner ON api_key_vault;
CREATE POLICY api_key_vault_delete_owner ON api_key_vault
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM users owner_user
    WHERE owner_user.id = api_key_vault.user_id
      AND owner_user.auth_id::text = COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )
  )
);
