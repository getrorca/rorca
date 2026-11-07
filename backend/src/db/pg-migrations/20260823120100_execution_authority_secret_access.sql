-- REA-005: attributable, reference-only secret access audit.
--
-- runPgMigrations applies this file atomically. Existing encrypted vault tables
-- and ciphertext columns are intentionally unchanged. Populated upgrades use
-- backup/restore plus forward-fix; this migration never manages pgboss.

-- A fully consumed ephemeral lease still requires explicit revocation. REA-001
-- made exhausted terminal; the broker must instead be able to revoke it or mark
-- it for reconciliation without decrementing its durable use count.
CREATE OR REPLACE FUNCTION rorca.credential_lease_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.grant_id IS DISTINCT FROM NEW.grant_id
    OR OLD.binding_reference IS DISTINCT FROM NEW.binding_reference
    OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.story_id IS DISTINCT FROM NEW.story_id
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.lease_purpose IS DISTINCT FROM NEW.lease_purpose
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.secret_reference IS DISTINCT FROM NEW.secret_reference
    OR OLD.secret_fingerprint IS DISTINCT FROM NEW.secret_fingerprint
    OR OLD.fencing_generation IS DISTINCT FROM NEW.fencing_generation
    OR OLD.maximum_uses IS DISTINCT FROM NEW.maximum_uses
    OR OLD.provenance_json IS DISTINCT FROM NEW.provenance_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
  THEN
    RAISE EXCEPTION 'Credential lease identity and scope are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'prepared' AND NEW.status IN ('active', 'revoked', 'expired', 'reconciliation_required'))
    OR (OLD.status = 'active' AND NEW.status IN ('active', 'exhausted', 'revoked', 'expired', 'reconciliation_required'))
    OR (OLD.status = 'exhausted' AND NEW.status IN ('revoked', 'reconciliation_required'))
    OR (OLD.status = 'expired' AND NEW.status IN ('revoked', 'reconciliation_required'))
    OR (OLD.status = 'reconciliation_required' AND NEW.status IN ('revoked', 'expired')))
    OR NEW.uses_consumed < OLD.uses_consumed
    OR NEW.uses_consumed > OLD.uses_consumed + 1
  THEN
    RAISE EXCEPTION 'Illegal credential lease transition or use count' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'revoked' THEN NEW.revoked_at := COALESCE(NEW.revoked_at, clock_timestamp()); END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE rorca.authority_secret_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.authority-secret-access-audit.v1'
    CHECK (schema_version = 'rorca.authority-secret-access-audit.v1'),
  workspace_id TEXT NOT NULL,
  lease_id UUID NOT NULL,
  binding_reference TEXT NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  principal TEXT NOT NULL CHECK (octet_length(principal) BETWEEN 1 AND 512),
  lease_purpose TEXT NOT NULL CHECK (octet_length(lease_purpose) BETWEEN 1 AND 512),
  provider TEXT NOT NULL CHECK (octet_length(provider) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (octet_length(environment) BETWEEN 1 AND 256),
  provider_resource_id TEXT NOT NULL CHECK (octet_length(provider_resource_id) BETWEEN 1 AND 1024),
  action TEXT NOT NULL CHECK (octet_length(action) BETWEEN 1 AND 256),
  secret_reference TEXT NOT NULL
    CHECK (octet_length(secret_reference) <= 1024 AND secret_reference ~ '^(vault|infisical)://[^[:space:]]+$'),
  secret_fingerprint TEXT NOT NULL CHECK (secret_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  event TEXT NOT NULL CHECK (event IN (
    'resolution_started', 'resolution_succeeded', 'resolution_failed',
    'revocation_started', 'revocation_succeeded', 'revocation_failed'
  )),
  failure_code TEXT CHECK (failure_code IS NULL OR octet_length(failure_code) BETWEEN 1 AND 128),
  provenance_json JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (workspace_id, lease_id)
    REFERENCES rorca.credential_leases(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_reference, binding_generation)
    REFERENCES rorca.execution_authority_bindings(workspace_id, binding_reference, generation) ON DELETE RESTRICT,
  CHECK ((event IN ('resolution_failed', 'revocation_failed')) = (failure_code IS NOT NULL))
);

CREATE INDEX authority_secret_access_audit_lease_idx
  ON rorca.authority_secret_access_audit(workspace_id, lease_id, occurred_at, id);
CREATE INDEX authority_secret_access_audit_principal_idx
  ON rorca.authority_secret_access_audit(workspace_id, principal, occurred_at, id);

CREATE TRIGGER authority_secret_access_audit_update_guard
BEFORE UPDATE ON rorca.authority_secret_access_audit
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();
CREATE TRIGGER authority_secret_access_audit_delete_guard
BEFORE DELETE ON rorca.authority_secret_access_audit
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

REVOKE ALL ON TABLE rorca.authority_secret_access_audit FROM PUBLIC, authenticated, anon;

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
    'GRANT SELECT, INSERT ON TABLE rorca.authority_secret_access_audit TO %I',
    runtime_user
  );
END;
$$;

COMMENT ON TABLE rorca.authority_secret_access_audit IS
  'REA-005 append-only attributable audit for exact-scope secret resolution and revocation.';
