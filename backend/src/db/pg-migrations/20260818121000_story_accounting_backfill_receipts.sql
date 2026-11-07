-- Owner-operated, receipt-bound correction authority for historical Pi/OMP
-- results whose required accounting projection was durably recorded as zero.
CREATE TABLE rorca.story_accounting_backfill_receipts (
  receipt_hash TEXT PRIMARY KEY CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  story_result_id BIGINT NOT NULL UNIQUE REFERENCES rorca.story_results(id) ON DELETE RESTRICT,
  token_usage_id BIGINT NOT NULL UNIQUE REFERENCES rorca.token_usage(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL CHECK (length(trim(story_id)) > 0),
  agent_type TEXT NOT NULL CHECK (agent_type IN ('pi', 'omp')),
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  model TEXT NOT NULL CHECK (length(trim(model)) > 0),
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  cost_usd NUMERIC(18,9) NOT NULL CHECK (cost_usd >= 0),
  log_path TEXT NOT NULL CHECK (length(trim(log_path)) > 0),
  log_sha256 TEXT NOT NULL CHECK (log_sha256 ~ '^[0-9a-f]{64}$'),
  operator_identity TEXT NOT NULL DEFAULT current_user CHECK (length(trim(operator_identity)) > 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION rorca.reject_story_accounting_backfill_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'story accounting backfill receipts are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER story_accounting_backfill_receipts_immutable
BEFORE UPDATE OR DELETE ON rorca.story_accounting_backfill_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.reject_story_accounting_backfill_receipt_mutation();

CREATE TRIGGER story_accounting_backfill_receipts_no_truncate
BEFORE TRUNCATE ON rorca.story_accounting_backfill_receipts
FOR EACH STATEMENT EXECUTE FUNCTION rorca.reject_story_accounting_backfill_receipt_mutation();

REVOKE ALL PRIVILEGES ON TABLE rorca.story_accounting_backfill_receipts FROM PUBLIC, authenticated, anon;
DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> '' THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.story_accounting_backfill_receipts FROM %I', runtime_user);
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> '' THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE rorca.story_accounting_backfill_receipts FROM %I', writer_user);
  END IF;
END;
$$;
