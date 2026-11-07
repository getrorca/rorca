-- Disposable REA-001 populated-upgrade fixture.
-- Set rorca.execution_authority_fixture_workspace before executing this file.
-- This fixture intentionally uses only tables that predate the authority migration.

INSERT INTO rorca.workspaces (id, label, path, domains, pipeline_config)
VALUES (
  current_setting('rorca.execution_authority_fixture_workspace'),
  'Execution Authority populated upgrade fixture',
  '/tmp/rorca-execution-authority-upgrade-fixture',
  '["rorca-platform"]',
  '{"fixture":"rea-001-populated-upgrade"}'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rorca.pipeline_runs (spec_path, workspace_id, status, trigger_type, branch_name)
VALUES (
  'forge/specs/approved/execution-authority-populated-upgrade.json',
  current_setting('rorca.execution_authority_fixture_workspace'),
  'queued',
  'manual',
  'rorca/rea-001-populated-upgrade-fixture'
);
