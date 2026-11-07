-- Forward-only remediation for installations that applied the pre-8afe Wave 2 migrations.
-- Historical retirement evaluations had no tenant identity, so they cannot be assigned safely.
-- Preserve them in an owner-only quarantine table and create the canonical workspace-scoped table.
DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
  has_workspace BOOLEAN;
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='rorca' AND table_name='context_epoch_retirement_evaluations' AND column_name='workspace_id'
  ) INTO has_workspace;

  IF NOT has_workspace THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON rorca.context_epoch_retirement_evaluations FROM %I',runtime_user);
    ALTER TABLE rorca.context_epoch_retirement_evaluations RENAME TO context_epoch_retirement_evaluations_unscoped_legacy;
    ALTER TABLE rorca.context_epoch_retirement_evaluations_unscoped_legacy
      RENAME CONSTRAINT context_epoch_retirement_evaluations_pkey TO context_epoch_retirement_evaluations_unscoped_legacy_pkey;
    COMMENT ON TABLE rorca.context_epoch_retirement_evaluations_unscoped_legacy IS
      'Owner-only quarantine: pre-20260729147000 rows lacked workspace identity and are never authority.';

    CREATE TABLE rorca.context_epoch_retirement_evaluations (
      workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
      evaluation_id TEXT NOT NULL, next_major_version TEXT NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      release_gate_passed BOOLEAN NOT NULL, age_gate_passed BOOLEAN NOT NULL,
      zero_use_gate_passed BOOLEAN NOT NULL, clients_gate_passed BOOLEAN NOT NULL,
      fixtures_gate_passed BOOLEAN NOT NULL, break_markers_gate_passed BOOLEAN NOT NULL,
      independent_review_gate_passed BOOLEAN NOT NULL, eligible BOOLEAN NOT NULL,
      packet_hash TEXT NOT NULL CHECK(packet_hash ~ '^sha256:[0-9a-f]{64}$'),
      PRIMARY KEY(workspace_id,evaluation_id),
      CHECK(eligible = (release_gate_passed AND age_gate_passed AND zero_use_gate_passed AND clients_gate_passed AND fixtures_gate_passed AND break_markers_gate_passed AND independent_review_gate_passed))
    );
    CREATE TRIGGER w2_immutable_context_epoch_retirement_evaluations
      BEFORE UPDATE OR DELETE ON rorca.context_epoch_retirement_evaluations
      FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
    CREATE TRIGGER w2_no_truncate_context_epoch_retirement_evaluations
      BEFORE TRUNCATE ON rorca.context_epoch_retirement_evaluations
      FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();
  END IF;

  ALTER TABLE rorca.context_epoch_retirement_evaluations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rorca.context_epoch_retirement_evaluations FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS w2_workspace_member_context_epoch_retirement_evaluations ON rorca.context_epoch_retirement_evaluations;
  DROP POLICY IF EXISTS wave2_explicit_runtime_context_epoch_retirement_evaluations ON rorca.context_epoch_retirement_evaluations;
  CREATE POLICY wave2_explicit_runtime_context_epoch_retirement_evaluations
    ON rorca.context_epoch_retirement_evaluations
    USING (
      (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='migration_owner'
      )) OR
      (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
      ))
    )
    WITH CHECK (
      (current_setting('rorca.migration_mode',TRUE)='on' AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='migration_owner'
      )) OR
      (workspace_id=current_setting('rorca.workspace_id',TRUE) AND EXISTS (
        SELECT 1 FROM rorca.wave2_database_principals p WHERE p.database_user=current_user AND p.principal_class='internal_runtime'
      ))
    );
  EXECUTE format('GRANT SELECT,INSERT ON rorca.context_epoch_retirement_evaluations TO %I',runtime_user);

  -- Revoke the historical schema-wide grant, including sequences created by other features.
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA rorca FROM %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE
    rorca.execution_lease_events_id_seq,
    rorca.runtime_event_conflicts_id_seq,
    rorca.mission_control_replay_conflicts_id_seq,
    rorca.mission_control_audit_id_seq,
    rorca.context_epoch_projection_reads_id_seq,
    rorca.context_epoch_write_rejections_id_seq,
    rorca.ssdlc_lifecycle_evidence_id_seq TO %I',runtime_user);
END;
$$;

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729147000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729146000
  AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rorca.wave2_schema_readiness
    WHERE singleton=TRUE AND state='ready' AND migration_version=20260729147000
      AND prerequisite_receipt_hash IS NOT NULL
  ) THEN RAISE EXCEPTION 'Wave 2 forward upgrade did not preserve receipt-bound readiness'; END IF;
END;
$$;
