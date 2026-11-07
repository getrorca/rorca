-- Provider-neutral external-operation attempts and immutable receipts for
-- restart-safe reconciliation. Stable authority/resource identifiers are
-- persisted; credentials and provider response bodies have no representation.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_provider_authority_lease_lineage'
       AND conrelid = 'provider_authority_leases'::regclass
  ) THEN
    ALTER TABLE provider_authority_leases
      ADD CONSTRAINT uq_provider_authority_lease_lineage
      UNIQUE (id, workspace_id, authority_grant_id, provider_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS provider_operation_attempts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  authority_request_id UUID NOT NULL,
  authority_grant_id UUID NOT NULL,
  authority_lease_id UUID NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  operation TEXT NOT NULL CHECK (operation IN (
    'scm.branch.write',
    'scm.pull_request.write',
    'scm.checks.read',
    'scm.review.request'
  )),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN (
    'started',
    'externally_accepted',
    'reconciliation_required',
    'settled',
    'failed'
  )),
  repository_external_id TEXT NOT NULL CHECK (btrim(repository_external_id) <> ''),
  repository_owner TEXT NOT NULL CHECK (btrim(repository_owner) <> ''),
  repository_name TEXT NOT NULL CHECK (btrim(repository_name) <> ''),
  installation_external_id TEXT NOT NULL CHECK (btrim(installation_external_id) <> ''),
  branch_name TEXT NOT NULL CHECK (btrim(branch_name) <> ''),
  commit_sha TEXT NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  pull_request_external_id TEXT,
  check_run_external_ids JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(check_run_external_ids) = 'array'
    AND jsonb_array_length(check_run_external_ids) <= 100
  ),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  externally_accepted_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR (
      btrim(last_error_code) <> ''
      AND length(last_error_code) <= 128
      AND last_error_code !~* '(token|secret|password|authorization|bearer|private.?key|gh[opsu]_)'
    )
  ),
  CONSTRAINT provider_operation_attempt_lease_fk
    FOREIGN KEY (authority_lease_id, workspace_id, authority_grant_id, provider_id)
    REFERENCES provider_authority_leases (id, workspace_id, authority_grant_id, provider_id)
    ON DELETE RESTRICT,
  CONSTRAINT provider_operation_attempt_state_facts CHECK (
    (state = 'started' AND externally_accepted_at IS NULL AND settled_at IS NULL AND last_error_code IS NULL)
    OR (state = 'externally_accepted' AND externally_accepted_at IS NOT NULL AND settled_at IS NULL AND last_error_code IS NULL)
    OR (state = 'reconciliation_required' AND externally_accepted_at IS NULL AND settled_at IS NULL AND last_error_code IS NOT NULL)
    OR (state = 'settled' AND externally_accepted_at IS NOT NULL AND settled_at IS NOT NULL AND last_error_code IS NULL)
    OR (state = 'failed' AND externally_accepted_at IS NULL AND settled_at IS NOT NULL AND last_error_code IS NOT NULL)
  ),
  CONSTRAINT provider_operation_attempt_resource_facts CHECK (
    (operation = 'scm.branch.write' AND pull_request_external_id IS NULL AND check_run_external_ids = '[]'::jsonb)
    OR (operation = 'scm.pull_request.write'
        AND check_run_external_ids = '[]'::jsonb
        AND (state IN ('started','reconciliation_required','failed') OR pull_request_external_id IS NOT NULL))
    OR (operation = 'scm.checks.read' AND pull_request_external_id IS NULL)
    OR (operation = 'scm.review.request'
        AND check_run_external_ids = '[]'::jsonb
        AND (state IN ('started','reconciliation_required','failed') OR pull_request_external_id IS NOT NULL))
  ),
  UNIQUE (workspace_id, authority_request_id, authority_grant_id, authority_lease_id, operation, attempt_number),
  UNIQUE (id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
);

CREATE INDEX IF NOT EXISTS idx_provider_operation_attempts_reconcile
  ON provider_operation_attempts (workspace_id, provider_id, state, started_at)
  WHERE state IN ('started', 'externally_accepted', 'reconciliation_required');

CREATE OR REPLACE FUNCTION guard_provider_operation_attempt()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Provider operation attempts are audit-retained';
  END IF;
  IF OLD.state IN ('settled', 'failed') THEN
    RAISE EXCEPTION 'Terminal provider operation attempts are immutable';
  END IF;
  IF (to_jsonb(OLD) - ARRAY[
        'state','pull_request_external_id','check_run_external_ids',
        'externally_accepted_at','settled_at','last_error_code'
      ]::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY[
        'state','pull_request_external_id','check_run_external_ids',
        'externally_accepted_at','settled_at','last_error_code'
      ]::text[]) THEN
    RAISE EXCEPTION 'Provider operation attempt authority identity is immutable';
  END IF;
  IF NOT (
    (OLD.state = 'started' AND NEW.state IN ('externally_accepted','reconciliation_required','failed'))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN ('externally_accepted','failed'))
    OR (OLD.state = 'externally_accepted' AND NEW.state = 'settled')
  ) THEN
    RAISE EXCEPTION 'Illegal provider operation attempt transition: % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_operation_attempt_guard ON provider_operation_attempts;
