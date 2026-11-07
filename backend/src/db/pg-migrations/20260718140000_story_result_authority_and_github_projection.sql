-- 20260718140000_story_result_authority_and_github_projection.sql
-- Host-only result provenance and restart-safe GitHub Check Run projection.

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS result_provenance TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS result_source TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE story_results
  DROP CONSTRAINT IF EXISTS story_results_result_provenance_ck,
  ADD CONSTRAINT story_results_result_provenance_ck
    CHECK (result_provenance IN ('host', 'compatibility', 'recovery_proposal', 'legacy')),
  DROP CONSTRAINT IF EXISTS story_results_result_source_ck,
  ADD CONSTRAINT story_results_result_source_ck
    CHECK (result_source IN ('execution-engine', 'worker', 'compatibility-http', 'fallback-journal', 'legacy')),
  DROP CONSTRAINT IF EXISTS story_results_host_source_ck,
  ADD CONSTRAINT story_results_host_source_ck CHECK (
    (result_provenance = 'host' AND result_source IN ('execution-engine', 'worker'))
    OR (result_provenance = 'compatibility' AND result_source = 'compatibility-http')
    OR (result_provenance = 'recovery_proposal' AND result_source = 'fallback-journal')
    OR (result_provenance = 'legacy' AND result_source = 'legacy')
  ),
  DROP CONSTRAINT IF EXISTS story_results_integrated_host_ck,
  ADD CONSTRAINT story_results_integrated_host_ck CHECK (
    NOT integrated
    OR (result_provenance = 'host' AND result_source = 'execution-engine')
    -- The immediately preceding migration can conservatively identify some
    -- historical integrated rows. Retain them as legacy/non-authoritative;
    -- terminal governance still requires exact host provenance at runtime.
    OR (result_provenance = 'legacy' AND result_source = 'legacy')
  );

CREATE OR REPLACE FUNCTION enforce_story_result_authority_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.story_id IS DISTINCT FROM OLD.story_id
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.finished_at IS DISTINCT FROM OLD.finished_at
     OR NEW.finished_at_source IS DISTINCT FROM OLD.finished_at_source
     OR NEW.spec_id IS DISTINCT FROM OLD.spec_id
     OR NEW.spec_revision IS DISTINCT FROM OLD.spec_revision
     OR NEW.story_revision IS DISTINCT FROM OLD.story_revision
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.closeout_decision_id IS DISTINCT FROM OLD.closeout_decision_id
     OR NEW.ingest_key IS DISTINCT FROM OLD.ingest_key
     OR NEW.result_provenance IS DISTINCT FROM OLD.result_provenance
     OR NEW.result_source IS DISTINCT FROM OLD.result_source
     OR NEW.integrated IS DISTINCT FROM OLD.integrated
     OR NEW.commit_sha IS DISTINCT FROM OLD.commit_sha
     OR NEW.commit_message IS DISTINCT FROM OLD.commit_message
     OR NEW.commit_author IS DISTINCT FROM OLD.commit_author
     OR NEW.commit_branch IS DISTINCT FROM OLD.commit_branch
     OR NEW.commit_observed_source IS DISTINCT FROM OLD.commit_observed_source THEN
    RAISE EXCEPTION 'story result authority identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_story_result_authority_immutability ON story_results;
CREATE TRIGGER trg_story_result_authority_immutability
BEFORE UPDATE ON story_results
FOR EACH ROW EXECUTE FUNCTION enforce_story_result_authority_immutability();

CREATE TABLE IF NOT EXISTS github_check_run_projections (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  desired_event_id INTEGER NOT NULL REFERENCES wal_events(id) ON DELETE RESTRICT,
  desired_event_identity_hash TEXT NOT NULL CHECK (desired_event_identity_hash ~ '^[0-9a-f]{64}$'),
  desired_state TEXT NOT NULL CHECK (desired_state IN ('in_progress', 'completed')),
  head_sha TEXT NOT NULL CHECK (head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('success', 'failure', 'neutral')),
  desired_payload JSONB NOT NULL CHECK (jsonb_typeof(desired_payload) = 'object'),
  desired_payload_hash TEXT NOT NULL CHECK (desired_payload_hash ~ '^[0-9a-f]{64}$'),
  external_id TEXT NOT NULL,
  projection_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (projection_status IN ('pending', 'processing', 'retry', 'uncertain', 'projected', 'completed', 'blocked')),
  check_run_id BIGINT,
  provider_head_sha TEXT CHECK (provider_head_sha IS NULL OR provider_head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  provider_request_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((projection_status = 'processing') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((desired_state = 'in_progress' AND conclusion IS NULL)
      OR (desired_state = 'completed' AND conclusion IS NOT NULL)),
  UNIQUE (workspace_id, run_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_github_check_projection_recovery
  ON github_check_run_projections (projection_status, next_attempt_at, updated_at);

CREATE OR REPLACE FUNCTION enforce_terminal_check_projection_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

DROP TRIGGER IF EXISTS trg_terminal_check_projection_immutability ON github_check_run_projections;
CREATE TRIGGER trg_terminal_check_projection_immutability
BEFORE UPDATE ON github_check_run_projections
FOR EACH ROW EXECUTE FUNCTION enforce_terminal_check_projection_immutability();
