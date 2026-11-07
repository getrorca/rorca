-- Restore the registered application runtime path through pipeline_runs RLS.
-- Request-role policies remain unchanged; the worker and route application pool
-- continue to run as the distinct, non-bypass internal-runtime principal.

ALTER TABLE rorca.pipeline_runs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1
         FROM rorca.wave2_database_principals
        WHERE database_user = runtime_user
          AND principal_class = 'internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered Wave 2 runtime principal is required'
      USING ERRCODE = '42501';
  END IF;

  DROP POLICY IF EXISTS pipeline_runs_internal_runtime_select ON rorca.pipeline_runs;
  DROP POLICY IF EXISTS pipeline_runs_internal_runtime_insert ON rorca.pipeline_runs;
  DROP POLICY IF EXISTS pipeline_runs_internal_runtime_update ON rorca.pipeline_runs;
  DROP POLICY IF EXISTS pipeline_runs_internal_runtime_delete ON rorca.pipeline_runs;

  EXECUTE format(
    'CREATE POLICY pipeline_runs_internal_runtime_select ON rorca.pipeline_runs FOR SELECT TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY pipeline_runs_internal_runtime_insert ON rorca.pipeline_runs FOR INSERT TO %I WITH CHECK (current_user = %L)',
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY pipeline_runs_internal_runtime_update ON rorca.pipeline_runs FOR UPDATE TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    runtime_user,
    runtime_user,
    runtime_user
  );
  EXECUTE format(
    'CREATE POLICY pipeline_runs_internal_runtime_delete ON rorca.pipeline_runs FOR DELETE TO %I USING (current_user = %L)',
    runtime_user,
    runtime_user
  );
END;
$$;
