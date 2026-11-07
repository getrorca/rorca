-- Command provenance and replay identity required by the sole bounty Controller.
ALTER TABLE bounty_operations
  ADD COLUMN payload_hash TEXT NOT NULL DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN actor TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN purpose TEXT NOT NULL DEFAULT 'pre-controller operation',
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD CONSTRAINT bounty_operations_payload_hash_format CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT bounty_operations_actor_present CHECK (length(actor) BETWEEN 1 AND 256),
  ADD CONSTRAINT bounty_operations_purpose_present CHECK (length(purpose) BETWEEN 1 AND 256);

ALTER TABLE bounty_operations
  ALTER COLUMN payload_hash DROP DEFAULT,
  ALTER COLUMN actor DROP DEFAULT,
  ALTER COLUMN purpose DROP DEFAULT;

CREATE INDEX bounty_operations_mission_created_idx ON bounty_operations(workspace_id, mission_id, created_at);
