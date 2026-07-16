-- Make trusted checkpoint validation evidence append-only while preserving an
-- explicit one-way revocation path. Recovery callers can only read/reference it.

CREATE UNIQUE INDEX IF NOT EXISTS uq_checkpoint_attestation_identity
  ON checkpoint_validation_attestations
  (workspace_id, run_id, story_id, branch_name, checkpoint_sha, validation_gate);

CREATE OR REPLACE FUNCTION guard_checkpoint_validation_attestation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'checkpoint validation attestations are append-only; DELETE is not permitted';
  END IF;

  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.run_id IS DISTINCT FROM NEW.run_id
     OR OLD.story_id IS DISTINCT FROM NEW.story_id
     OR OLD.branch_name IS DISTINCT FROM NEW.branch_name
     OR OLD.checkpoint_sha IS DISTINCT FROM NEW.checkpoint_sha
     OR OLD.validation_gate IS DISTINCT FROM NEW.validation_gate
     OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
     OR OLD.passed_at IS DISTINCT FROM NEW.passed_at
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'checkpoint validation attestations are immutable; only one-way revocation is permitted';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkpoint_validation_attestation_immutable
  ON checkpoint_validation_attestations;
CREATE TRIGGER trg_checkpoint_validation_attestation_immutable
BEFORE UPDATE OR DELETE ON checkpoint_validation_attestations
FOR EACH ROW EXECUTE FUNCTION guard_checkpoint_validation_attestation_mutation();
