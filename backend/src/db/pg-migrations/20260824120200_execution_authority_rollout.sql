-- REA-008: off-by-default workspace Execution Authority rollout profile.
--
-- runPgMigrations applies this file and its schema marker atomically. Populated
-- upgrades remain backup/restore plus forward-fix; this migration never manages
-- pgboss. Rollout evidence and pre-existing authority audit history are retained.

CREATE TABLE rorca.execution_authority_profiles (
  workspace_id TEXT PRIMARY KEY REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority-profile.v1'
    CHECK (schema_version = 'rorca.execution-authority-profile.v1'),
  state TEXT NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled', 'enabled')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  transition_principal TEXT NOT NULL DEFAULT 'system:migration'
    CHECK (octet_length(transition_principal) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (updated_at >= created_at),
  CHECK (
    (state = 'enabled' AND enabled_at IS NOT NULL AND disabled_at IS NULL)
    OR (state = 'disabled' AND disabled_at IS NOT NULL)
  )
);

CREATE TABLE rorca.execution_authority_rollout_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority-rollout-evidence.v1'
    CHECK (schema_version = 'rorca.execution-authority-rollout-evidence.v1'),
  workspace_id TEXT NOT NULL REFERENCES rorca.execution_authority_profiles(workspace_id) ON DELETE RESTRICT,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'migration', 'api', 'ui', 'crash_recovery', 'redaction', 'disposable_fixture_smoke'
  )),
  result TEXT NOT NULL CHECK (result IN ('passed', 'failed')),
  artifact_reference TEXT NOT NULL CHECK (
    octet_length(artifact_reference) BETWEEN 1 AND 2048
    AND artifact_reference ~ '^[a-z][a-z0-9+.-]*://[^[:space:]]+$'
  ),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  operator_principal TEXT NOT NULL CHECK (octet_length(operator_principal) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  provenance_json JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX execution_authority_rollout_evidence_readiness_idx
  ON rorca.execution_authority_rollout_evidence(workspace_id, evidence_kind, observed_at DESC, created_at DESC);

CREATE OR REPLACE FUNCTION rorca.execution_authority_profile_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  passed_kinds INTEGER;
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.schema_version IS DISTINCT FROM NEW.schema_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Execution Authority profile identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = OLD.state OR NEW.generation <> OLD.generation + 1 THEN
    RAISE EXCEPTION 'Execution Authority profile transition requires one new generation' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'disabled' AND NEW.state = 'enabled' THEN
    SELECT count(*) INTO passed_kinds
      FROM (
        SELECT DISTINCT ON (evidence_kind) evidence_kind, result
          FROM rorca.execution_authority_rollout_evidence
         WHERE workspace_id = OLD.workspace_id
         ORDER BY evidence_kind, observed_at DESC, created_at DESC, id DESC
      ) latest
     WHERE result = 'passed';
    IF passed_kinds <> 6 THEN
      RAISE EXCEPTION 'Execution Authority profile requires current passing rollout evidence for all six classes'
        USING ERRCODE = '55000';
    END IF;
    NEW.enabled_at := clock_timestamp();
    NEW.disabled_at := NULL;
  ELSIF OLD.state = 'enabled' AND NEW.state = 'disabled' THEN
    NEW.disabled_at := clock_timestamp();
  ELSE
    RAISE EXCEPTION 'Illegal Execution Authority profile transition' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_authority_profile_guard
BEFORE UPDATE ON rorca.execution_authority_profiles
FOR EACH ROW EXECUTE FUNCTION rorca.execution_authority_profile_guard_v1();

CREATE TRIGGER execution_authority_rollout_evidence_update_guard
BEFORE UPDATE ON rorca.execution_authority_rollout_evidence
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();
CREATE TRIGGER execution_authority_rollout_evidence_delete_guard
BEFORE DELETE ON rorca.execution_authority_rollout_evidence
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE OR REPLACE FUNCTION rorca.ensure_execution_authority_profile_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO rorca.execution_authority_profiles(workspace_id)
  VALUES (NEW.id)
  ON CONFLICT (workspace_id) DO NOTHING;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rorca.ensure_execution_authority_profile_v1() FROM PUBLIC, authenticated, anon;

CREATE TRIGGER workspace_execution_authority_profile_insert
AFTER INSERT ON rorca.workspaces
FOR EACH ROW EXECUTE FUNCTION rorca.ensure_execution_authority_profile_v1();

INSERT INTO rorca.execution_authority_profiles(workspace_id)
SELECT id FROM rorca.workspaces
ON CONFLICT (workspace_id) DO NOTHING;

CREATE OR REPLACE FUNCTION rorca.execution_authority_lease_profile_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  profile_state TEXT;
BEGIN
  SELECT state INTO profile_state
    FROM rorca.execution_authority_profiles
   WHERE workspace_id = NEW.workspace_id
   FOR SHARE;
  IF profile_state IS DISTINCT FROM 'enabled' THEN
    RAISE EXCEPTION 'Execution Authority workspace capability profile is disabled' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER credential_lease_profile_insert_guard
BEFORE INSERT ON rorca.credential_leases
FOR EACH ROW EXECUTE FUNCTION rorca.execution_authority_lease_profile_guard_v1();
CREATE TRIGGER credential_lease_profile_activation_guard
BEFORE UPDATE OF status ON rorca.credential_leases
FOR EACH ROW
WHEN (NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active')
EXECUTE FUNCTION rorca.execution_authority_lease_profile_guard_v1();

REVOKE ALL ON TABLE
  rorca.execution_authority_profiles,
  rorca.execution_authority_rollout_evidence
  FROM PUBLIC, authenticated, anon;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
        WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     )
  THEN
    RAISE EXCEPTION 'registered Execution Authority runtime principal is required'
      USING ERRCODE = '42501';
  END IF;
  EXECUTE format(
    'GRANT SELECT, UPDATE ON TABLE rorca.execution_authority_profiles TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE rorca.execution_authority_rollout_evidence TO %I',
    runtime_user
  );
END;
$$;

COMMENT ON TABLE rorca.execution_authority_profiles IS
  'REA-008 off-by-default workspace capability profile; generations fence enable and disable transitions.';
COMMENT ON TABLE rorca.execution_authority_rollout_evidence IS
  'REA-008 append-only rollout evidence retained across disable and re-enable transitions.';