CREATE TRIGGER trg_provider_operation_attempt_guard
  BEFORE UPDATE OR DELETE ON provider_operation_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_provider_operation_attempt();

DROP TRIGGER IF EXISTS trg_provider_operation_attempt_no_truncate ON provider_operation_attempts;
CREATE TRIGGER trg_provider_operation_attempt_no_truncate
  BEFORE TRUNCATE ON provider_operation_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION guard_provider_operation_attempt();

CREATE TABLE IF NOT EXISTS provider_operation_receipts (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  authority_request_id UUID NOT NULL,
  authority_grant_id UUID NOT NULL,
  authority_lease_id UUID NOT NULL,
  provider_id TEXT NOT NULL CHECK (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  receipt_schema_version TEXT NOT NULL CHECK (btrim(receipt_schema_version) <> ''),
  receipt_json JSONB NOT NULL CHECK (
    jsonb_typeof(receipt_json) = 'object'
    AND receipt_json ->> 'workspaceId' = workspace_id
    AND receipt_json #>> '{authority,requestId}' = authority_request_id::text
    AND receipt_json #>> '{authority,grantId}' = authority_grant_id::text
    AND receipt_json #>> '{authority,leaseId}' = authority_lease_id::text
    AND receipt_json::text !~* '"(token|appJwt|authorization|password|privateKey|private_key|pat|sshKey|ssh_key)"[[:space:]]*:'
    AND receipt_json::text !~* '(Bearer[[:space:]]+[A-Za-z0-9._-]+|gh[opsu]_[A-Za-z0-9_]+)'
  ),
  receipt_hash TEXT NOT NULL UNIQUE CHECK (receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_operation_receipt_lease_fk
    FOREIGN KEY (authority_lease_id, workspace_id, authority_grant_id, provider_id)
    REFERENCES provider_authority_leases (id, workspace_id, authority_grant_id, provider_id)
    ON DELETE RESTRICT,
  UNIQUE (workspace_id, authority_request_id, authority_grant_id, authority_lease_id),
  UNIQUE (id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
);

CREATE TABLE IF NOT EXISTS provider_operation_receipt_attempts (
  receipt_id UUID NOT NULL,
  attempt_id UUID NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  authority_request_id UUID NOT NULL,
  authority_grant_id UUID NOT NULL,
  authority_lease_id UUID NOT NULL,
  PRIMARY KEY (receipt_id, attempt_id),
  CONSTRAINT provider_operation_receipt_attempt_receipt_fk
    FOREIGN KEY (receipt_id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
    REFERENCES provider_operation_receipts (id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
    ON DELETE RESTRICT,
  CONSTRAINT provider_operation_receipt_attempt_attempt_fk
    FOREIGN KEY (attempt_id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
    REFERENCES provider_operation_attempts (id, workspace_id, authority_request_id, authority_grant_id, authority_lease_id)
    ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION reject_provider_receipt_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Provider operation receipts and lineage are immutable';
END;
$$;

DROP TRIGGER IF EXISTS trg_provider_operation_receipt_immutable ON provider_operation_receipts;
CREATE TRIGGER trg_provider_operation_receipt_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON provider_operation_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_receipt_mutation();

DROP TRIGGER IF EXISTS trg_provider_operation_receipt_attempt_immutable ON provider_operation_receipt_attempts;
CREATE TRIGGER trg_provider_operation_receipt_attempt_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON provider_operation_receipt_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_receipt_mutation();

-- A failed revocation is terminal for credential use but not for audit
-- reconciliation. Its only legal follow-up is a read-side proof that the
-- provider-bounded token expiry has elapsed.
CREATE OR REPLACE FUNCTION guard_provider_authority_lease()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Provider authority leases are audit-retained';
  END IF;
  IF (to_jsonb(OLD) - ARRAY['state','settlement_outcome','settlement_kind','settled_at','revocation_verified_at']::text[])
     IS DISTINCT FROM
     (to_jsonb(NEW) - ARRAY['state','settlement_outcome','settlement_kind','settled_at','revocation_verified_at']::text[]) THEN
    RAISE EXCEPTION 'Provider authority lease identity is immutable';
  END IF;
  IF OLD.state = 'active' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'reconciliation_required'
     AND NEW.state = 'settled'
     AND NEW.settlement_outcome IS NOT DISTINCT FROM OLD.settlement_outcome
     AND NEW.settled_at IS NOT DISTINCT FROM OLD.settled_at
     AND OLD.settlement_kind = 'revocation_failed'
     AND NEW.settlement_kind = 'verified_expiry'
     AND OLD.revocation_verified_at IS NULL
     AND NEW.revocation_verified_at IS NOT NULL
     AND NEW.revocation_verified_at >= OLD.expires_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Settled provider authority lease facts are immutable';
END;
$$;

REVOKE ALL PRIVILEGES ON TABLE provider_operation_attempts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE provider_operation_receipts FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE provider_operation_receipt_attempts FROM PUBLIC;
