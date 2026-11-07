-- Host re-finalization packet for integrated_validated wave passes.
-- Journal bytes remain proposal-only. No pgboss.* object is touched.

ALTER TABLE story_integration_ledger
  ADD COLUMN IF NOT EXISTS recovery_packet JSONB,
  ADD COLUMN IF NOT EXISTS recovery_packet_hash CHAR(64);

ALTER TABLE story_integration_ledger
  DROP CONSTRAINT IF EXISTS story_integration_recovery_packet_ck,
  ADD CONSTRAINT story_integration_recovery_packet_ck CHECK (
    (recovery_packet IS NULL) = (recovery_packet_hash IS NULL)
    AND (recovery_packet IS NULL OR (
      jsonb_typeof(recovery_packet) = 'object'
      AND recovery_packet_hash ~ '^[0-9a-f]{64}$'
      AND octet_length(recovery_packet::text) <= 65536
    ))
  ) NOT VALID;

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

  IF OLD.recovery_packet IS NOT NULL AND (
    NEW.recovery_packet IS DISTINCT FROM OLD.recovery_packet
    OR NEW.recovery_packet_hash IS DISTINCT FROM OLD.recovery_packet_hash
  ) THEN
    RAISE EXCEPTION 'story integration recovery packet is immutable';
  END IF;
  IF OLD.recovery_packet IS NULL AND NEW.recovery_packet IS NOT NULL
     AND NOT (OLD.state = 'integrated' AND NEW.state = 'integrated_validated') THEN
    RAISE EXCEPTION 'story integration recovery packet may be frozen only with integrated validation';
  END IF;
  IF OLD.state = 'integrated' AND NEW.state = 'integrated_validated'
     AND (NEW.recovery_packet IS NULL OR NEW.recovery_packet_hash IS NULL) THEN
    RAISE EXCEPTION 'integrated validation requires an immutable host recovery packet';
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

-- Existing pre-migration integrated_validated rows without packets remain
-- visible but are deliberately not promotable by worker recovery.
