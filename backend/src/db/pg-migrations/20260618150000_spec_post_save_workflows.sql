-- 20260618150000_spec_post_save_workflows.sql — Durable post-save workflow graph persistence.
-- Persists workflow runs, stages, and dependency edges so generation-log JSON is no longer the source of truth.

CREATE TABLE IF NOT EXISTS spec_post_save_workflow_runs (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  spec_id TEXT NOT NULL,
  generation_log_id INTEGER REFERENCES spec_generation_logs(id) ON DELETE SET NULL,
  save_generation BIGINT,
  effective_policy_hash TEXT NOT NULL,
  effective_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'cancelled', 'superseded')),
  source TEXT NOT NULL DEFAULT 'persist-post-save',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT spec_post_save_workflow_runs_idempotency_unique
    UNIQUE (workspace_id, spec_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS spec_post_save_workflow_stages (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES spec_post_save_workflow_runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL
    CHECK (stage_key IN ('context', 'enrich', 'matchSkills', 'memorySynthesis')),
  requested BOOLEAN NOT NULL DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'running', 'completed', 'failed', 'skipped', 'superseded')),
  reason TEXT NOT NULL DEFAULT 'requested_by_caller',
  job_id UUID REFERENCES spec_jobs(id) ON DELETE SET NULL,
  boss_job_id TEXT,
  queue_name TEXT,
  queue_status TEXT CHECK (queue_status IS NULL OR queue_status IN ('waiting', 'queued', 'running')),
  queue_position INTEGER CHECK (queue_position IS NULL OR queue_position >= 0),
  active_jobs_ahead INTEGER CHECK (active_jobs_ahead IS NULL OR active_jobs_ahead >= 0),
  queue_priority INTEGER,
  singleton_key TEXT,
  fingerprint TEXT,
  previous_fingerprint TEXT,
  error_message TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT spec_post_save_workflow_stages_run_stage_unique UNIQUE (run_id, stage_key)
);

CREATE TABLE IF NOT EXISTS spec_post_save_stage_dependencies (
  run_id BIGINT NOT NULL REFERENCES spec_post_save_workflow_runs(id) ON DELETE CASCADE,
  stage_key TEXT NOT NULL,
  depends_on_stage_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (run_id, stage_key, depends_on_stage_key),
  CONSTRAINT spec_post_save_stage_dependencies_distinct
    CHECK (stage_key <> depends_on_stage_key),
  CONSTRAINT spec_post_save_stage_dependencies_stage_fk
    FOREIGN KEY (run_id, stage_key)
    REFERENCES spec_post_save_workflow_stages(run_id, stage_key)
    ON DELETE CASCADE,
  CONSTRAINT spec_post_save_stage_dependencies_depends_fk
    FOREIGN KEY (run_id, depends_on_stage_key)
    REFERENCES spec_post_save_workflow_stages(run_id, stage_key)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_spec_post_save_runs_active_policy_unique
  ON spec_post_save_workflow_runs(workspace_id, spec_id, effective_policy_hash)
  WHERE status IN ('pending', 'queued', 'running');

CREATE INDEX IF NOT EXISTS idx_spec_post_save_runs_spec_latest
  ON spec_post_save_workflow_runs(spec_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_spec_post_save_runs_workspace_spec_latest
  ON spec_post_save_workflow_runs(workspace_id, spec_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_spec_post_save_runs_generation
  ON spec_post_save_workflow_runs(spec_id, save_generation)
  WHERE save_generation IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spec_post_save_stages_run_status
  ON spec_post_save_workflow_stages(run_id, status);

CREATE INDEX IF NOT EXISTS idx_spec_post_save_stages_job
  ON spec_post_save_workflow_stages(job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_spec_post_save_stage_dependencies_depends
  ON spec_post_save_stage_dependencies(run_id, depends_on_stage_key);
