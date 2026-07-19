-- Restart-readable, fail-closed merge conflict recovery for wave integration.
-- pg-boss owns its own schema; this migration intentionally touches only rorca tables.

ALTER TABLE story_integration_ledger
  ADD COLUMN IF NOT EXISTS conflict_evidence JSONB;

ALTER TABLE story_integration_ledger
  DROP CONSTRAINT IF EXISTS story_integration_ledger_state_check;

ALTER TABLE story_integration_ledger
  ADD CONSTRAINT story_integration_ledger_state_check CHECK (state IN (
    'prepared',
    'integrating',
    'conflicted',
    'resolution_pending',
    'aborted',
    'integrated',
    'integrated_validated',
    'finalized',
    'failed'
  ));

ALTER TABLE story_integration_ledger
  ADD CONSTRAINT story_integration_conflict_evidence_check CHECK (
    state NOT IN ('conflicted', 'resolution_pending', 'aborted')
    OR (conflict_evidence IS NOT NULL AND failure_reason IS NOT NULL)
  );

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
    WHEN 'integrating' THEN NEW.state IN ('conflicted', 'integrated', 'failed')
    WHEN 'conflicted' THEN NEW.state IN ('resolution_pending', 'aborted', 'failed')
    WHEN 'resolution_pending' THEN NEW.state IN ('integrated', 'aborted', 'failed')
    WHEN 'aborted' THEN FALSE
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
