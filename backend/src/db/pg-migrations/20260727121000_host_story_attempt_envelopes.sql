-- Host-observed execution attempt identity and outcome authority.
-- The envelope is application-owned evidence. Agent/model output cannot write it,
-- and semantic closeout may consume only a finalized, non-conflicting envelope.

CREATE TABLE IF NOT EXISTS host_story_attempt_envelopes (
  envelope_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rorca.host-story-attempt-envelope.v1'),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL CHECK (btrim(story_id) <> '' AND char_length(story_id) <= 160),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  launch_generation UUID NOT NULL,
  cancellation_fence TEXT NOT NULL CHECK (cancellation_fence ~ '^sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL REFERENCES story_execution_manifests(manifest_hash) ON DELETE RESTRICT,
  spec_id TEXT NOT NULL CHECK (btrim(spec_id) <> '' AND char_length(spec_id) <= 255),
  spec_revision TEXT NOT NULL CHECK (spec_revision ~ '^sha256:[0-9a-f]{64}$'),
  story_revision TEXT NOT NULL CHECK (story_revision ~ '^sha256:[0-9a-f]{64}$'),
  canonical_spec_path TEXT NOT NULL CHECK (
    canonical_spec_path !~ '(^|/)\.\.(/|$)'
    AND canonical_spec_path !~ '^/'
    AND octet_length(canonical_spec_path) <= 4096
  ),
  run_spec_path TEXT NOT NULL CHECK (octet_length(run_spec_path) <= 4096),
  repository_realpath TEXT NOT NULL CHECK (octet_length(repository_realpath) <= 4096),
  repository_identity TEXT NOT NULL CHECK (repository_identity ~ '^sha256:[0-9a-f]{64}$'),
  repository_remote TEXT,
  base_git_sha CHAR(40) NOT NULL CHECK (base_git_sha ~ '^[0-9a-f]{40}$'),
  observed_git_sha CHAR(40) NOT NULL CHECK (observed_git_sha ~ '^[0-9a-f]{40}$'),
  worktree_realpath TEXT NOT NULL CHECK (octet_length(worktree_realpath) <= 4096),
  worktree_identity TEXT NOT NULL CHECK (worktree_identity ~ '^sha256:[0-9a-f]{64}$'),
  worktree_branch TEXT NOT NULL CHECK (btrim(worktree_branch) <> '' AND char_length(worktree_branch) <= 1024),
  runtime_identity JSONB NOT NULL CHECK (
    jsonb_typeof(runtime_identity) = 'object'
    AND octet_length(runtime_identity::text) <= 16384
  ),
  identity_hash TEXT NOT NULL CHECK (identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  authority_state TEXT NOT NULL DEFAULT 'valid' CHECK (authority_state IN ('valid','conflict')),
  outcome TEXT CHECK (outcome IN ('success','nonzero_exit','timeout','cancelled','crash')),
  outcome_provenance TEXT CHECK (outcome_provenance IN ('host_process','host_timeout','host_cancellation','host_recovery')),
  exit_code INTEGER,
  exit_signal TEXT CHECK (exit_signal IS NULL OR char_length(exit_signal) <= 64),
  launched_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  finished_at TIMESTAMPTZ,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (workspace_id, run_id, story_id, attempt, launch_generation),
  UNIQUE (workspace_id, run_id, story_id, attempt),
  CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CHECK (outcome IS NULL OR outcome_provenance IS NOT NULL),
  CHECK (outcome <> 'success' OR (exit_code = 0 AND exit_signal IS NULL)),
  CHECK (outcome <> 'nonzero_exit' OR (exit_code IS NOT NULL AND exit_code <> 0)),
  CHECK (authority_state <> 'conflict' OR outcome IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_host_story_attempt_envelopes_closeout
  ON host_story_attempt_envelopes (run_id, story_id, attempt, launch_generation)
  WHERE authority_state = 'valid' AND outcome IS NOT NULL;

CREATE TABLE IF NOT EXISTS host_story_attempt_conflicts (
  conflict_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  launch_generation UUID NOT NULL,
  existing_identity_hash TEXT CHECK (existing_identity_hash IS NULL OR existing_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  conflicting_identity_hash TEXT NOT NULL CHECK (conflicting_identity_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'payload_changed','stale_generation','spec_revision_mismatch','canonical_path_mismatch',
    'git_revision_mismatch','worktree_identity_mismatch','cancellation_fence_mismatch'
  )),
  observed_payload JSONB NOT NULL CHECK (
    jsonb_typeof(observed_payload) = 'object'
    AND octet_length(observed_payload::text) <= 32768
  ),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_host_story_attempt_conflicts_scope
  ON host_story_attempt_conflicts (run_id, story_id, attempt, observed_at DESC);

CREATE OR REPLACE FUNCTION enforce_host_story_attempt_envelope_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run_row pipeline_runs%ROWTYPE;
  manifest_row story_execution_manifests%ROWTYPE;
BEGIN
  SELECT * INTO run_row FROM pipeline_runs WHERE id = NEW.run_id FOR SHARE;
  IF run_row.id IS NULL
     OR run_row.workspace_id <> NEW.workspace_id
     OR run_row.dispatch_fence IS DISTINCT FROM NEW.cancellation_fence
     OR run_row.spec_path IS DISTINCT FROM NEW.canonical_spec_path
     OR run_row.execution_workspace_path IS DISTINCT FROM NEW.repository_realpath
     OR EXISTS (
       SELECT 1 FROM pipeline_run_cancellation_requests cancellation
        WHERE cancellation.run_id = NEW.run_id
     )
     OR EXISTS (
       SELECT 1 FROM governed_retry_dispatches retry
        WHERE retry.retry_run_id = NEW.run_id
          AND retry.cancellation_requested_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'host attempt envelope differs from active run generation authority'
      USING ERRCODE = '23514';
  END IF;
  SELECT * INTO manifest_row FROM story_execution_manifests WHERE manifest_hash = NEW.manifest_hash FOR SHARE;
  IF manifest_row.manifest_hash IS NULL
     OR manifest_row.workspace_id <> NEW.workspace_id
     OR manifest_row.run_id <> NEW.run_id
     OR manifest_row.story_id <> NEW.story_id
     OR manifest_row.attempt <> NEW.attempt
     OR manifest_row.spec_id <> NEW.spec_id
     OR manifest_row.spec_revision <> NEW.spec_revision
     OR manifest_row.story_revision <> NEW.story_revision THEN
    RAISE EXCEPTION 'host attempt envelope differs from immutable execution manifest'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_host_story_attempt_envelope_insert ON host_story_attempt_envelopes;
CREATE TRIGGER trg_host_story_attempt_envelope_insert
BEFORE INSERT ON host_story_attempt_envelopes
FOR EACH ROW EXECUTE FUNCTION enforce_host_story_attempt_envelope_insert();

CREATE OR REPLACE FUNCTION enforce_host_story_attempt_envelope_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'host attempt envelope is append-only'
      USING ERRCODE = '23514';
  END IF;
  IF ROW(NEW.envelope_id, NEW.schema_version, NEW.workspace_id, NEW.run_id,
         NEW.story_id, NEW.attempt, NEW.launch_generation, NEW.cancellation_fence,
         NEW.manifest_hash, NEW.spec_id, NEW.spec_revision, NEW.story_revision,
         NEW.canonical_spec_path, NEW.run_spec_path, NEW.repository_realpath,
         NEW.repository_identity, NEW.repository_remote, NEW.base_git_sha,
         NEW.observed_git_sha, NEW.worktree_realpath, NEW.worktree_identity,
         NEW.worktree_branch, NEW.runtime_identity, NEW.identity_hash,
         NEW.launched_at, NEW.payload_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.envelope_id, OLD.schema_version, OLD.workspace_id, OLD.run_id,
         OLD.story_id, OLD.attempt, OLD.launch_generation, OLD.cancellation_fence,
         OLD.manifest_hash, OLD.spec_id, OLD.spec_revision, OLD.story_revision,
         OLD.canonical_spec_path, OLD.run_spec_path, OLD.repository_realpath,
         OLD.repository_identity, OLD.repository_remote, OLD.base_git_sha,
         OLD.observed_git_sha, OLD.worktree_realpath, OLD.worktree_identity,
         OLD.worktree_branch, OLD.runtime_identity, OLD.identity_hash,
         OLD.launched_at, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'host attempt envelope immutable identity changed'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.outcome IS NOT NULL AND ROW(NEW.outcome, NEW.outcome_provenance, NEW.exit_code,
       NEW.exit_signal, NEW.finished_at, NEW.authority_state)
     IS DISTINCT FROM ROW(OLD.outcome, OLD.outcome_provenance, OLD.exit_code,
       OLD.exit_signal, OLD.finished_at, OLD.authority_state) THEN
    RAISE EXCEPTION 'finalized host attempt envelope is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_host_story_attempt_envelope_update ON host_story_attempt_envelopes;
CREATE TRIGGER trg_host_story_attempt_envelope_update
BEFORE UPDATE OR DELETE ON host_story_attempt_envelopes
FOR EACH ROW EXECUTE FUNCTION enforce_host_story_attempt_envelope_update();

-- The final semantic accepted decision is fenced in the same database statement
-- that creates it. A host success observed before a later cancellation cannot be
-- replayed across that cancellation boundary.
CREATE OR REPLACE FUNCTION enforce_successful_host_attempt_for_story_closeout()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'accepted' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('pipeline-run-authority:' || NEW.run_id::text, 0));
  END IF;
  IF NEW.status = 'accepted' AND NOT EXISTS (
    SELECT 1
      FROM host_story_attempt_envelopes envelope
      JOIN pipeline_runs run ON run.id = envelope.run_id
     WHERE envelope.workspace_id = NEW.workspace_id
       AND envelope.run_id = NEW.run_id
       AND envelope.story_id = NEW.story_id
       AND envelope.attempt = NEW.attempt
       AND envelope.manifest_hash = NEW.manifest_hash
       AND envelope.authority_state = 'valid'
       AND envelope.outcome = 'success'
       AND envelope.exit_code = 0
       AND envelope.exit_signal IS NULL
       AND run.dispatch_fence = envelope.cancellation_fence
       AND NOT EXISTS (
         SELECT 1 FROM host_story_attempt_conflicts conflict
          WHERE conflict.workspace_id = envelope.workspace_id
            AND conflict.run_id = envelope.run_id
            AND conflict.story_id = envelope.story_id
            AND conflict.attempt = envelope.attempt
       )
       AND NOT EXISTS (
         SELECT 1 FROM pipeline_run_cancellation_requests cancellation
          WHERE cancellation.run_id = run.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM governed_retry_dispatches retry
          WHERE retry.retry_run_id = run.id
            AND retry.cancellation_requested_at IS NOT NULL
       )
  ) THEN
    RAISE EXCEPTION 'accepted story closeout lacks current successful host attempt authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_story_closeout_requires_host_attempt ON story_closeout_decisions;
CREATE TRIGGER trg_story_closeout_requires_host_attempt
BEFORE INSERT ON story_closeout_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_successful_host_attempt_for_story_closeout();
