-- Replayable application-owned publication authority for TaskManifest runs.
-- pg-boss remains dispatch-only and owns all pgboss.* state.

CREATE TABLE IF NOT EXISTS task_manifest_dispatch_publications (
  run_id BIGINT PRIMARY KEY REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  queue_name TEXT NOT NULL DEFAULT 'pipeline:run' CHECK (queue_name = 'pipeline:run'),
  boss_job_id UUID NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('preparing','published')),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  payload_hash TEXT CHECK (payload_hash IS NULL OR payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((state = 'preparing' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND published_at IS NULL)
      OR (state = 'published' AND lease_owner IS NULL AND lease_expires_at IS NULL AND payload_hash IS NOT NULL AND published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_task_manifest_dispatch_publication_recovery
  ON task_manifest_dispatch_publications(state, lease_expires_at)
  WHERE state = 'preparing';
