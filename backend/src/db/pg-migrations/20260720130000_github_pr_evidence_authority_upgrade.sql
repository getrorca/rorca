-- Forward-only restatement of repository authority added after
-- 20260720090000 had already shipped. The migration ledger is version-only, so
-- installations that recorded the parent 090000 file must receive these
-- additions under a new immutable version.

ALTER TABLE github_check_run_projections
  DROP CONSTRAINT IF EXISTS github_check_projection_repository_authority_ck;
ALTER TABLE github_check_run_projections
  ADD CONSTRAINT github_check_projection_repository_authority_ck CHECK (
    (repository_owner IS NULL AND repository_name IS NULL
      AND repository_authority_source IS NULL AND repository_binding_id IS NULL
      AND repository_installation_id IS NULL AND repository_id IS NULL
      AND projection_status = 'blocked'
      AND last_error_code = 'GITHUB_CHECK_RUN_LEGACY_AUTHORITY_UNFROZEN')
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

ALTER TABLE github_pr_delivery_evidence
  ADD COLUMN IF NOT EXISTS repository_authority_source TEXT,
  ADD COLUMN IF NOT EXISTS repository_binding_id UUID,
  ADD COLUMN IF NOT EXISTS repository_installation_id BIGINT,
  ADD COLUMN IF NOT EXISTS repository_id BIGINT;

UPDATE github_pr_delivery_evidence e
SET repository_authority_source = i.repository_authority_source,
    repository_binding_id = i.repository_binding_id,
    repository_installation_id = i.repository_installation_id,
    repository_id = i.repository_id
FROM pipeline_run_release_intents i
WHERE i.run_id = e.run_id
  AND i.workspace_id = e.workspace_id
  AND lower(i.authorized_sha) = lower(e.head_sha)
  AND lower(i.repository_owner) = lower(e.repo_owner)
  AND lower(i.repository_name) = lower(e.repo_name)
  AND e.repository_authority_source IS NULL;

ALTER TABLE github_pr_delivery_evidence
  DROP CONSTRAINT IF EXISTS github_pr_evidence_repository_authority_ck,
  DROP CONSTRAINT IF EXISTS github_pr_evidence_binding_fk;
ALTER TABLE github_pr_delivery_evidence
  ADD CONSTRAINT github_pr_evidence_repository_authority_ck CHECK (COALESCE(
    (repository_authority_source = 'github-app-installation'
      AND repository_binding_id IS NOT NULL AND repository_installation_id IS NOT NULL AND repository_id IS NOT NULL)
    OR
    (repository_authority_source = 'pat-oauth-fallback'
      AND repository_binding_id IS NULL AND repository_installation_id IS NULL AND repository_id IS NULL),
    FALSE
  )) NOT VALID,
  ADD CONSTRAINT github_pr_evidence_binding_fk
    FOREIGN KEY (repository_binding_id) REFERENCES github_app_workspace_bindings(id) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_github_pr_evidence_authority_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.repository_authority_source IS DISTINCT FROM OLD.repository_authority_source
    OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
    OR NEW.repository_installation_id IS DISTINCT FROM OLD.repository_installation_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id THEN
    RAISE EXCEPTION 'GitHub PR evidence repository authority is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_github_pr_evidence_authority_immutable ON github_pr_delivery_evidence;
CREATE TRIGGER trg_github_pr_evidence_authority_immutable
BEFORE UPDATE ON github_pr_delivery_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_github_pr_evidence_authority_immutability();
