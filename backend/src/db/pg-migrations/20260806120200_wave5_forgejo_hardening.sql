-- 20260806120200_wave5_forgejo_hardening.sql
-- Wave 5 Forgejo integrity hardening (lane remed-a):
--   * A1: dedicated high-entropy per-binding webhook signing secret
--     (AES-256-GCM ciphertext at rest, resolved only at verification time,
--     never surfaced by any API/log/audit) with bounded dual-secret
--     rotation/revocation. The credential binding UUID is no longer a
--     signing secret.
--   * A3: RLS + FORCE RLS with split runtime/writer principals scoped to
--     rorca.workspace_id (mirroring wave2/wave4 policy style), PUBLIC /
--     authenticated / anon revocation, DELETE/TRUNCATE revocation from both
--     principals, and wave2-style append-only/immutability triggers on the
--     federation ledger plus the status-projection authority identity.
--   * A4/A5: federation projection ledger becomes durably enqueueable before
--     run lineage exists (run_id nullable) and owns the exact proposal +
--     host-verification JSON needed for restart-safe idempotent reconcile.

-- 1. Dedicated webhook signing secret (A1). Ciphertext only; the plaintext is
--    resolved by the receiver at verification time and never logged or
--    returned. webhook_secret_previous_encrypted carries the prior secret
--    during the bounded dual-secret rotation window so in-flight provider
--    deliveries still verify.
ALTER TABLE forgejo_workspace_credentials
  ADD COLUMN IF NOT EXISTS webhook_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret_previous_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS webhook_secret_version INTEGER NOT NULL DEFAULT 0
    CHECK (webhook_secret_version >= 0),
  ADD COLUMN IF NOT EXISTS webhook_secret_rotated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS webhook_secret_revoked_at TIMESTAMPTZ;

-- The W5-006 receiver claims deliveries with 'forgejo-hmac-sha256' provenance;
-- the shared delivery-ledger constraint predates the Forgejo provider, so it
-- must recognize the provider's exact verified method.
ALTER TABLE webhook_events
  DROP CONSTRAINT IF EXISTS webhook_event_verified_provenance_check,
  ADD CONSTRAINT webhook_event_verified_provenance_check CHECK (
    (payload_sha256 IS NULL AND verification_method IS NULL AND signature_verified_at IS NULL)
    OR (
      payload_sha256 ~ '^[0-9a-f]{64}$'
      AND verification_method ~ '^(github-hmac-sha256|linear-signature|vercel-signature|slack-signature|forgejo-hmac-sha256)$'
      AND verification_method = CASE provider
        WHEN 'github' THEN 'github-hmac-sha256'
        WHEN 'linear' THEN 'linear-signature'
        WHEN 'vercel' THEN 'vercel-signature'
        WHEN 'slack' THEN 'slack-signature'
        WHEN 'forgejo' THEN 'forgejo-hmac-sha256'
      END
      AND signature_verified_at IS NOT NULL
    )
  );

ALTER TABLE forgejo_workspace_credentials
  DROP CONSTRAINT IF EXISTS forgejo_credential_webhook_secret_check;
ALTER TABLE forgejo_workspace_credentials
  ADD CONSTRAINT forgejo_credential_webhook_secret_check CHECK (
    (webhook_secret_version = 0
      AND webhook_secret_encrypted IS NULL
      AND webhook_secret_previous_encrypted IS NULL)
    OR (webhook_secret_version > 0
      AND webhook_secret_encrypted IS NOT NULL
      AND btrim(webhook_secret_encrypted) <> ''
      AND webhook_secret_revoked_at IS NULL
      AND (webhook_secret_previous_encrypted IS NULL
        OR btrim(webhook_secret_previous_encrypted) <> ''))
  );
-- Extend the credential identity guard so webhook-secret material is mutable
-- while workspace/instance/repository identity stays immutable.
CREATE OR REPLACE FUNCTION guard_forgejo_credential_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Forgejo credentials are audit-retained; revoke instead of deleting';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['token_digest','scope_profile','status','credential_version','key_version',
     'expires_at','last_validated_at','validation_error_code','status_changed_at','superseded_at',
     'webhook_secret_encrypted','webhook_secret_previous_encrypted','webhook_secret_version',
     'webhook_secret_rotated_at','webhook_secret_revoked_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['token_digest','scope_profile','status','credential_version','key_version',
     'expires_at','last_validated_at','validation_error_code','status_changed_at','superseded_at',
     'webhook_secret_encrypted','webhook_secret_previous_encrypted','webhook_secret_version',
     'webhook_secret_rotated_at','webhook_secret_revoked_at']::text[]) THEN
    RAISE EXCEPTION 'Forgejo credential workspace/instance/repository identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_forgejo_credential_identity ON forgejo_workspace_credentials;
