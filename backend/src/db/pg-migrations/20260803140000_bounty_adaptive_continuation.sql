-- Durable Controller facts for sequential, fresh-context bounty continuation.
-- The pure orchestrator writes nothing; trusted Controller repositories persist
-- these immutable decisions before dispatch or context compaction.

ALTER TABLE bounty_attempts
  ADD COLUMN process_identity UUID,
  ADD COLUMN session_identity UUID,
  ADD COLUMN context_nonce UUID,
  ADD COLUMN branch_identity TEXT,
  ADD COLUMN approach TEXT,
  ADD COLUMN termination_reason TEXT,
  ADD CONSTRAINT bounty_attempt_fresh_process UNIQUE (process_identity),
  ADD CONSTRAINT bounty_attempt_fresh_session UNIQUE (session_identity),
  ADD CONSTRAINT bounty_attempt_fresh_context UNIQUE (context_nonce),
  ADD CONSTRAINT bounty_attempt_continuation_fields_together CHECK (
    (process_identity IS NULL AND session_identity IS NULL AND context_nonce IS NULL AND branch_identity IS NULL AND approach IS NULL)
    OR
    (process_identity IS NOT NULL AND session_identity IS NOT NULL AND context_nonce IS NOT NULL
      AND branch_identity IS NOT NULL AND approach IS NOT NULL)
  );

-- Retry authority comes only from this persisted adapter-owned classification.
-- Absence, unknown, and non-repeatable classifications cannot authorize retry.
CREATE TABLE bounty_adapter_idempotency_classifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  adapter_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  classification TEXT NOT NULL CHECK (classification IN ('repeatable','non-repeatable','unknown')),
  adapter_version_hash TEXT NOT NULL CHECK (adapter_version_hash ~ '^sha256:[0-9a-f]{64}$'),
  classified_by TEXT NOT NULL,
  classification_body JSONB NOT NULL CHECK (jsonb_typeof(classification_body) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, adapter_id, revision)
);

CREATE TABLE bounty_continuation_checkpoints (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  admitted_state_hash TEXT NOT NULL CHECK (admitted_state_hash ~ '^sha256:[0-9a-f]{64}$'),
  nested_configuration_hash TEXT NOT NULL CHECK (nested_configuration_hash ~ '^sha256:[0-9a-f]{64}$'),
  exact_nested_configuration JSONB NOT NULL CHECK (jsonb_typeof(exact_nested_configuration) = 'object'),
  context_ratio NUMERIC(5,4) NOT NULL CHECK (context_ratio >= 0.6000 AND context_ratio <= 1.0000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

-- A separate append-only receipt proves persistence preceded compaction and pins
-- the exact nested configuration hash that was reattached.
CREATE TABLE bounty_context_compaction_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  checkpoint_id UUID NOT NULL,
  nested_configuration_hash TEXT NOT NULL CHECK (nested_configuration_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, checkpoint_id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id),
  FOREIGN KEY (workspace_id, checkpoint_id) REFERENCES bounty_continuation_checkpoints(workspace_id, id)
);

CREATE TABLE bounty_continuation_decisions (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id UUID NOT NULL,
  mission_epoch BIGINT NOT NULL CHECK (mission_epoch > 0),
  command_kind TEXT NOT NULL CHECK (command_kind IN ('start_fresh_attempt','persist_checkpoint','compact_context','terminate_stale_worker','prune_branch','hold','terminate')),
  reason_code TEXT NOT NULL,
  decision_body JSONB NOT NULL CHECK (jsonb_typeof(decision_body) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES bounty_missions(workspace_id, id)
);

CREATE FUNCTION bounty_reject_continuation_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are immutable Controller facts', TG_TABLE_NAME USING ERRCODE = '55000'; END $$;
CREATE TRIGGER bounty_adapter_classification_immutable BEFORE UPDATE OR DELETE ON bounty_adapter_idempotency_classifications FOR EACH ROW EXECUTE FUNCTION bounty_reject_continuation_fact_mutation();
CREATE TRIGGER bounty_continuation_checkpoint_immutable BEFORE UPDATE OR DELETE ON bounty_continuation_checkpoints FOR EACH ROW EXECUTE FUNCTION bounty_reject_continuation_fact_mutation();
CREATE TRIGGER bounty_compaction_receipt_immutable BEFORE UPDATE OR DELETE ON bounty_context_compaction_receipts FOR EACH ROW EXECUTE FUNCTION bounty_reject_continuation_fact_mutation();
CREATE TRIGGER bounty_continuation_decision_immutable BEFORE UPDATE OR DELETE ON bounty_continuation_decisions FOR EACH ROW EXECUTE FUNCTION bounty_reject_continuation_fact_mutation();
