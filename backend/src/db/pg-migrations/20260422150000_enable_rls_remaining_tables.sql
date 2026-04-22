-- 20260422150000_enable_rls_remaining_tables.sql
-- Enable Supabase Row Level Security on remaining workspace-scoped tables.
--
-- Notes:
-- - Policies follow the established workspace membership helper:
--     workspace_id IN (SELECT workspace_id FROM get_user_workspace_ids(auth.uid()))
-- - Security-sensitive `workspace_env_vars` uses separate policies per operation.
--   Reads are allowed to any workspace member; writes are restricted to owner/admin.
-- - `spec_versions` and `story_comments` are intentionally not modified here because
--   the current schema in this branch does not support the scoping described in the
--   story brief:
--     * `spec_versions` has no `workspace_id`
--     * `story_comments` has neither `workspace_id` nor `run_id`
--   Adding incorrect policies would either fail at migration time or create a false
--   sense of security. They need a preceding schema migration.
-- - `agent_hook_invocations` is also intentionally skipped because the table does not
--   exist in this branch's current migration set.

ALTER TABLE spec_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS spec_tags_select_workspace_member ON spec_tags;
CREATE POLICY spec_tags_select_workspace_member
  ON spec_tags
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS spec_tags_insert_workspace_member ON spec_tags;
CREATE POLICY spec_tags_insert_workspace_member
  ON spec_tags
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS spec_tags_update_workspace_member ON spec_tags;
CREATE POLICY spec_tags_update_workspace_member
  ON spec_tags
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

DROP POLICY IF EXISTS spec_tags_delete_workspace_member ON spec_tags;
CREATE POLICY spec_tags_delete_workspace_member
  ON spec_tags
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'spec_tag_assignments'
  ) THEN
    EXECUTE 'ALTER TABLE spec_tag_assignments ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS spec_tag_assignments_select_workspace_member ON spec_tag_assignments';
    EXECUTE $policy$
      CREATE POLICY spec_tag_assignments_select_workspace_member
        ON spec_tag_assignments
        FOR SELECT
        TO authenticated
        USING (
          workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS spec_tag_assignments_insert_workspace_member ON spec_tag_assignments';
    EXECUTE $policy$
      CREATE POLICY spec_tag_assignments_insert_workspace_member
        ON spec_tag_assignments
        FOR INSERT
        TO authenticated
        WITH CHECK (
          workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS spec_tag_assignments_update_workspace_member ON spec_tag_assignments';
    EXECUTE $policy$
      CREATE POLICY spec_tag_assignments_update_workspace_member
        ON spec_tag_assignments
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
        )
    $policy$;

    EXECUTE 'DROP POLICY IF EXISTS spec_tag_assignments_delete_workspace_member ON spec_tag_assignments';
    EXECUTE $policy$
      CREATE POLICY spec_tag_assignments_delete_workspace_member
        ON spec_tag_assignments
        FOR DELETE
        TO authenticated
        USING (
          workspace_id IN (
            SELECT workspace_id
            FROM get_user_workspace_ids(auth.uid())
          )
        )
    $policy$;
  END IF;
END $$;


ALTER TABLE story_commits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS story_commits_select_workspace_member ON story_commits;
CREATE POLICY story_commits_select_workspace_member
  ON story_commits
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS story_commits_insert_workspace_member ON story_commits;
CREATE POLICY story_commits_insert_workspace_member
  ON story_commits
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS story_commits_update_workspace_member ON story_commits;
CREATE POLICY story_commits_update_workspace_member
  ON story_commits
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

DROP POLICY IF EXISTS story_commits_delete_workspace_member ON story_commits;
CREATE POLICY story_commits_delete_workspace_member
  ON story_commits
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE pipeline_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_schedules_select_workspace_member ON pipeline_schedules;
CREATE POLICY pipeline_schedules_select_workspace_member
  ON pipeline_schedules
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_schedules_insert_workspace_member ON pipeline_schedules;
CREATE POLICY pipeline_schedules_insert_workspace_member
  ON pipeline_schedules
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_schedules_update_workspace_member ON pipeline_schedules;
CREATE POLICY pipeline_schedules_update_workspace_member
  ON pipeline_schedules
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

DROP POLICY IF EXISTS pipeline_schedules_delete_workspace_member ON pipeline_schedules;
CREATE POLICY pipeline_schedules_delete_workspace_member
  ON pipeline_schedules
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE pipeline_hooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pipeline_hooks_select_workspace_member ON pipeline_hooks;
CREATE POLICY pipeline_hooks_select_workspace_member
  ON pipeline_hooks
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_hooks_insert_workspace_member ON pipeline_hooks;
CREATE POLICY pipeline_hooks_insert_workspace_member
  ON pipeline_hooks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS pipeline_hooks_update_workspace_member ON pipeline_hooks;
CREATE POLICY pipeline_hooks_update_workspace_member
  ON pipeline_hooks
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

DROP POLICY IF EXISTS pipeline_hooks_delete_workspace_member ON pipeline_hooks;
CREATE POLICY pipeline_hooks_delete_workspace_member
  ON pipeline_hooks
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE workspace_env_vars ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_env_vars_select_workspace_member ON workspace_env_vars;
CREATE POLICY workspace_env_vars_select_workspace_member
  ON workspace_env_vars
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_env_vars_insert_workspace_admin ON workspace_env_vars;
CREATE POLICY workspace_env_vars_insert_workspace_admin
  ON workspace_env_vars
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      WHERE wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS workspace_env_vars_update_workspace_admin ON workspace_env_vars;
CREATE POLICY workspace_env_vars_update_workspace_admin
  ON workspace_env_vars
  FOR UPDATE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      WHERE wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  )
  WITH CHECK (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      WHERE wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS workspace_env_vars_delete_workspace_admin ON workspace_env_vars;
CREATE POLICY workspace_env_vars_delete_workspace_admin
  ON workspace_env_vars
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT wm.workspace_id
      FROM workspace_members wm
      WHERE wm.user_auth_id = auth.uid()
        AND wm.role IN ('owner', 'admin')
    )
  );