CREATE TRIGGER trg_forgejo_credential_identity
  BEFORE UPDATE OR DELETE ON forgejo_workspace_credentials
  FOR EACH ROW EXECUTE FUNCTION guard_forgejo_credential_identity();

-- 2. Federation projection ledger (A4/A5): durable enqueue before lineage
--    binds, and write-once identity with a single pending -> projected
--    outcome transition for restart-safe reconcile.
ALTER TABLE forgejo_federation_projections
  ALTER COLUMN run_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS proposal_json JSONB,
  ADD COLUMN IF NOT EXISTS host_verification_json JSONB;

-- 3. RLS + FORCE RLS + split-principal policies + privilege revocation (A3).
DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
DECLARE writer_user TEXT := current_setting('rorca.canonical_writer_database_user',TRUE);
DECLARE table_name TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR writer_user IS NULL OR writer_user='' THEN
    RAISE EXCEPTION 'Wave 5 Forgejo hardening principals required' USING ERRCODE='42501';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'forgejo_workspace_credentials','forgejo_status_projections','forgejo_federation_projections'
  ] LOOP
    -- No inherited request role (PUBLIC/authenticated/anon) may ever touch
    -- the adapter ledgers; only the split runtime/writer principals and the
    -- migration owner can.
    EXECUTE format('REVOKE ALL ON TABLE rorca.%I FROM PUBLIC', table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE rorca.%I FROM authenticated', table_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE rorca.%I FROM anon', table_name);
    END IF;
    -- DELETE/TRUNCATE are never part of either principal's contract;
    -- revocation is the only credential lifecycle path.
    EXECUTE format('REVOKE DELETE,TRUNCATE ON TABLE rorca.%I FROM %I', table_name, runtime_user);
    EXECUTE format('REVOKE DELETE,TRUNCATE ON TABLE rorca.%I FROM %I', table_name, writer_user);
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE rorca.%I FORCE ROW LEVEL SECURITY', table_name);
    -- Runtime principal: exact workspace scope only (mirror wave2 style).
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR SELECT USING (
      (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='migration_owner')) OR
      (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='internal_runtime')))$policy$,
      'wave5_forgejo_runtime_read_'||table_name, table_name);
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR INSERT WITH CHECK (
      (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='migration_owner')) OR
      (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='internal_runtime')))$policy$,
      'wave5_forgejo_runtime_insert_'||table_name, table_name);
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR UPDATE USING (
      (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='migration_owner')) OR
      (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='internal_runtime')))
      WITH CHECK (
      (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='migration_owner')) OR
      (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='internal_runtime')))$policy$,
      'wave5_forgejo_runtime_update_'||table_name, table_name);
    -- Canonical writer principal: same exact workspace scope, split identity.
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR SELECT USING (
      workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i
        WHERE i.database_user=current_user))$policy$,
      'wave5_forgejo_writer_read_'||table_name, table_name);
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR INSERT WITH CHECK (
      workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i
        WHERE i.database_user=current_user))$policy$,
      'wave5_forgejo_writer_insert_'||table_name, table_name);
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR UPDATE USING (
      workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i
        WHERE i.database_user=current_user))
      WITH CHECK (
      workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_canonical_writer_identities i
        WHERE i.database_user=current_user))$policy$,
      'wave5_forgejo_writer_update_'||table_name, table_name);
    -- SECURITY DEFINER functions (wave4 style) may cross the workspace GUC
    -- boundary for exact repo-identity lookups; direct session queries can
    -- never (current_user IS DISTINCT FROM session_user is false for them).
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR ALL
      USING (current_user IS DISTINCT FROM session_user)
      WITH CHECK (current_user IS DISTINCT FROM session_user)$policy$,
      'wave5_forgejo_definer_'||table_name, table_name);
  END LOOP;
    -- The migration owner may see rows for DELETE so the append-only
    -- triggers reject the attempt (55000) instead of silently filtering to
    -- zero rows; runtime/writer DELETE stays ACL-revoked (42501).
    EXECUTE format($policy$CREATE POLICY %I ON rorca.%I FOR DELETE USING (
      current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p
        WHERE p.database_user=current_user AND p.principal_class='migration_owner'))$policy$,
      'wave5_forgejo_owner_delete_'||table_name, table_name);
END $$;

-- Exact repo-identity webhook resolution (A1): a verified delivery arrives
-- with no request workspace, so the receiver resolves the credential by
-- owner/name through this definer seam. Only split principals may call it;
-- direct table access stays workspace-scoped by the RLS policies above.
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
     LIMIT 1;
