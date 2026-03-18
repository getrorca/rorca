-- Widen pipeline_runs.id and all referencing run_id columns from INTEGER to BIGINT,
-- then restart the sequence from a timestamp-based value.
-- Old runs (#1–#133) keep their existing IDs untouched.
-- New runs going forward get IDs like 20260316000001, 20260316000002, etc.
-- Mirrors the "don't rename old, apply going forward" split used for migration filenames.

-- 1. Widen pipeline_runs.id (drop default, alter, restore)
ALTER TABLE pipeline_runs ALTER COLUMN id TYPE BIGINT;
ALTER TABLE pipeline_runs ALTER COLUMN retried_from_run_id TYPE BIGINT;

-- 2. Widen all child tables that reference pipeline_runs(id)
ALTER TABLE story_results ALTER COLUMN run_id TYPE BIGINT;
ALTER TABLE run_output_chunks ALTER COLUMN run_id TYPE BIGINT;
ALTER TABLE token_usage ALTER COLUMN run_id TYPE BIGINT;
ALTER TABLE memory_proposals ALTER COLUMN run_id TYPE BIGINT;
-- 3. Widen the sequence itself from INT4 to BIGINT (column type alone isn't enough)
ALTER SEQUENCE pipeline_runs_id_seq AS BIGINT;

-- 4. Restart sequence from timestamp-based start value
SELECT setval('pipeline_runs_id_seq', 20260316000000);
