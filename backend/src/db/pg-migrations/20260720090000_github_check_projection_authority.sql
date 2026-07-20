-- Freeze exact repository/App authority on restart-safe GitHub Check Run projections.
-- Historical rows are backfilled only from immutable matching release intents;
-- unresolved provider-write-capable rows are blocked rather than rebound to the
-- workspace's current repository authority.

ALTER TABLE github_check_run_projections
  ADD COLUMN IF NOT EXISTS repository_owner TEXT,
  ADD COLUMN IF NOT EXISTS repository_name TEXT,
  ADD COLUMN IF NOT EXISTS repository_authority_source TEXT,
  ADD COLUMN IF NOT EXISTS repository_binding_id UUID,
  ADD COLUMN IF NOT EXISTS repository_installation_id BIGINT,
  ADD COLUMN IF NOT EXISTS repository_id BIGINT;

UPDATE github_check_run_projections p
SET repository_owner = i.repository_owner,
    repository_name = i.repository_name,
    repository_authority_source = i.repository_authority_source,
    repository_binding_id = i.repository_binding_id,
    repository_installation_id = i.repository_installation_id,
    repository_id = i.repository_id
FROM pipeline_run_release_intents i
WHERE i.run_id = p.run_id
  AND i.workspace_id = p.workspace_id
  AND lower(i.authorized_sha) = lower(p.head_sha)
  AND i.repository_owner IS NOT NULL
  AND i.repository_name IS NOT NULL
  AND p.repository_owner IS NULL;

UPDATE github_check_run_projections
SET projection_status = 'blocked',
    claim_token = NULL,
    claimed_at = NULL,
    next_attempt_at = NULL,
    last_error_code = 'GITHUB_CHECK_RUN_LEGACY_AUTHORITY_UNFROZEN',
    last_error_message = 'Historical projection has no provable immutable repository authority',
    updated_at = NOW()
WHERE repository_owner IS NULL
  AND projection_status IN ('pending', 'processing', 'retry', 'uncertain', 'projected');

ALTER TABLE github_check_run_projections
  ADD CONSTRAINT github_check_projection_repository_authority_ck CHECK (
    (repository_owner IS NULL AND repository_name IS NULL
      AND repository_authority_source IS NULL AND repository_binding_id IS NULL
      AND repository_installation_id IS NULL AND repository_id IS NULL)
    OR
    (repository_owner IS NOT NULL AND repository_name IS NOT NULL
      AND repository_authority_source = 'github-app-installation'
      AND repository_binding_id IS NOT NULL AND repository_installation_id IS NOT NULL
      AND repository_id IS NOT NULL)
    OR
    (repository_owner IS NOT NULL AND repository_name IS NOT NULL
      AND repository_authority_source = 'pat-oauth-fallback'
      AND repository_binding_id IS NULL AND repository_installation_id IS NULL
      AND repository_id IS NULL)
  ) NOT VALID;

ALTER TABLE github_check_run_projections
  ADD CONSTRAINT github_check_projection_binding_fk
  FOREIGN KEY (repository_binding_id) REFERENCES github_app_workspace_bindings(id)
  NOT VALID;

CREATE OR REPLACE FUNCTION enforce_terminal_check_projection_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
    OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
    OR NEW.repository_authority_source IS DISTINCT FROM OLD.repository_authority_source
    OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
    OR NEW.repository_installation_id IS DISTINCT FROM OLD.repository_installation_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'Check Run projection repository authority is immutable'
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
    RAISE EXCEPTION 'terminal Check Run projection identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
