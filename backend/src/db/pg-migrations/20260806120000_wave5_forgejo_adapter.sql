-- 20260806120000_wave5_forgejo_adapter.sql
-- Wave 5 Forgejo adapter: digest-only workspace credentials, restart-safe
-- commit-status projections, and idempotent federation result projections.
-- Raw Forgejo tokens are NEVER stored; only peppered digests and probe
-- metadata enter the database.

-- 1. Forgejo repository authority source for the shared release intent table.
ALTER TABLE pipeline_run_release_intents
  DROP CONSTRAINT IF EXISTS pipeline_run_release_intents_repository_authority_source_check;
ALTER TABLE pipeline_run_release_intents
  ADD CONSTRAINT pipeline_run_release_intents_repository_authority_source_check CHECK (
    repository_authority_source IS NULL
    OR repository_authority_source IN ('github-app-installation', 'pat-oauth-fallback', 'forgejo-token')
  );

-- 2. Per-workspace Forgejo credential binding (digest-only).
CREATE TABLE IF NOT EXISTS forgejo_workspace_credentials (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  instance_url TEXT NOT NULL CHECK (instance_url ~ '^https?://[A-Za-z0-9._:/-]+$'),
  repo_owner TEXT NOT NULL CHECK (repo_owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$'),
  repo_name TEXT NOT NULL CHECK (repo_name ~ '^[A-Za-z0-9._-]{1,100}$'),
  token_digest TEXT NOT NULL CHECK (token_digest ~ '^sha256:[0-9a-f]{64}$'),
  scope_profile JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(scope_profile) = 'object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'invalid', 'revoked')),
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  expires_at TIMESTAMPTZ,
  created_by TEXT NOT NULL CHECK (btrim(created_by) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_validated_at TIMESTAMPTZ,
  validation_error_code TEXT,
  status_changed_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  audit_provenance_hash TEXT CHECK (audit_provenance_hash IS NULL OR audit_provenance_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT forgejo_credential_status_check CHECK (
    (status = 'active' AND validation_error_code IS NULL)
    OR status IN ('disabled', 'invalid', 'revoked')
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_forgejo_credential_workspace_identity
  ON forgejo_workspace_credentials (workspace_id, lower(repo_owner), lower(repo_name), credential_version, key_version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_forgejo_credential_one_current_workspace
  ON forgejo_workspace_credentials (workspace_id) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_forgejo_credentials_repo_identity
  ON forgejo_workspace_credentials (workspace_id, lower(repo_owner), lower(repo_name));

-- Credential binding identity (workspace/instance/repo) is immutable; only
-- status, probe metadata, expiry, and audit timestamps may change.
CREATE OR REPLACE FUNCTION guard_forgejo_credential_identity()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Forgejo credentials are audit-retained; revoke instead of deleting';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['token_digest','scope_profile','status','credential_version','key_version',
     'expires_at','last_validated_at','validation_error_code','status_changed_at','superseded_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['token_digest','scope_profile','status','credential_version','key_version',
     'expires_at','last_validated_at','validation_error_code','status_changed_at','superseded_at']::text[]) THEN
    RAISE EXCEPTION 'Forgejo credential workspace/instance/repository identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_forgejo_credential_identity ON forgejo_workspace_credentials;
CREATE TRIGGER trg_forgejo_credential_identity
  BEFORE UPDATE OR DELETE ON forgejo_workspace_credentials
  FOR EACH ROW EXECUTE FUNCTION guard_forgejo_credential_identity();

-- 3. Restart-safe Forgejo commit-status projection ledger (mirrors the GitHub
-- Check Run projection contract, provider-neutral authority checks).
CREATE TABLE IF NOT EXISTS forgejo_status_projections (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  desired_event_id INTEGER NOT NULL REFERENCES wal_events(id) ON DELETE RESTRICT,
  desired_event_identity_hash TEXT NOT NULL CHECK (desired_event_identity_hash ~ '^[0-9a-f]{64}$'),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('in_progress', 'completed')),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success', 'failure', 'neutral')),
  desired_payload JSONB NOT NULL CHECK (jsonb_typeof(desired_payload) = 'object'),
  desired_payload_hash TEXT NOT NULL CHECK (desired_payload_hash ~ '^[0-9a-f]{64}$'),
  external_id TEXT NOT NULL,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending', 'processing', 'retry', 'uncertain', 'projected', 'completed', 'blocked')),
  provider_status_id BIGINT,
  provider_head_sha TEXT CHECK (provider_head_sha IS NULL OR provider_head_sha ~ '^[0-9a-f]{40}$'),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  provider_request_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  repository_authority_source TEXT NOT NULL DEFAULT 'forgejo-token'
    CHECK (repository_authority_source = 'forgejo-token'),
  repository_binding_id UUID,
  CONSTRAINT forgejo_status_projection_binding_fk
    FOREIGN KEY (repository_binding_id) REFERENCES forgejo_workspace_credentials(id) NOT VALID,
  repository_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((projection_status = 'processing') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((desired_state = 'in_progress' AND conclusion IS NULL)
      OR (desired_state = 'completed' AND conclusion IS NOT NULL)),
  UNIQUE (workspace_id, run_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_forgejo_status_projection_recovery
  ON forgejo_status_projections (projection_status, next_attempt_at, updated_at);

CREATE OR REPLACE FUNCTION enforce_terminal_forgejo_projection_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
    OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
    OR NEW.repository_authority_source IS DISTINCT FROM OLD.repository_authority_source
    OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'Forgejo status projection repository authority is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.desired_state = 'completed' AND (
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
BEFORE UPDATE ON forgejo_status_projections
FOR EACH ROW EXECUTE FUNCTION enforce_terminal_forgejo_projection_immutability();

-- 4. Idempotent federation-result → Forgejo projection bridge ledger (W5-005).
CREATE TABLE IF NOT EXISTS forgejo_federation_projections (
  proposal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  proposal_hash TEXT NOT NULL CHECK (proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  changed_path_manifest_hash TEXT CHECK (changed_path_manifest_hash IS NULL OR changed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  intent_run_id BIGINT REFERENCES pipeline_run_release_intents(run_id),
  draft_pr_number INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'projected', 'blocked', 'rejected_changed_head')),
  error_code TEXT,
  idempotency_key TEXT NOT NULL UNIQUE CHECK (btrim(idempotency_key) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, proposal_hash)
);

-- 5. Principal grants mirroring wave3b/wave4: the runtime and canonical writer
-- both operate the adapter ledger; nothing is exposed to inherited request roles.
DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
DECLARE writer_user TEXT := current_setting('rorca.canonical_writer_database_user',TRUE);
DECLARE table_name TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR writer_user IS NULL OR writer_user='' THEN
    RAISE EXCEPTION 'Wave 5 Forgejo database principals required' USING ERRCODE='42501';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'forgejo_workspace_credentials','forgejo_status_projections','forgejo_federation_projections'
  ] LOOP
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE rorca.%I TO %I',table_name,runtime_user);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE rorca.%I TO %I',table_name,writer_user);
  END LOOP;
END $$;