ALTER TABLE workspace_context ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_context_select_workspace_member ON workspace_context;
CREATE POLICY workspace_context_select_workspace_member
  ON workspace_context
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_context_insert_workspace_member ON workspace_context;
CREATE POLICY workspace_context_insert_workspace_member
  ON workspace_context
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS workspace_context_update_workspace_member ON workspace_context;
CREATE POLICY workspace_context_update_workspace_member
  ON workspace_context
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

DROP POLICY IF EXISTS workspace_context_delete_workspace_member ON workspace_context;
CREATE POLICY workspace_context_delete_workspace_member
  ON workspace_context
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE token_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS token_usage_select_workspace_member ON token_usage;
CREATE POLICY token_usage_select_workspace_member
  ON token_usage
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS token_usage_insert_workspace_member ON token_usage;
CREATE POLICY token_usage_insert_workspace_member
  ON token_usage
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS token_usage_update_workspace_member ON token_usage;
CREATE POLICY token_usage_update_workspace_member
  ON token_usage
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

DROP POLICY IF EXISTS token_usage_delete_workspace_member ON token_usage;
CREATE POLICY token_usage_delete_workspace_member
  ON token_usage
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE budget_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS budget_config_select_workspace_member ON budget_config;
CREATE POLICY budget_config_select_workspace_member
  ON budget_config
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS budget_config_insert_workspace_member ON budget_config;
CREATE POLICY budget_config_insert_workspace_member
  ON budget_config
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS budget_config_update_workspace_member ON budget_config;
CREATE POLICY budget_config_update_workspace_member
  ON budget_config
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

DROP POLICY IF EXISTS budget_config_delete_workspace_member ON budget_config;
CREATE POLICY budget_config_delete_workspace_member
  ON budget_config
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE agent_hooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_hooks_select_workspace_member ON agent_hooks;
CREATE POLICY agent_hooks_select_workspace_member
  ON agent_hooks
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS agent_hooks_insert_workspace_member ON agent_hooks;
CREATE POLICY agent_hooks_insert_workspace_member
  ON agent_hooks
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS agent_hooks_update_workspace_member ON agent_hooks;
CREATE POLICY agent_hooks_update_workspace_member
  ON agent_hooks
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

DROP POLICY IF EXISTS agent_hooks_delete_workspace_member ON agent_hooks;
CREATE POLICY agent_hooks_delete_workspace_member
  ON agent_hooks
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );


ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_profiles_select_workspace_member ON agent_profiles;
CREATE POLICY agent_profiles_select_workspace_member
  ON agent_profiles
  FOR SELECT
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS agent_profiles_insert_workspace_member ON agent_profiles;
CREATE POLICY agent_profiles_insert_workspace_member
  ON agent_profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );

DROP POLICY IF EXISTS agent_profiles_update_workspace_member ON agent_profiles;
CREATE POLICY agent_profiles_update_workspace_member
  ON agent_profiles
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

DROP POLICY IF EXISTS agent_profiles_delete_workspace_member ON agent_profiles;
CREATE POLICY agent_profiles_delete_workspace_member
  ON agent_profiles
  FOR DELETE
  TO authenticated
  USING (
    workspace_id IN (
      SELECT workspace_id
      FROM get_user_workspace_ids(auth.uid())
    )
  );
