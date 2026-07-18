-- 20260718150000_github_run_authority_remediation.sql
-- Freeze host-owned exclusion policy and immutable Git release checkout identity.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS excluded_story_ids TEXT[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_excluded_story_ids_ck,
  ADD CONSTRAINT pipeline_runs_excluded_story_ids_ck CHECK (
    array_position(excluded_story_ids, NULL) IS NULL
    AND cardinality(excluded_story_ids) <= 10000
  ),
  DROP CONSTRAINT IF EXISTS pipeline_runs_frozen_scope_disjoint_ck,
  ADD CONSTRAINT pipeline_runs_frozen_scope_disjoint_ck CHECK (
    expected_story_ids IS NULL
    OR NOT (expected_story_ids && excluded_story_ids)
  );

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
  ) THEN
    RAISE EXCEPTION 'pipeline run frozen release authority is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pipeline_run_release_authority_immutability ON pipeline_runs;
CREATE TRIGGER trg_pipeline_run_release_authority_immutability
BEFORE UPDATE ON pipeline_runs
FOR EACH ROW EXECUTE FUNCTION enforce_pipeline_run_release_authority_immutability();
