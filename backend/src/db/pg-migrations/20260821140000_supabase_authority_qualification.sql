-- SMC-006 qualification and rollout authority for a disposable Rorca-owned or
-- provider-equivalent Supabase fixture. Evidence and receipts are append-only,
-- credential-free, and sealed to a synthetic fixture. Mutation capability
-- leases are introduced only by ordered rollout and are all revoked on rollback.

CREATE TABLE rorca.database_authority_qualification_receipts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  fixture_id TEXT NOT NULL CHECK (length(fixture_id) BETWEEN 1 AND 255),
  fixture_kind TEXT NOT NULL CHECK (fixture_kind IN ('disposable-project', 'provider-equivalent')),
  project_ref TEXT NOT NULL CHECK (project_ref ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  report_digest TEXT NOT NULL UNIQUE CHECK (report_digest ~ '^sha256:[0-9a-f]{64}$'),
  report_record JSONB NOT NULL CHECK (
    jsonb_typeof(report_record) = 'object'
    AND report_record ->> 'version' = 'rorca.supabase-authority-qualification.v1'
    AND report_record ->> 'reportDigest' = report_digest
    AND report_record #>> '{fixture,fixtureId}' = fixture_id
    AND report_record #>> '{fixture,workspaceId}' = workspace_id
    AND report_record #>> '{fixture,projectRef}' = project_ref
    AND report_record #>> '{fixture,owner}' = 'rorca'
    AND report_record #>> '{fixture,fixtureKind}' = fixture_kind
    AND report_record #>> '{fixture,syntheticDataOnly}' = 'true'
    AND report_record #>> '{fixture,customerDataPresent}' = 'false'
    AND (report_record #>> '{fixture,bindingGeneration}')::BIGINT = binding_generation
    AND report_record #>> '{fixture,ownershipEvidenceHash}' ~ '^sha256:[0-9a-f]{64}$'
    AND report_record #>> '{fixture,isolationEvidenceHash}' ~ '^sha256:[0-9a-f]{64}$'
    AND report_record #>> '{fixture,teardownEvidenceHash}' ~ '^sha256:[0-9a-f]{64}$'
    AND report_record #>> '{readOnlyInspection,transactionMode}' = 'read-only'
    AND report_record #>> '{readOnlyInspection,stableObjectIdentifiers}' = 'true'
    AND jsonb_array_length(report_record #> '{readOnlyInspection,inventoryKinds}') = 7
    AND report_record #>> '{scratchRestore,backupVerified}' = 'true'
    AND report_record #>> '{scratchRestore,sourceTargetDistinct}' = 'true'
    AND report_record #>> '{scratchRestore,targetEnvironment}' = 'scratch'
    AND report_record #>> '{scratchRestore,expectedSchemaHash}'
      = report_record #>> '{scratchRestore,restoredSchemaHash}'
    AND report_record #>> '{scratchRestore,dataChecksPassed}' = 'true'
    AND report_record #>> '{phases,0,phase}' = 'inspect-only'
    AND report_record #>> '{phases,0,status}' = 'passed'
    AND report_record #>> '{phases,1,phase}' = 'backup-restore'
    AND report_record #>> '{phases,1,status}' = 'passed'
    AND report_record #>> '{phases,2,phase}' = 'staging-mutation'
    AND report_record #>> '{phases,2,status}' = 'passed'
    AND report_record #>> '{phases,3,phase}' = 'production-and-credentials'
    AND report_record #>> '{phases,3,status}' = 'passed'
    AND jsonb_array_length(report_record -> 'failureRecoveries') = 2
    AND jsonb_array_length(report_record -> 'denials') = 6
    AND jsonb_array_length(report_record -> 'ceremonies') = 3
    AND jsonb_array_length(report_record -> 'crashes') = 52
    AND rorca.authority_metadata_is_reference_only_v1(report_record)
  ),
  receipt_hash TEXT NOT NULL UNIQUE CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  receipt_record JSONB NOT NULL CHECK (
    jsonb_typeof(receipt_record) = 'object'
    AND receipt_record ->> 'version' = 'rorca.supabase-authority-qualification-receipt.v1'
    AND receipt_record ->> 'receiptId' = id::TEXT
    AND receipt_record ->> 'workspaceId' = workspace_id
    AND receipt_record ->> 'fixtureId' = fixture_id
    AND receipt_record ->> 'projectRef' = project_ref
    AND (receipt_record ->> 'bindingGeneration')::BIGINT = binding_generation
    AND receipt_record ->> 'reportDigest' = report_digest
    AND receipt_record ->> 'receiptHash' = receipt_hash
    AND receipt_record ->> 'syntheticDataOnly' = 'true'
    AND receipt_record ->> 'readinessEvidenceDigest' ~ '^sha256:[0-9a-f]{64}$'
    AND jsonb_array_length(receipt_record -> 'qualifiedStages') = 4
    AND jsonb_array_length(receipt_record -> 'qualifiedCapabilities') = 8
    AND jsonb_array_length(receipt_record -> 'preservedOperationalReceiptHashes') > 0
    AND rorca.authority_metadata_is_reference_only_v1(receipt_record)
  ),
  qualified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, workspace_id)
);

CREATE TABLE rorca.database_authority_rollout_controls (
  workspace_id TEXT PRIMARY KEY REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  qualification_receipt_id UUID NOT NULL,
  fixture_id TEXT NOT NULL CHECK (length(fixture_id) BETWEEN 1 AND 255),
  stage TEXT NOT NULL CHECK (stage IN (
    'inspect-only',
    'backup-restore',
    'staging-mutation',
    'production-and-credentials',
    'rolled-back'
  )),
  enabled_capabilities TEXT[] NOT NULL,
  preserved_receipt_hashes TEXT[] NOT NULL CHECK (cardinality(preserved_receipt_hashes) > 0),
  snapshot_record JSONB NOT NULL CHECK (
    jsonb_typeof(snapshot_record) = 'object'
    AND snapshot_record ->> 'workspaceId' = workspace_id
    AND snapshot_record ->> 'qualificationReceiptId' = qualification_receipt_id::TEXT
    AND snapshot_record ->> 'fixtureId' = fixture_id
    AND snapshot_record ->> 'stage' = stage
    AND snapshot_record -> 'enabledCapabilities' = to_jsonb(enabled_capabilities)
    AND snapshot_record -> 'preservedReceiptHashes' = to_jsonb(preserved_receipt_hashes)
    AND (snapshot_record ->> 'revision')::BIGINT = revision
    AND rorca.authority_metadata_is_reference_only_v1(snapshot_record)
  ),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  rollback_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (qualification_receipt_id, workspace_id)
    REFERENCES rorca.database_authority_qualification_receipts(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (stage = 'inspect-only' AND enabled_capabilities = ARRAY[
      'database.schema.inspect'
    ]::TEXT[])
    OR (stage = 'backup-restore' AND enabled_capabilities = ARRAY[
      'database.schema.inspect',
      'database.backup.create',
      'database.backup.restore'
    ]::TEXT[])
    OR (stage = 'staging-mutation' AND enabled_capabilities = ARRAY[
      'database.schema.inspect',
      'database.backup.create',
      'database.backup.restore',
      'database.migration.apply.staging'
    ]::TEXT[])
    OR (stage = 'production-and-credentials' AND enabled_capabilities = ARRAY[
      'database.schema.inspect',
      'database.backup.create',
      'database.backup.restore',
      'database.migration.apply.staging',
      'database.migration.apply.production',
      'credential.supabase.api-key.rotate',
      'credential.supabase.legacy-key.migrate',
      'credential.supabase.jwt-signing.rotate'
    ]::TEXT[])
    OR (stage = 'rolled-back' AND enabled_capabilities = ARRAY[
      'database.schema.inspect'
    ]::TEXT[])
  ),
  CHECK ((stage = 'rolled-back') = (rollback_reason IS NOT NULL))
);

CREATE TABLE rorca.database_authority_capability_leases (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL
    REFERENCES rorca.database_authority_rollout_controls(workspace_id) ON DELETE RESTRICT,
  qualification_receipt_id UUID NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN (
    'database.backup.create',
    'database.backup.restore',
    'database.migration.apply.staging',
    'database.migration.apply.production',
    'credential.supabase.api-key.rotate',
    'credential.supabase.legacy-key.migrate',
    'credential.supabase.jwt-signing.rotate'
  )),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  granted_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (qualification_receipt_id, workspace_id)
    REFERENCES rorca.database_authority_qualification_receipts(id, workspace_id) ON DELETE RESTRICT,
  CHECK (
    (state = 'active' AND revoked_at IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= granted_at)
  )
);

