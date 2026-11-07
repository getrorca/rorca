-- Widen pipeline_runs.id and all referencing run_id columns from INTEGER to BIGINT,
-- then restart the sequence from a timestamp-based value.
-- Old runs (#1–#133) keep their existing IDs untouched.
-- New runs going forward get IDs like 20260316000001, 20260316000002, etc.
-- Mirrors the "don't rename old, apply going forward" split used for migration filenames.

-- 1. Widen pipeline_runs.id (guarded for reruns on already-upgraded databases)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rorca' AND table_name = 'pipeline_runs' AND column_name = 'id' AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE pipeline_runs ALTER COLUMN id TYPE BIGINT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rorca' AND table_name = 'pipeline_runs' AND column_name = 'retried_from_run_id' AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE pipeline_runs ALTER COLUMN retried_from_run_id TYPE BIGINT;
  END IF;
END $$;

-- 2. Widen all child tables that reference pipeline_runs(id)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rorca' AND table_name = 'story_results' AND column_name = 'run_id' AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE story_results ALTER COLUMN run_id TYPE BIGINT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rorca' AND table_name = 'run_output_chunks' AND column_name = 'run_id' AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE run_output_chunks ALTER COLUMN run_id TYPE BIGINT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rorca' AND table_name = 'token_usage' AND column_name = 'run_id' AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE token_usage ALTER COLUMN run_id TYPE BIGINT;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'rorca' AND table_name = 'memory_proposals' AND column_name = 'run_id' AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE memory_proposals ALTER COLUMN run_id TYPE BIGINT;
  END IF;
END $$;

-- 3. Widen the sequence itself from INT4 to BIGINT (column type alone isn't enough)
ALTER SEQUENCE pipeline_runs_id_seq AS BIGINT;

-- 4. Restart sequence from timestamp-based start value, but never move it backwards.
SELECT setval('pipeline_runs_id_seq', GREATEST((SELECT last_value FROM pipeline_runs_id_seq), 20260316000000));
