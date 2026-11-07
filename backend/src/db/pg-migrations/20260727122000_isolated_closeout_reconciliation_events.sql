-- Reconciliation is an isolated closeout correction, never an ordinary release.

CREATE TABLE IF NOT EXISTS pipeline_run_closeout_reconciliation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id UUID NOT NULL UNIQUE
    REFERENCES pipeline_run_closeout_reconciliations(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK (event_type = 'run_closeout_reconciled'),
  source TEXT NOT NULL CHECK (source = 'closeout_reconciliation'),
  immutable_authority_hash TEXT NOT NULL CHECK (immutable_authority_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (run_id, event_type)
);

ALTER TABLE pipeline_run_closeout_reconciliations
  ADD COLUMN IF NOT EXISTS reconciliation_event_id UUID UNIQUE
    REFERENCES pipeline_run_closeout_reconciliation_events(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION prevent_closeout_reconciliation_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'closeout reconciliation evidence event is append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS trg_closeout_reconciliation_event_immutable
  ON pipeline_run_closeout_reconciliation_events;
CREATE TRIGGER trg_closeout_reconciliation_event_immutable
BEFORE UPDATE OR DELETE ON pipeline_run_closeout_reconciliation_events
FOR EACH ROW EXECUTE FUNCTION prevent_closeout_reconciliation_event_mutation();

-- Reconciliation event identity is part of terminal completion authority. The
-- originating completion check remains in force; this strictly strengthens it.
ALTER TABLE pipeline_run_closeout_reconciliations
  ADD CONSTRAINT pipeline_run_closeout_reconciliations_completion_event_ck CHECK (
    (state = 'completed') =
    (after_projection IS NOT NULL AND reconciled_at IS NOT NULL
      AND result_receipt_hash IS NOT NULL AND reconciliation_event_id IS NOT NULL)
  ) NOT VALID;
