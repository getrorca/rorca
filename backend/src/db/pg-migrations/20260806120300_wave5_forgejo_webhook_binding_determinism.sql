-- 20260806120300_wave5_forgejo_webhook_binding_determinism.sql
-- A verified Forgejo delivery arrives with no request workspace, so the
-- receiver resolves the credential binding by repo identity. When multiple
-- workspaces bind the same repository, the previous LIMIT 1 without ORDER BY
-- returned an arbitrary row: a valid signed delivery could be resolved to a
-- binding whose dedicated webhook secret was never provisioned and be rejected
-- with 401 (or verified against the wrong secret). Resolution is now
-- deterministic and prefers a binding that can actually verify signatures
-- (webhook_secret_version > 0), newest first; a secret-less binding can never
-- verify a delivery, so it is never the resolution winner.
CREATE OR REPLACE FUNCTION rorca.resolve_forgejo_webhook_binding(p_owner TEXT, p_name TEXT)
RETURNS TABLE (
  id UUID, workspace_id TEXT, instance_url TEXT, repo_owner TEXT, repo_name TEXT,
  status TEXT, webhook_secret_encrypted TEXT, webhook_secret_previous_encrypted TEXT,
  webhook_secret_version INTEGER, webhook_secret_revoked_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = rorca, pg_catalog AS $$
DECLARE authorized BOOLEAN;
BEGIN
  IF p_owner IS NULL OR p_owner = '' OR p_name IS NULL OR p_name = '' THEN
    RAISE EXCEPTION 'Forgejo webhook repository identity is required' USING ERRCODE='22023';
  END IF;
  SELECT EXISTS(
    SELECT 1 FROM rorca.wave2_database_principals p
     WHERE p.database_user = session_user AND p.principal_class IN ('internal_runtime','migration_owner')
  ) OR EXISTS(
    SELECT 1 FROM rorca.wave2_canonical_writer_identities i WHERE i.database_user = session_user
  ) INTO authorized;
  IF NOT authorized THEN
    RAISE EXCEPTION 'Forgejo webhook resolution requires a split principal' USING ERRCODE='42501';
  END IF;
  RETURN QUERY
    SELECT c.id, c.workspace_id, c.instance_url, c.repo_owner, c.repo_name, c.status,
           c.webhook_secret_encrypted, c.webhook_secret_previous_encrypted,
           c.webhook_secret_version, c.webhook_secret_revoked_at
      FROM rorca.forgejo_workspace_credentials c
     WHERE lower(c.repo_owner) = lower(p_owner) AND lower(c.repo_name) = lower(p_name)
       AND c.superseded_at IS NULL
     ORDER BY (c.webhook_secret_version > 0) DESC, c.created_at DESC, c.id
     LIMIT 1;
END; $$;
