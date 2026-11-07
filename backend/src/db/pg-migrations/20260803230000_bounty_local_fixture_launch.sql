-- One-use provider-human authority for local-fixture mission launch.
CREATE TABLE IF NOT EXISTS bounty_local_fixture_launch_approvals (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  program_id UUID NOT NULL,
  mission_id UUID NOT NULL,
  target_hash TEXT NOT NULL CHECK (target_hash ~ '^sha256:[0-9a-f]{64}$'),
  exact_target JSONB NOT NULL,
  provider_event JSONB NOT NULL,
  provider_key_hash TEXT NOT NULL CHECK (provider_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  consumed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, target_hash),
  FOREIGN KEY (workspace_id, program_id) REFERENCES bounty_programs(workspace_id, id)
);

CREATE OR REPLACE FUNCTION reject_bounty_local_launch_approval_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'local fixture launch approvals are immutable'; END $$;
DROP TRIGGER IF EXISTS bounty_local_launch_approvals_immutable ON bounty_local_fixture_launch_approvals;
CREATE TRIGGER bounty_local_launch_approvals_immutable BEFORE UPDATE OR DELETE ON bounty_local_fixture_launch_approvals
FOR EACH ROW EXECUTE FUNCTION reject_bounty_local_launch_approval_mutation();
