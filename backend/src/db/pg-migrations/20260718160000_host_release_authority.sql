-- 20260718160000_host_release_authority.sql
-- Freeze execution realpaths and add one restart-safe host release/terminal intent.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS execution_workspace_path TEXT,
  ADD COLUMN IF NOT EXISTS execution_worktree_path TEXT,
  ADD COLUMN IF NOT EXISTS predecessor_pass_story_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS predecessor_authority_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS terminal_checkout_sha CHAR(40),
  ADD COLUMN IF NOT EXISTS terminal_checkout_attested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS worktree_cleanup_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS worktree_cleaned_at TIMESTAMPTZ;

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_predecessor_authority_ck,
  ADD CONSTRAINT pipeline_runs_predecessor_authority_ck CHECK (
    array_position(predecessor_pass_story_ids, NULL) IS NULL
    AND cardinality(predecessor_pass_story_ids) <= 10000
    AND (cardinality(predecessor_pass_story_ids) = 0) = (predecessor_authority_hash IS NULL)
    AND (predecessor_authority_hash IS NULL OR predecessor_authority_hash ~ '^[0-9a-f]{64}$')
  ),
  DROP CONSTRAINT IF EXISTS pipeline_runs_terminal_checkout_sha_ck,
  ADD CONSTRAINT pipeline_runs_terminal_checkout_sha_ck
    CHECK (terminal_checkout_sha IS NULL OR terminal_checkout_sha ~ '^[0-9a-f]{40}$'),
  DROP CONSTRAINT IF EXISTS pipeline_runs_terminal_checkout_pair_ck,
  ADD CONSTRAINT pipeline_runs_terminal_checkout_pair_ck CHECK (
    (terminal_checkout_sha IS NULL) = (terminal_checkout_attested_at IS NULL)
  ),
  DROP CONSTRAINT IF EXISTS pipeline_runs_worktree_cleanup_status_ck,
  ADD CONSTRAINT pipeline_runs_worktree_cleanup_status_ck
    CHECK (worktree_cleanup_status IN ('not_started', 'pending', 'completed', 'failed'));

-- Historical path strings are retained only as fail-closed compatibility data.
-- New dispatches overwrite these columns with host-resolved realpaths before the
-- frozen expected scope is set.
UPDATE pipeline_runs pr
   SET execution_workspace_path = COALESCE(pr.execution_workspace_path, ws.path),
       execution_worktree_path = COALESCE(pr.execution_worktree_path, pr.worktree_path, ws.path)
  FROM workspaces ws
 WHERE ws.id = pr.workspace_id
   AND (pr.execution_workspace_path IS NULL OR pr.execution_worktree_path IS NULL);

CREATE TABLE IF NOT EXISTS pipeline_run_release_intents (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  authorized_sha CHAR(40) NOT NULL CHECK (authorized_sha ~ '^[0-9a-f]{40}$'),
  branch_name TEXT NOT NULL,
  execution_workspace_path TEXT NOT NULL,
  execution_worktree_path TEXT NOT NULL,
  repository_owner TEXT,
  repository_name TEXT,
  repository_authority_source TEXT CHECK (
    repository_authority_source IS NULL
    OR repository_authority_source IN ('github-app-installation', 'pat-oauth-fallback')
  ),
  repository_binding_id UUID,
  repository_installation_id BIGINT,
  repository_id BIGINT,
  merge_strategy TEXT NOT NULL CHECK (merge_strategy IN ('direct', 'pr', 'draft-pr', 'branch-only')),
  auto_merge BOOLEAN NOT NULL,
  external_send BOOLEAN NOT NULL,
  deployment_allowed BOOLEAN NOT NULL DEFAULT FALSE CHECK (deployment_allowed = FALSE),
  identity_hash CHAR(64) NOT NULL CHECK (identity_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'blocked')),
  step_state JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(step_state) = 'object'),
  base_before_sha CHAR(40) CHECK (base_before_sha IS NULL OR base_before_sha ~ '^[0-9a-f]{40}$'),
  merge_commit_sha CHAR(40) CHECK (merge_commit_sha IS NULL OR merge_commit_sha ~ '^[0-9a-f]{40}$'),
  terminal_event_id INTEGER REFERENCES wal_events(id) ON DELETE RESTRICT,
  last_error_code TEXT,
  last_error_message TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_run_release_intents_recovery
  ON pipeline_run_release_intents (status, updated_at, run_id);

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
  ) THEN
    RAISE EXCEPTION 'pipeline run release intent authority identity is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pipeline_run_release_intent_identity ON pipeline_run_release_intents;
CREATE TRIGGER trg_pipeline_run_release_intent_identity
BEFORE UPDATE ON pipeline_run_release_intents
FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_run_release_intent_identity();

CREATE OR REPLACE FUNCTION enforce_pipeline_run_release_authority_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.expected_story_ids IS NOT NULL AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.spec_path IS DISTINCT FROM OLD.spec_path
    OR NEW.expected_story_ids IS DISTINCT FROM OLD.expected_story_ids
    OR NEW.excluded_story_ids IS DISTINCT FROM OLD.excluded_story_ids
    OR NEW.branch_name IS DISTINCT FROM OLD.branch_name
    OR NEW.worktree_path IS DISTINCT FROM OLD.worktree_path
    OR NEW.execution_workspace_path IS DISTINCT FROM OLD.execution_workspace_path
    OR NEW.execution_worktree_path IS DISTINCT FROM OLD.execution_worktree_path
    OR NEW.retried_from_run_id IS DISTINCT FROM OLD.retried_from_run_id
    OR NEW.predecessor_pass_story_ids IS DISTINCT FROM OLD.predecessor_pass_story_ids
    OR NEW.predecessor_authority_hash IS DISTINCT FROM OLD.predecessor_authority_hash
    OR (OLD.terminal_checkout_sha IS NOT NULL
        AND NEW.terminal_checkout_sha IS DISTINCT FROM OLD.terminal_checkout_sha)
    OR (OLD.terminal_checkout_attested_at IS NOT NULL
        AND NEW.terminal_checkout_attested_at IS DISTINCT FROM OLD.terminal_checkout_attested_at)
  ) THEN
    RAISE EXCEPTION 'pipeline run frozen release authority is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Tighten new writes without rejecting historical 64-hex rows during upgrade.
ALTER TABLE story_results
  DROP CONSTRAINT IF EXISTS story_results_integrated_commit_ck,
  ADD CONSTRAINT story_results_integrated_commit_ck CHECK (
    NOT integrated OR (
      status = 'pass' AND commit_sha ~ '^[0-9a-f]{40}$'
      AND NULLIF(commit_message, '') IS NOT NULL
      AND NULLIF(commit_author, '') IS NOT NULL
      AND NULLIF(commit_branch, '') IS NOT NULL
      AND NULLIF(commit_observed_source, '') IS NOT NULL
    )
  ) NOT VALID;

ALTER TABLE github_check_run_projections
  DROP CONSTRAINT IF EXISTS github_check_run_projections_head_sha_check,
  ADD CONSTRAINT github_check_run_projections_head_sha_check
    CHECK (head_sha ~ '^[0-9a-f]{40}$') NOT VALID,
  DROP CONSTRAINT IF EXISTS github_check_run_projections_provider_head_sha_check,
  ADD CONSTRAINT github_check_run_projections_provider_head_sha_check
    CHECK (provider_head_sha IS NULL OR provider_head_sha ~ '^[0-9a-f]{40}$') NOT VALID;
