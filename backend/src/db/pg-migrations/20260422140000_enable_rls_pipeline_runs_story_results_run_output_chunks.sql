-- 20260422140000_enable_rls_pipeline_runs_story_results_run_output_chunks.sql
-- Enable Supabase Row Level Security on high-traffic pipeline execution tables.
--
-- Design notes:
-- - `pipeline_runs` is directly workspace-scoped via `workspace_id`.
-- - `story_results` and `run_output_chunks` inherit that scope transitively via
--   `run_id IN (SELECT id FROM pipeline_runs)`, allowing PostgreSQL/Supabase to
--   apply `pipeline_runs` RLS once and reuse the filtered ID set efficiently.
-- - Policies intentionally use `IN (SELECT ...)` instead of correlated `EXISTS`
--   to avoid per-row function-call overhead on these hot tables.
-- - `worker_heartbeat` remains service-role/internal only and is intentionally
--   left without user-facing RLS policies.
--
-- NOTE: FORCE ROW LEVEL SECURITY is intentionally deferred here as well.
-- The application pool/service role currently relies on owner/bypass semantics
-- for internal writes from the backend worker and execution engine.

ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_runs_select_workspace_member ON pipeline_runs;
CREATE POLICY pipeline_runs_select_workspace_member
  ON pipeline_runs
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_runs_insert_workspace_member ON pipeline_runs;
CREATE POLICY pipeline_runs_insert_workspace_member
  ON pipeline_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_runs_update_workspace_member ON pipeline_runs;
CREATE POLICY pipeline_runs_update_workspace_member
  ON pipeline_runs
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_runs_delete_workspace_member ON pipeline_runs;
CREATE POLICY pipeline_runs_delete_workspace_member
  ON pipeline_runs
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE story_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS story_results_select_via_pipeline_runs ON story_results;
CREATE POLICY story_results_select_via_pipeline_runs
  ON story_results
  FOR SELECT
  TO authenticated
  USING (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );

DROP POLICY IF EXISTS story_results_insert_via_pipeline_runs ON story_results;
CREATE POLICY story_results_insert_via_pipeline_runs
  ON story_results
  FOR INSERT
  TO authenticated
  WITH CHECK (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );

DROP POLICY IF EXISTS story_results_update_via_pipeline_runs ON story_results;
CREATE POLICY story_results_update_via_pipeline_runs
  ON story_results
  FOR UPDATE
  TO authenticated
  USING (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  )
  WITH CHECK (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );

DROP POLICY IF EXISTS story_results_delete_via_pipeline_runs ON story_results;
CREATE POLICY story_results_delete_via_pipeline_runs
  ON story_results
  FOR DELETE
  TO authenticated
  USING (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );


ALTER TABLE run_output_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_output_chunks_select_via_pipeline_runs ON run_output_chunks;
CREATE POLICY run_output_chunks_select_via_pipeline_runs
  ON run_output_chunks
  FOR SELECT
  TO authenticated
  USING (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );

DROP POLICY IF EXISTS run_output_chunks_insert_via_pipeline_runs ON run_output_chunks;
CREATE POLICY run_output_chunks_insert_via_pipeline_runs
  ON run_output_chunks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );

DROP POLICY IF EXISTS run_output_chunks_update_via_pipeline_runs ON run_output_chunks;
CREATE POLICY run_output_chunks_update_via_pipeline_runs
  ON run_output_chunks
  FOR UPDATE
  TO authenticated
  USING (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  )
  WITH CHECK (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );

DROP POLICY IF EXISTS run_output_chunks_delete_via_pipeline_runs ON run_output_chunks;
CREATE POLICY run_output_chunks_delete_via_pipeline_runs
  ON run_output_chunks
  FOR DELETE
  TO authenticated
  USING (
    run_id IN (
      SELECT id
      FROM pipeline_runs
    )
  );
