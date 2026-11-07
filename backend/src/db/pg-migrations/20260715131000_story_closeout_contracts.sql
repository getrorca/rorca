-- 20260715130000_story_closeout_contracts.sql
-- LFC-008: immutable story execution manifests and append-only closeout audit records.
-- Normalized gate evidence remains in ssdlc_lifecycle_evidence; these tables store
-- contract snapshots/results/decisions, not a second lifecycle or evidence engine.

-- Legacy webhook commits remain nullable-run records. Engine/closeout commits are
-- bound to the exact run and story branch instead of workspace HEAD.
ALTER TABLE story_commits
  ADD COLUMN IF NOT EXISTS run_id BIGINT REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS branch_name TEXT,
  ADD COLUMN IF NOT EXISTS observed_source TEXT NOT NULL DEFAULT 'github_webhook';

ALTER TABLE story_commits DROP CONSTRAINT IF EXISTS story_commits_story_id_spec_id_commit_sha_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_commits_scoped_sha
  ON story_commits (workspace_id, spec_id, COALESCE(run_id, 0), story_id, commit_sha);
CREATE INDEX IF NOT EXISTS idx_story_commits_closeout_scope
  ON story_commits (workspace_id, spec_id, run_id, story_id, pushed_at DESC);

CREATE TABLE IF NOT EXISTS story_execution_manifests (
  manifest_hash TEXT PRIMARY KEY CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  schema_version TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  spec_revision TEXT NOT NULL,
  story_revision TEXT NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, spec_id, run_id, story_id, attempt)
);

CREATE TABLE IF NOT EXISTS story_attempt_results (
  attempt_result_id TEXT PRIMARY KEY CHECK (attempt_result_id ~ '^ATR-sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL REFERENCES story_execution_manifests(manifest_hash),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manifest_hash),
  UNIQUE (workspace_id, spec_id, run_id, story_id, attempt)
);

CREATE TABLE IF NOT EXISTS story_closeout_decisions (
  decision_id TEXT PRIMARY KEY CHECK (decision_id ~ '^CLO-sha256:[0-9a-f]{64}$'),
  manifest_hash TEXT NOT NULL REFERENCES story_execution_manifests(manifest_hash),
  attempt_result_id TEXT NOT NULL REFERENCES story_attempt_results(attempt_result_id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'blocked')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (attempt_result_id, decision_id)
);

CREATE INDEX IF NOT EXISTS idx_story_execution_manifests_scope
  ON story_execution_manifests (workspace_id, spec_id, run_id, story_id, attempt);
CREATE INDEX IF NOT EXISTS idx_story_attempt_results_scope
  ON story_attempt_results (workspace_id, spec_id, run_id, story_id, attempt);
CREATE INDEX IF NOT EXISTS idx_story_closeout_decisions_scope
  ON story_closeout_decisions (workspace_id, spec_id, run_id, story_id, attempt, created_at);
