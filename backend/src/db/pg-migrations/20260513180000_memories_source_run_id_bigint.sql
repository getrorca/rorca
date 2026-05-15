-- memories.source_run_id must support bigint pipeline run ids (e.g. 20260316000301).
-- The original INTEGER column overflows once run ids exceed 32-bit range.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'rorca'
      AND table_name = 'memories'
      AND column_name = 'source_run_id'
      AND data_type <> 'bigint'
  ) THEN
    ALTER TABLE rorca.memories
      ALTER COLUMN source_run_id TYPE BIGINT USING source_run_id::bigint;
  END IF;
END $$;
