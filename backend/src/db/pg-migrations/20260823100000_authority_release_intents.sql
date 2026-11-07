-- Provider-neutral OperationIntent records and exact digest-bound authorization grants.
-- Release inputs and provenance are canonical, immutable, and contain no secret values.

CREATE TABLE IF NOT EXISTS rorca.authority_operation_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  intent_kind TEXT NOT NULL CHECK (intent_kind = 'release'),
  schema_version TEXT NOT NULL CHECK (schema_version = 'rorca.release-intent.v1'),
  intent_payload JSONB NOT NULL CHECK (jsonb_typeof(intent_payload) = 'object'),
  provenance_payload JSONB NOT NULL CHECK (jsonb_typeof(provenance_payload) = 'object'),
  canonical_payload TEXT NOT NULL CHECK (octet_length(canonical_payload) BETWEEN 1 AND 1048576),
  canonical_ci_evidence TEXT NOT NULL CHECK (octet_length(canonical_ci_evidence) BETWEEN 1 AND 524288),
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  ci_evidence_digest TEXT NOT NULL CHECK (ci_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  created_by TEXT NOT NULL CHECK (created_by <> '' AND length(created_by) <= 255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, intent_digest)
);

CREATE INDEX IF NOT EXISTS idx_authority_operation_intents_workspace_created
  ON rorca.authority_operation_intents (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rorca.authority_operation_intent_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_intent_id UUID NOT NULL REFERENCES rorca.authority_operation_intents(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  ci_evidence_digest TEXT NOT NULL CHECK (ci_evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS idx_authority_operation_intent_grants_lookup
  ON rorca.authority_operation_intent_grants (workspace_id, operation_intent_id, id);

CREATE OR REPLACE FUNCTION rorca.guard_authority_operation_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  expected_payload JSONB;
  expected_intent_digest TEXT;
  expected_ci_evidence_digest TEXT;
BEGIN
  expected_payload := jsonb_build_object(
    'workspaceId', NEW.workspace_id,
    'releaseIntent', NEW.intent_payload,
    'provenance', NEW.provenance_payload
  );
  expected_intent_digest := 'sha256:' || encode(rorca.digest(
    'rorca:rorca.release-intent.v1:intent' || chr(10) || NEW.canonical_payload,
    'sha256'
  ), 'hex');
  expected_ci_evidence_digest := 'sha256:' || encode(rorca.digest(
    'rorca:rorca.release-intent.v1:ci-evidence' || chr(10) || NEW.canonical_ci_evidence,
    'sha256'
  ), 'hex');

  IF NEW.canonical_payload::JSONB IS DISTINCT FROM expected_payload
     OR NEW.canonical_ci_evidence::JSONB IS DISTINCT FROM NEW.provenance_payload->'ciEvidence'
     OR NEW.intent_payload->>'schemaVersion' <> NEW.schema_version
     OR NEW.provenance_payload->>'schemaVersion' <> 'rorca.release-intent-provenance.v1'
     OR NEW.intent_digest <> expected_intent_digest
     OR NEW.ci_evidence_digest <> expected_ci_evidence_digest
     OR NEW.canonical_payload ~* '"[^"]*(control.?token|secret|credential|password|private.?key|access.?token|api.?key)[^"]*"[[:space:]]*:' THEN
    RAISE EXCEPTION 'operation intent canonical payload, digest, or redaction boundary is invalid' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_operation_intent_guard ON rorca.authority_operation_intents;
CREATE TRIGGER authority_operation_intent_guard
BEFORE INSERT ON rorca.authority_operation_intents
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_operation_intent();

CREATE OR REPLACE FUNCTION rorca.protect_authority_operation_intent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authority operation intents are immutable after persistence and approval' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS authority_operation_intent_immutable ON rorca.authority_operation_intents;
CREATE TRIGGER authority_operation_intent_immutable
BEFORE UPDATE OR DELETE ON rorca.authority_operation_intents
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_operation_intent();

CREATE OR REPLACE FUNCTION rorca.guard_authority_operation_intent_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  intent_row rorca.authority_operation_intents%ROWTYPE;
BEGIN
  SELECT * INTO intent_row
    FROM rorca.authority_operation_intents
   WHERE id = NEW.operation_intent_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR intent_row.workspace_id <> NEW.workspace_id
     OR intent_row.intent_digest <> NEW.intent_digest
     OR intent_row.ci_evidence_digest <> NEW.ci_evidence_digest THEN
    RAISE EXCEPTION 'authorization grant does not bind the exact operation intent and CI evidence' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS authority_operation_intent_grant_guard ON rorca.authority_operation_intent_grants;
CREATE TRIGGER authority_operation_intent_grant_guard
BEFORE INSERT ON rorca.authority_operation_intent_grants
FOR EACH ROW EXECUTE FUNCTION rorca.guard_authority_operation_intent_grant();

CREATE OR REPLACE FUNCTION rorca.protect_authority_operation_intent_grant()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'authority operation intent grants are immutable' USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS authority_operation_intent_grant_immutable ON rorca.authority_operation_intent_grants;
CREATE TRIGGER authority_operation_intent_grant_immutable
BEFORE UPDATE OR DELETE ON rorca.authority_operation_intent_grants
FOR EACH ROW EXECUTE FUNCTION rorca.protect_authority_operation_intent_grant();

REVOKE ALL PRIVILEGES ON TABLE rorca.authority_operation_intents FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.authority_operation_intent_grants FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NOT NULL AND runtime_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_user) THEN
    EXECUTE format('GRANT SELECT ON rorca.authority_operation_intents, rorca.authority_operation_intent_grants TO %I', runtime_user);
  END IF;
  IF writer_user IS NOT NULL AND writer_user <> '' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = writer_user) THEN
    EXECUTE format('GRANT SELECT, INSERT ON rorca.authority_operation_intents, rorca.authority_operation_intent_grants TO %I', writer_user);
  END IF;
END;
$$;
