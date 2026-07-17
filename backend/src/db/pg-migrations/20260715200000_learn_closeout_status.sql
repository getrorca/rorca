-- 20260715200000_learn_closeout_status.sql
-- LFC-027: bounded producer status for the existing memory_candidates review queue.
-- No memory/review table is introduced; lifecycle phase state remains derived.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS learn_closeout_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS learn_closeout_blocker JSONB,
  ADD COLUMN IF NOT EXISTS learn_closeout_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS learn_candidate_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS learn_candidate_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS learn_source_evidence_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_learn_closeout_status_check') THEN
    ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_learn_closeout_status_check
      CHECK (learn_closeout_status IN ('not_started', 'generated', 'blocked'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_learn_closeout_counts_check') THEN
    ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_learn_closeout_counts_check
      CHECK (learn_candidate_count >= 0 AND learn_source_evidence_count >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_learn_closeout_blocker_check') THEN
    ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_learn_closeout_blocker_check
      CHECK (learn_closeout_blocker IS NULL OR jsonb_typeof(learn_closeout_blocker) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_runs_learn_candidate_ids_check') THEN
    ALTER TABLE pipeline_runs ADD CONSTRAINT pipeline_runs_learn_candidate_ids_check
      CHECK (jsonb_typeof(learn_candidate_ids) = 'array' AND jsonb_array_length(learn_candidate_ids) <= 24);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_learn_closeout
  ON pipeline_runs (workspace_id, learn_closeout_status, id DESC);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_lifecycle_closeout
  ON memory_candidates (workspace_id, ((provenance->>'specId')), created_at DESC)
  WHERE provenance->>'kind' = 'lifecycle_closeout';
