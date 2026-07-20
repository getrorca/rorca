-- Durable exactly-once boundary for wave story contribution integration.
-- pg-boss owns its own schema; this migration intentionally touches only rorca tables.

CREATE TABLE IF NOT EXISTS story_integration_ledger (
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  wave_index INTEGER NOT NULL CHECK (wave_index >= 0),
  integration_order INTEGER NOT NULL CHECK (integration_order >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'prepared',
    'integrating',
    'integrated',
    'integrated_validated',
    'finalized',
    'failed'
  )),
  source_commit CHAR(40) NOT NULL CHECK (source_commit ~ '^[0-9a-f]{40}$'),
  source_base_commit CHAR(40) NOT NULL CHECK (source_base_commit ~ '^[0-9a-f]{40}$'),
  expected_parent_head CHAR(40) NOT NULL CHECK (expected_parent_head ~ '^[0-9a-f]{40}$'),
  resulting_head CHAR(40),
  frozen_manifest_hash CHAR(64) NOT NULL CHECK (frozen_manifest_hash ~ '^[0-9a-f]{64}$'),
  validation_identity JSONB,
  finalization_identity JSONB,
  failure_reason TEXT,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, story_id, attempt),
  UNIQUE (run_id, integration_order),
  CHECK (resulting_head IS NULL OR resulting_head ~ '^[0-9a-f]{40}$'),
  CHECK (state NOT IN ('integrated', 'integrated_validated', 'finalized') OR resulting_head IS NOT NULL),
  CHECK (state NOT IN ('integrated_validated', 'finalized') OR validation_identity IS NOT NULL),
  CHECK (state <> 'finalized' OR (finalization_identity IS NOT NULL AND finalized_at IS NOT NULL)),
  CHECK (state <> 'failed' OR failure_reason IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_story_integration_finalization_idempotency
  ON story_integration_ledger ((finalization_identity->>'idempotencyKey'))
  WHERE finalization_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_story_integration_restart_reconcile
  ON story_integration_ledger (run_id, wave_index, integration_order, state);

CREATE OR REPLACE FUNCTION enforce_story_integration_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  transition_allowed BOOLEAN;
BEGIN
  IF ROW(
    NEW.run_id, NEW.story_id, NEW.attempt, NEW.wave_index,
    NEW.integration_order, NEW.source_commit, NEW.source_base_commit,
    NEW.expected_parent_head, NEW.frozen_manifest_hash
  ) IS DISTINCT FROM ROW(
    OLD.run_id, OLD.story_id, OLD.attempt, OLD.wave_index,
    OLD.integration_order, OLD.source_commit, OLD.source_base_commit,
    OLD.expected_parent_head, OLD.frozen_manifest_hash
  ) THEN
    RAISE EXCEPTION 'story integration identity is immutable';
  END IF;

  transition_allowed := NEW.state = OLD.state OR CASE OLD.state
    WHEN 'prepared' THEN NEW.state IN ('integrating', 'failed')
    WHEN 'integrating' THEN NEW.state IN ('integrated', 'failed')
    WHEN 'integrated' THEN NEW.state IN ('integrated_validated', 'failed')
    WHEN 'integrated_validated' THEN NEW.state IN ('finalized', 'failed')
    WHEN 'finalized' THEN FALSE
    WHEN 'failed' THEN FALSE
    ELSE FALSE
  END;
  IF NOT transition_allowed THEN
    RAISE EXCEPTION 'illegal story integration transition: % -> %', OLD.state, NEW.state;
  END IF;

  IF NEW.state <> OLD.state THEN
    NEW.state_version := OLD.state_version + 1;
  ELSIF NEW.state_version <> OLD.state_version THEN
    RAISE EXCEPTION 'state version may advance only with a legal state transition';
  END IF;
  NEW.updated_at := NOW();
  IF NEW.state = 'finalized' AND OLD.state <> 'finalized' THEN
    NEW.finalized_at := COALESCE(NEW.finalized_at, NOW());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_story_integration_transition ON story_integration_ledger;
CREATE TRIGGER trg_story_integration_transition
BEFORE UPDATE ON story_integration_ledger
FOR EACH ROW EXECUTE FUNCTION enforce_story_integration_transition();
