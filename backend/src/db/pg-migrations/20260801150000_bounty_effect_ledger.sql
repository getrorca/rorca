-- Crash-safe append-before-act target-effect ledger and atomic reservations.
ALTER TABLE bounty_operations
  ADD COLUMN work_package_id UUID REFERENCES bounty_work_packages(id),
  ADD COLUMN state TEXT NOT NULL DEFAULT 'observed'
    CHECK (state IN ('prepared','sent','observed','failed-before-send','unknown')),
  ADD COLUMN decision TEXT NOT NULL DEFAULT 'ALLOW' CHECK (decision IN ('ALLOW','DENY')),
  ADD COLUMN repeatable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE bounty_operations ALTER COLUMN state DROP DEFAULT, ALTER COLUMN decision DROP DEFAULT;

CREATE TABLE bounty_effect_reservations (
  operation_id UUID PRIMARY KEY REFERENCES bounty_operations(id),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  cost_cents BIGINT NOT NULL CHECK (cost_cents >= 0),
  concurrency INTEGER NOT NULL CHECK (concurrency > 0),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  CHECK (released_at IS NULL OR released_at >= reserved_at)
);
CREATE INDEX bounty_effect_active_reservations_idx
  ON bounty_effect_reservations(workspace_id, mission_id) WHERE released_at IS NULL;
CREATE INDEX bounty_effect_replay_fence_idx
  ON bounty_operations(workspace_id, mission_id, work_package_id, payload_hash)
  WHERE kind = 'target.effect';

-- Prepared intent is immutable; reconciliation may change only lifecycle state.
CREATE FUNCTION bounty_guard_effect_operation_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind = 'target.effect' AND (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'prepared effect identity and decision are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bounty_effect_operation_update_guard BEFORE UPDATE ON bounty_operations
FOR EACH ROW EXECUTE FUNCTION bounty_guard_effect_operation_update();
