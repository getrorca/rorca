-- Fix story_output_chunks.run_id from INT to BIGINT
-- Required because pipeline_runs.id is BIGINT (timestamp-based IDs > 2^31)
ALTER TABLE story_output_chunks ALTER COLUMN run_id TYPE BIGINT;
