-- Ensure the Supabase/authenticated role can actually hit RLS-protected tables.
--
-- RLS policies alone are not sufficient: the role also needs base table privileges.
-- In some local/self-hosted environments, the authenticated role exists but is
-- missing SELECT/INSERT/UPDATE/DELETE grants, which causes runtime failures like:
--   permission denied for table workspaces
-- before RLS policies are even evaluated.

GRANT USAGE ON SCHEMA rorca TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  workspaces,
  workspace_members,
  pipeline_runs,
  story_results,
  run_output_chunks,
  spec_tags,
  story_commits,
  pipeline_schedules,
  pipeline_hooks,
  workspace_env_vars,
  workspace_context,
  token_usage,
  budget_config,
  agent_hooks,
  agent_profiles,
  user_settings,
  notification_preferences,
  notifications,
  subscriptions,
  direction_layers,
  wal_events,
  teams,
  team_members,
  team_invites,
  api_key_vault,
  workspace_github_webhooks,
  provider_defaults,
  openrouter_provider_prefs
TO authenticated;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'rorca'
      AND table_name = 'spec_tag_assignments'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE spec_tag_assignments TO authenticated';
  END IF;
END $$;