CREATE UNIQUE INDEX database_authority_one_active_capability_lease_idx
  ON rorca.database_authority_capability_leases (workspace_id, capability)
  WHERE state = 'active';
CREATE INDEX database_authority_qualification_workspace_idx
  ON rorca.database_authority_qualification_receipts (workspace_id, qualified_at DESC);
CREATE INDEX database_authority_rollout_lease_state_idx
  ON rorca.database_authority_capability_leases (workspace_id, state, capability);

CREATE FUNCTION rorca.deny_database_authority_qualification_receipt_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  RAISE EXCEPTION 'Database authority qualification receipts are immutable'
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER database_authority_qualification_receipt_immutability
BEFORE UPDATE OR DELETE ON rorca.database_authority_qualification_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.deny_database_authority_qualification_receipt_mutation_v1();

CREATE FUNCTION rorca.guard_database_authority_rollout_transition_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Database authority rollout controls are append-only'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.qualification_receipt_id IS DISTINCT FROM NEW.qualification_receipt_id
     OR OLD.fixture_id IS DISTINCT FROM NEW.fixture_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Database authority rollout qualification identity is immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'Database authority rollout revision must advance exactly once'
      USING ERRCODE = '42501';
  END IF;
  IF NOT OLD.preserved_receipt_hashes <@ NEW.preserved_receipt_hashes THEN
    RAISE EXCEPTION 'Database authority rollout cannot discard receipts'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.stage = 'rolled-back' AND OLD.stage <> 'rolled-back' THEN
    IF EXISTS (
      SELECT 1 FROM rorca.database_authority_capability_leases lease
       WHERE lease.workspace_id = NEW.workspace_id AND lease.state = 'active'
    ) THEN
      RAISE EXCEPTION 'Database authority rollback must revoke every capability lease first'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NOT (
    (OLD.stage = 'inspect-only' AND NEW.stage = 'backup-restore')
    OR (OLD.stage = 'backup-restore' AND NEW.stage = 'staging-mutation')
    OR (OLD.stage = 'staging-mutation' AND NEW.stage = 'production-and-credentials')
  ) THEN
    RAISE EXCEPTION 'Database authority rollout phase transition is invalid'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_authority_rollout_transition