END; $$;
REVOKE ALL ON FUNCTION rorca.resolve_forgejo_webhook_binding(TEXT,TEXT) FROM PUBLIC;
DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
DECLARE writer_user TEXT := current_setting('rorca.canonical_writer_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR writer_user IS NULL OR writer_user='' THEN
    RAISE EXCEPTION 'Wave 5 Forgejo webhook resolution principals required' USING ERRCODE='42501';
  END IF;
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.resolve_forgejo_webhook_binding(TEXT,TEXT) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.resolve_forgejo_webhook_binding(TEXT,TEXT) TO %I', writer_user);
END $$;

-- 4. Append-only / immutability triggers (A3).
--    Federation ledger: write-once identity; only pending -> projected
--    outcome transitions are legal; DELETE and TRUNCATE are rejected.
CREATE OR REPLACE FUNCTION rorca.guard_forgejo_federation_projection_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Forgejo federation projections are audit-retained; never deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.proposal_id IS DISTINCT FROM OLD.proposal_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.proposal_hash IS DISTINCT FROM OLD.proposal_hash
    OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
    OR NEW.changed_path_manifest_hash IS DISTINCT FROM OLD.changed_path_manifest_hash
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.proposal_json IS DISTINCT FROM OLD.proposal_json
    OR NEW.host_verification_json IS DISTINCT FROM OLD.host_verification_json THEN
    RAISE EXCEPTION 'Forgejo federation projection identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.status NOT IN ('pending') THEN
    RAISE EXCEPTION 'terminal Forgejo federation projection is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_forgejo_federation_projection_identity ON forgejo_federation_projections;
CREATE TRIGGER trg_forgejo_federation_projection_identity
  BEFORE UPDATE OR DELETE ON forgejo_federation_projections
  FOR EACH ROW EXECUTE FUNCTION rorca.guard_forgejo_federation_projection_identity();
DROP TRIGGER IF EXISTS forgejo_federation_projections_no_truncate ON forgejo_federation_projections;
CREATE TRIGGER forgejo_federation_projections_no_truncate
  BEFORE TRUNCATE ON forgejo_federation_projections
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

-- Definer-context read of the split-principal table (mirrors wave3a's
-- definer policy on wave2_canonical_writer_identities) so the webhook
-- resolution seam can verify the caller's principal class; direct sessions
-- still see only their own row via wave2_principal_self_read.
CREATE POLICY wave5_forgejo_definer_principal_read ON rorca.wave2_database_principals
  FOR SELECT USING(current_user IS DISTINCT FROM session_user);

--    Status projection ledger: keep the mutable terminal-transition trigger,
--    extend identity immutability to authority fields at every state and to
--    the full projection identity once provider-terminal, and reject
--    DELETE/TRUNCATE like the wave2 ledgers.
CREATE OR REPLACE FUNCTION enforce_terminal_forgejo_projection_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Forgejo status projections are audit-retained; never deleted' USING ERRCODE='55000';
  END IF;
  IF NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
    OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
    OR NEW.repository_authority_source IS DISTINCT FROM OLD.repository_authority_source
    OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'Forgejo status projection repository authority is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF (OLD.desired_state = 'completed' OR OLD.projection_status IN ('projected','completed')) AND (
    NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.spec_id IS DISTINCT FROM OLD.spec_id
    OR NEW.desired_event_id IS DISTINCT FROM OLD.desired_event_id
    OR NEW.desired_event_identity_hash IS DISTINCT FROM OLD.desired_event_identity_hash
    OR NEW.desired_state IS DISTINCT FROM OLD.desired_state
    OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
    OR NEW.conclusion IS DISTINCT FROM OLD.conclusion
    OR NEW.desired_payload IS DISTINCT FROM OLD.desired_payload
    OR NEW.desired_payload_hash IS DISTINCT FROM OLD.desired_payload_hash
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
  ) THEN
    RAISE EXCEPTION 'terminal Forgejo status projection identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_terminal_forgejo_projection_immutability ON forgejo_status_projections;
CREATE TRIGGER trg_terminal_forgejo_projection_immutability
  BEFORE UPDATE OR DELETE ON forgejo_status_projections
  FOR EACH ROW EXECUTE FUNCTION enforce_terminal_forgejo_projection_immutability();
DROP TRIGGER IF EXISTS forgejo_status_projections_no_truncate ON forgejo_status_projections;
CREATE TRIGGER forgejo_status_projections_no_truncate
  BEFORE TRUNCATE ON forgejo_status_projections
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

--    Credential ledger: no truncation ever (identity guard already covers
--    UPDATE/DELETE).
DROP TRIGGER IF EXISTS forgejo_workspace_credentials_no_truncate ON forgejo_workspace_credentials;
CREATE TRIGGER forgejo_workspace_credentials_no_truncate
  BEFORE TRUNCATE ON forgejo_workspace_credentials
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
