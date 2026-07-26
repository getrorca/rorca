-- Host-owned immutable run closeout authority for retry scope and release.
-- No pgboss.* objects are read or modified.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS host_closeout_event_id INTEGER
    REFERENCES wal_events(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pipeline_runs_host_closeout_event
  ON pipeline_runs(host_closeout_event_id)
  WHERE host_closeout_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_wal_host_run_closeout
  ON wal_events(canonical_run_id)
  WHERE event_type = 'run_closeout'
    AND trust_provenance = 'host'
    AND trusted_source = 'worker';

ALTER TABLE pipeline_run_release_intents
  ADD COLUMN IF NOT EXISTS host_closeout_event_id INTEGER
    REFERENCES wal_events(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS host_closeout_identity_hash CHAR(64);

ALTER TABLE pipeline_run_release_intents
  DROP CONSTRAINT IF EXISTS pipeline_run_release_closeout_pair_ck,
  ADD CONSTRAINT pipeline_run_release_closeout_pair_ck CHECK (
    (host_closeout_event_id IS NULL) = (host_closeout_identity_hash IS NULL)
    AND (host_closeout_identity_hash IS NULL OR host_closeout_identity_hash ~ '^[0-9a-f]{64}$')
  ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_pipeline_run_host_closeout_pointer()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.host_closeout_event_id IS NOT NULL
     AND NEW.host_closeout_event_id IS DISTINCT FROM OLD.host_closeout_event_id THEN
    RAISE EXCEPTION 'pipeline run host closeout authority is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pipeline_run_host_closeout_pointer ON pipeline_runs;
CREATE TRIGGER trg_pipeline_run_host_closeout_pointer
BEFORE UPDATE OF host_closeout_event_id ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_run_host_closeout_pointer();

CREATE OR REPLACE FUNCTION enforce_pipeline_run_release_intent_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.spec_id IS DISTINCT FROM OLD.spec_id
    OR NEW.authorized_sha IS DISTINCT FROM OLD.authorized_sha
    OR NEW.branch_name IS DISTINCT FROM OLD.branch_name
    OR NEW.execution_workspace_path IS DISTINCT FROM OLD.execution_workspace_path
    OR NEW.execution_worktree_path IS DISTINCT FROM OLD.execution_worktree_path
    OR NEW.repository_owner IS DISTINCT FROM OLD.repository_owner
    OR NEW.repository_name IS DISTINCT FROM OLD.repository_name
    OR NEW.repository_authority_source IS DISTINCT FROM OLD.repository_authority_source
    OR NEW.repository_binding_id IS DISTINCT FROM OLD.repository_binding_id
    OR NEW.repository_installation_id IS DISTINCT FROM OLD.repository_installation_id
    OR NEW.repository_id IS DISTINCT FROM OLD.repository_id
    OR NEW.merge_strategy IS DISTINCT FROM OLD.merge_strategy
    OR NEW.auto_merge IS DISTINCT FROM OLD.auto_merge
    OR NEW.external_send IS DISTINCT FROM OLD.external_send
    OR NEW.deployment_allowed IS DISTINCT FROM OLD.deployment_allowed
    OR NEW.identity_hash IS DISTINCT FROM OLD.identity_hash
    OR NEW.base_branch IS DISTINCT FROM OLD.base_branch
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha
    OR NEW.provider_release_ref IS DISTINCT FROM OLD.provider_release_ref
    OR NEW.integration_checkout_path IS DISTINCT FROM OLD.integration_checkout_path
    OR NEW.host_closeout_event_id IS DISTINCT FROM OLD.host_closeout_event_id
    OR NEW.host_closeout_identity_hash IS DISTINCT FROM OLD.host_closeout_identity_hash
  ) THEN
    RAISE EXCEPTION 'pipeline run release intent authority identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Historical untrusted run_closeout rows are intentionally not backfilled.
