-- Async chunked spec generation job tracker.
-- Replaces in-memory job state with durable Postgres storage
-- for horizontal scalability and crash-resilience.

SET search_path TO rorca, public;

CREATE TABLE IF NOT EXISTS spec_generation_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','done','failed')),
  brief         TEXT NOT NULL,
  title         TEXT,
  slug          TEXT,
  story_count   INT NOT NULL,
  model         TEXT,
  provider      TEXT,
  chunks_total  INT,
  chunks_done   INT NOT NULL DEFAULT 0,
  outline       JSONB,
  result        JSONB,
  spec_path     TEXT,
  error         TEXT,
  context_summary JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spec_gen_jobs_workspace
  ON spec_generation_jobs (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_spec_gen_jobs_created
  ON spec_generation_jobs (created_at DESC);

-- Restore search_path for migration runner (pg-index.ts expects public)
SET search_path TO public;