BEFORE UPDATE OR DELETE ON rorca.database_authority_rollout_controls
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_authority_rollout_transition_v1();

CREATE FUNCTION rorca.guard_database_authority_capability_lease_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
DECLARE
  rollout_stage TEXT;
  rollout_capabilities TEXT[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Database authority capability leases are append-only'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT control.stage, control.enabled_capabilities
      INTO rollout_stage, rollout_capabilities
      FROM rorca.database_authority_rollout_controls control
     WHERE control.workspace_id = NEW.workspace_id
       AND control.qualification_receipt_id = NEW.qualification_receipt_id;
    IF rollout_stage IS NULL OR rollout_stage = 'rolled-back'
       OR NOT NEW.capability = ANY(rollout_capabilities)
       OR NEW.state <> 'active' OR NEW.revoked_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'Capability lease is not enabled by the exact qualified rollout'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF OLD.id IS DISTINCT FROM NEW.id
       OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
       OR OLD.qualification_receipt_id IS DISTINCT FROM NEW.qualification_receipt_id
       OR OLD.capability IS DISTINCT FROM NEW.capability
       OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
       OR OLD.granted_at IS DISTINCT FROM NEW.granted_at
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.state <> 'active' OR NEW.state <> 'revoked'
       OR NEW.revoked_at IS NULL
    THEN
      RAISE EXCEPTION 'Capability lease permits only exact active-to-revoked transition'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER database_authority_capability_lease_transition
BEFORE INSERT OR UPDATE OR DELETE ON rorca.database_authority_capability_leases
FOR EACH ROW EXECUTE FUNCTION rorca.guard_database_authority_capability_lease_v1();

CREATE FUNCTION rorca.check_database_authority_rollout_leases_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, rorca
AS $$
DECLARE
  rollout_workspace TEXT := COALESCE(NEW.workspace_id, OLD.workspace_id);
  control_record rorca.database_authority_rollout_controls%ROWTYPE;
  enabled_capability TEXT;
BEGIN
  SELECT * INTO control_record
    FROM rorca.database_authority_rollout_controls
   WHERE workspace_id = rollout_workspace;
  IF control_record.stage = 'rolled-back' THEN
    IF EXISTS (
      SELECT 1 FROM rorca.database_authority_capability_leases lease
       WHERE lease.workspace_id = rollout_workspace AND lease.state = 'active'
    ) THEN
      RAISE EXCEPTION 'Rolled-back database authority control retains an active lease'
        USING ERRCODE = '42501';
    END IF;
    RETURN NULL;
  END IF;
  FOREACH enabled_capability IN ARRAY control_record.enabled_capabilities
  LOOP
    IF enabled_capability <> 'database.schema.inspect' AND NOT EXISTS (
      SELECT 1 FROM rorca.database_authority_capability_leases lease
       WHERE lease.workspace_id = rollout_workspace
         AND lease.qualification_receipt_id = control_record.qualification_receipt_id
         AND lease.capability = enabled_capability
         AND lease.state = 'active'
    ) THEN
      RAISE EXCEPTION 'Enabled database authority capability lacks an active tracked lease'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER database_authority_rollout_leases_complete
AFTER INSERT OR UPDATE ON rorca.database_authority_rollout_controls
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION rorca.check_database_authority_rollout_leases_v1();

CREATE CONSTRAINT TRIGGER database_authority_capability_leases_complete
AFTER INSERT OR UPDATE ON rorca.database_authority_capability_leases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION rorca.check_database_authority_rollout_leases_v1();

ALTER TABLE rorca.database_authority_qualification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.database_authority_rollout_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.database_authority_capability_leases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE rorca.database_authority_qualification_receipts FROM PUBLIC;
REVOKE ALL ON TABLE rorca.database_authority_rollout_controls FROM PUBLIC;
REVOKE ALL ON TABLE rorca.database_authority_capability_leases FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.deny_database_authority_qualification_receipt_mutation_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_authority_rollout_transition_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.guard_database_authority_capability_lease_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.check_database_authority_rollout_leases_v1() FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
  request_role TEXT;
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     )
  THEN
    RAISE EXCEPTION 'registered database-qualification runtime principal is required'
      USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = '' OR writer_user = runtime_user
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     )
  THEN
    RAISE EXCEPTION 'registered distinct database-qualification canonical writer is required'
      USING ERRCODE = '42501';
  END IF;

  FOR request_role IN
    SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated', 'anon')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_authority_qualification_receipts FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_authority_rollout_controls FROM %I', request_role);
    EXECUTE format('REVOKE ALL ON TABLE rorca.database_authority_capability_leases FROM %I', request_role);
  END LOOP;

  EXECUTE format('GRANT SELECT ON rorca.database_authority_qualification_receipts TO %I', runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.database_authority_rollout_controls TO %I', runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.database_authority_capability_leases TO %I', runtime_user);
  EXECUTE format('GRANT SELECT, INSERT ON rorca.database_authority_qualification_receipts TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.database_authority_rollout_controls TO %I', writer_user);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON rorca.database_authority_capability_leases TO %I', writer_user);

  EXECUTE format(
    'CREATE POLICY database_authority_qualification_runtime_read ON rorca.database_authority_qualification_receipts FOR SELECT TO %I USING (current_user = %L)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_authority_rollout_runtime_read ON rorca.database_authority_rollout_controls FOR SELECT TO %I USING (current_user = %L)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_authority_leases_runtime_read ON rorca.database_authority_capability_leases FOR SELECT TO %I USING (current_user = %L)',
    runtime_user, runtime_user
  );
  EXECUTE format(
    'CREATE POLICY database_authority_qualification_writer ON rorca.database_authority_qualification_receipts FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY database_authority_rollout_writer ON rorca.database_authority_rollout_controls FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
  EXECUTE format(
    'CREATE POLICY database_authority_leases_writer ON rorca.database_authority_capability_leases FOR ALL TO %I USING (current_user = %L) WITH CHECK (current_user = %L)',
    writer_user, writer_user, writer_user
  );
END;
$$;
