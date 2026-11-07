-- Copyright (c) 2026 Rorca Inc.
-- SPDX-License-Identifier: Apache-2.0
-- Licensed under the Apache License, Version 2.0.
-- See LICENSE file in the project root for full license text.

BEGIN;

-- Legacy rows may predate the remediation-3/4 observations, so the constraint
-- is intentionally NOT VALID. PostgreSQL still enforces it for every new or
-- updated row; semantic selectors below separately reject old null envelopes.
ALTER TABLE host_story_attempt_envelopes
  DROP CONSTRAINT IF EXISTS host_story_attempt_envelopes_complete_success_authority_check;
ALTER TABLE host_story_attempt_envelopes
  ADD CONSTRAINT host_story_attempt_envelopes_complete_success_authority_check CHECK (
    outcome IS DISTINCT FROM 'success' OR (
      outcome_provenance = 'host_process'
      AND exit_code = 0
      AND exit_signal IS NULL
      AND canonical_spec_revision IS NOT NULL
      AND canonical_spec_revision ~ '^sha256:[0-9a-f]{64}$'
      AND canonical_spec_bytes_hash IS NOT NULL
      AND canonical_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$'
      AND run_spec_revision IS NOT NULL
      AND run_spec_revision ~ '^sha256:[0-9a-f]{64}$'
      AND run_spec_bytes_hash IS NOT NULL
      AND run_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$'
      AND spec_revision = run_spec_revision
      AND story_revision ~ '^sha256:[0-9a-f]{64}$'
      AND base_git_sha ~ '^[0-9a-f]{40}$'
      AND expected_git_sha IS NOT NULL
      AND expected_git_sha ~ '^[0-9a-f]{40}$'
      AND observed_git_sha = expected_git_sha
      AND expected_git_branch IS NOT NULL
      AND length(btrim(expected_git_branch)) > 0
      AND worktree_branch = expected_git_branch
    )
  ) NOT VALID;

-- Every identity field introduced through remediation 4 is immutable, including
-- canonical/run-spec revisions and bytes, story labels, and expected/observed
-- Git SHA, branch, and represented ancestry authority.
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
         NEW.canonical_spec_path, NEW.canonical_spec_revision,
         NEW.canonical_spec_bytes_hash, NEW.run_spec_path, NEW.run_spec_revision,
         NEW.run_spec_bytes_hash, NEW.repository_realpath,
         NEW.repository_identity, NEW.repository_remote, NEW.base_git_sha,
         NEW.expected_git_sha, NEW.observed_git_sha, NEW.expected_git_branch,
         NEW.worktree_realpath, NEW.worktree_identity, NEW.worktree_branch,
         NEW.runtime_identity, NEW.identity_hash, NEW.launched_at,
         NEW.payload_hash, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.envelope_id, OLD.schema_version, OLD.workspace_id, OLD.run_id,
         OLD.story_id, OLD.attempt, OLD.launch_generation, OLD.cancellation_fence,
         OLD.manifest_hash, OLD.spec_id, OLD.spec_revision, OLD.story_revision,
         OLD.canonical_spec_path, OLD.canonical_spec_revision,
         OLD.canonical_spec_bytes_hash, OLD.run_spec_path, OLD.run_spec_revision,
         OLD.run_spec_bytes_hash, OLD.repository_realpath,
         OLD.repository_identity, OLD.repository_remote, OLD.base_git_sha,
         OLD.expected_git_sha, OLD.observed_git_sha, OLD.expected_git_branch,
         OLD.worktree_realpath, OLD.worktree_identity, OLD.worktree_branch,
         OLD.runtime_identity, OLD.identity_hash, OLD.launched_at,
         OLD.payload_hash, OLD.created_at) THEN
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

-- Attempt conflicts are canonical poisoning evidence, not mutable diagnostics.
CREATE OR REPLACE FUNCTION enforce_host_story_attempt_conflict_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'host attempt conflict evidence is append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_host_story_attempt_conflict_append_only ON host_story_attempt_conflicts;
CREATE TRIGGER trg_host_story_attempt_conflict_append_only
BEFORE UPDATE OR DELETE ON host_story_attempt_conflicts
FOR EACH ROW EXECUTE FUNCTION enforce_host_story_attempt_conflict_append_only();

-- Recreate the accepted-closeout gate so legacy/null or internally inconsistent
-- successful envelopes can never become newly consumable semantic authority.
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
       AND envelope.outcome_provenance = 'host_process'
       AND envelope.exit_code = 0
       AND envelope.exit_signal IS NULL
       AND envelope.canonical_spec_revision IS NOT NULL
       AND envelope.canonical_spec_revision ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.canonical_spec_bytes_hash IS NOT NULL
       AND envelope.canonical_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.run_spec_revision IS NOT NULL
       AND envelope.run_spec_revision ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.run_spec_bytes_hash IS NOT NULL
       AND envelope.run_spec_bytes_hash ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.spec_revision = envelope.run_spec_revision
       AND envelope.story_revision ~ '^sha256:[0-9a-f]{64}$'
       AND envelope.base_git_sha ~ '^[0-9a-f]{40}$'
       AND envelope.expected_git_sha IS NOT NULL
       AND envelope.expected_git_sha ~ '^[0-9a-f]{40}$'
       AND envelope.observed_git_sha = envelope.expected_git_sha
       AND envelope.expected_git_branch IS NOT NULL
       AND length(btrim(envelope.expected_git_branch)) > 0
       AND envelope.worktree_branch = envelope.expected_git_branch
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

COMMIT;
