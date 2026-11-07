-- Durable opaque credential handles and Caido/evidence integration receipts.
CREATE TABLE IF NOT EXISTS bounty_credential_handles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), handle_hash TEXT UNIQUE NOT NULL CHECK (handle_hash ~ '^sha256:[0-9a-f]{64}$'),
  workspace_id TEXT NOT NULL, program_id UUID NOT NULL, mission_id UUID NOT NULL REFERENCES bounty_missions(id),
  account_id TEXT NOT NULL, role_name TEXT NOT NULL, origin TEXT NOT NULL, actions JSONB NOT NULL,
  adapter TEXT NOT NULL, authority_epoch BIGINT NOT NULL CHECK (authority_epoch > 0), expires_at TIMESTAMPTZ NOT NULL,
  encrypted_material TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0), revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bounty_credential_handles_mission_idx ON bounty_credential_handles(workspace_id,mission_id);

CREATE TABLE IF NOT EXISTS bounty_browser_partitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id TEXT NOT NULL, mission_id UUID NOT NULL REFERENCES bounty_missions(id),
  account_id TEXT NOT NULL, caido_project_id TEXT NOT NULL, authority_epoch BIGINT NOT NULL,
  closed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(workspace_id,mission_id,account_id,authority_epoch)
);

CREATE TABLE IF NOT EXISTS bounty_caido_transactions (
  id UUID PRIMARY KEY, workspace_id TEXT NOT NULL, mission_id UUID NOT NULL REFERENCES bounty_missions(id),
  operation_id UUID NOT NULL REFERENCES bounty_operations(id), decision_id UUID NOT NULL,
  caido_project_id TEXT NOT NULL, request_hash TEXT NOT NULL CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  response_hash TEXT CHECK (response_hash IS NULL OR response_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('prepared','observed','unknown')), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,operation_id)
);
