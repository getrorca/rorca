-- REA-001: durable Execution Authority persistence.
--
-- runPgMigrations supplies one transaction for this entire file. A failed install
-- therefore leaves neither authority objects nor a schema_migrations marker.
-- Populated upgrades use a pre-migration backup and forward-fix migration; there
-- is intentionally no ad hoc down SQL. This migration never manages pgboss.

CREATE OR REPLACE FUNCTION rorca.authority_json_is_redacted_v1(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  item RECORD;
BEGIN
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR item IN SELECT key, value FROM jsonb_each(p_value) LOOP
      IF item.key ~* '(^|[_-])(secret|credential|password|token|authorization|private[_-]?key)([_-]|$)'
        OR NOT rorca.authority_json_is_redacted_v1(item.value)
      THEN
        RETURN FALSE;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF NOT rorca.authority_json_is_redacted_v1(item.value) THEN
        RETURN FALSE;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'string' AND trim(BOTH '"' FROM p_value::TEXT)
    ~* '(^Bearer[[:space:]]+|^Basic[[:space:]]+|^gh[pousr]_[A-Za-z0-9_]+$|^sk-[A-Za-z0-9_-]{16,}$)'
  THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.authority_reject_mutation_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Execution Authority audit rows are append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TABLE rorca.execution_authority_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  binding_reference TEXT NOT NULL CHECK (octet_length(binding_reference) BETWEEN 1 AND 256),
  generation BIGINT NOT NULL CHECK (generation > 0),
  capability_id TEXT NOT NULL CHECK (octet_length(capability_id) BETWEEN 1 AND 256),
  provider TEXT NOT NULL CHECK (octet_length(provider) BETWEEN 1 AND 128),
  environment TEXT NOT NULL CHECK (octet_length(environment) BETWEEN 1 AND 256),
  provider_resource_id TEXT NOT NULL CHECK (octet_length(provider_resource_id) BETWEEN 1 AND 1024),
  secret_reference TEXT NOT NULL
    CHECK (octet_length(secret_reference) <= 1024 AND secret_reference ~ '^(vault|infisical)://[^[:space:]]+$'),
  secret_fingerprint TEXT NOT NULL CHECK (secret_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale', 'revoked')),
  configuration_json JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(configuration_json) = 'object'
      AND octet_length(configuration_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(configuration_json)),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (workspace_id, binding_reference, generation),
  UNIQUE (workspace_id, id),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE OR REPLACE FUNCTION rorca.authority_provider_binding_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  expected_generation BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'authority-binding:' || NEW.workspace_id || ':' || NEW.binding_reference, 0
    ));
    SELECT COALESCE(MAX(generation), 0) + 1 INTO expected_generation
      FROM rorca.execution_authority_bindings
     WHERE workspace_id = NEW.workspace_id AND binding_reference = NEW.binding_reference;
    IF NEW.status <> 'active' OR NEW.revoked_at IS NOT NULL
      OR NEW.generation IS DISTINCT FROM expected_generation
    THEN
      RAISE EXCEPTION 'Stale provider binding generation or illegal initial state' USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.binding_reference IS DISTINCT FROM NEW.binding_reference
    OR OLD.generation IS DISTINCT FROM NEW.generation
    OR OLD.capability_id IS DISTINCT FROM NEW.capability_id
    OR OLD.provider IS DISTINCT FROM NEW.provider
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.secret_reference IS DISTINCT FROM NEW.secret_reference
    OR OLD.secret_fingerprint IS DISTINCT FROM NEW.secret_fingerprint
    OR OLD.configuration_json IS DISTINCT FROM NEW.configuration_json
    OR OLD.provenance_json IS DISTINCT FROM NEW.provenance_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Provider binding identity and scope are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active' OR NEW.status NOT IN ('stale', 'revoked') THEN
    RAISE EXCEPTION 'Illegal provider binding transition' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'revoked' THEN NEW.revoked_at := COALESCE(NEW.revoked_at, clock_timestamp()); END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER authority_provider_binding_guard
BEFORE INSERT OR UPDATE ON rorca.execution_authority_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.authority_provider_binding_guard_v1();

CREATE OR REPLACE FUNCTION rorca.authority_provider_binding_supersede_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
BEGIN
  UPDATE rorca.execution_authority_bindings
     SET status = 'stale'
   WHERE workspace_id = NEW.workspace_id
     AND binding_reference = NEW.binding_reference
     AND generation < NEW.generation
     AND status = 'active';
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_provider_binding_supersede
AFTER INSERT ON rorca.execution_authority_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.authority_provider_binding_supersede_v1();
CREATE TRIGGER authority_provider_binding_delete_guard
BEFORE DELETE ON rorca.execution_authority_bindings
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE TABLE rorca.operation_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL CHECK (octet_length(story_id) BETWEEN 1 AND 512),
  requesting_principal TEXT NOT NULL CHECK (octet_length(requesting_principal) BETWEEN 1 AND 512),
  capability_id TEXT NOT NULL CHECK (octet_length(capability_id) BETWEEN 1 AND 256),
  binding_reference TEXT NOT NULL,
  binding_generation BIGINT NOT NULL,
  environment TEXT NOT NULL CHECK (octet_length(environment) BETWEEN 1 AND 256),
  provider_resource_id TEXT NOT NULL CHECK (octet_length(provider_resource_id) BETWEEN 1 AND 1024),
  operation TEXT NOT NULL CHECK (octet_length(operation) BETWEEN 1 AND 256),
  constraints_json JSONB NOT NULL
    CHECK (jsonb_typeof(constraints_json) = 'object'
      AND octet_length(constraints_json::TEXT) <= 32768
      AND rorca.authority_json_is_redacted_v1(constraints_json)),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  canonical_digest TEXT NOT NULL CHECK (canonical_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'authorized', 'executing', 'settled', 'cancelled')),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, canonical_digest),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, binding_reference, binding_generation)
    REFERENCES rorca.execution_authority_bindings(workspace_id, binding_reference, generation) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (settled_at IS NULL OR settled_at >= created_at)
);

CREATE OR REPLACE FUNCTION rorca.operation_intent_insert_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  provider_binding rorca.execution_authority_bindings%ROWTYPE;
BEGIN
  SELECT * INTO STRICT provider_binding FROM rorca.execution_authority_bindings
   WHERE workspace_id = NEW.workspace_id
     AND binding_reference = NEW.binding_reference
     AND generation = NEW.binding_generation;
  IF NOT EXISTS (
      SELECT 1 FROM rorca.pipeline_runs
       WHERE id = NEW.run_id AND workspace_id = NEW.workspace_id
    )
    OR NEW.status <> 'proposed' OR NEW.settled_at IS NOT NULL
    OR provider_binding.status <> 'active'
    OR (provider_binding.capability_id, provider_binding.environment, provider_binding.provider_resource_id)
       IS DISTINCT FROM
       (NEW.capability_id, NEW.environment, NEW.provider_resource_id)
  THEN
    RAISE EXCEPTION 'Operation intent does not match the active provider binding' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.operation_intent_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.story_id IS DISTINCT FROM NEW.story_id
    OR OLD.requesting_principal IS DISTINCT FROM NEW.requesting_principal
    OR OLD.capability_id IS DISTINCT FROM NEW.capability_id
    OR OLD.binding_reference IS DISTINCT FROM NEW.binding_reference
    OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.constraints_json IS DISTINCT FROM NEW.constraints_json
    OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR OLD.canonical_digest IS DISTINCT FROM NEW.canonical_digest
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.provenance_json IS DISTINCT FROM NEW.provenance_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Operation intent identity and scope are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('authorized', 'cancelled'))
    OR (OLD.status = 'authorized' AND NEW.status IN ('executing', 'cancelled'))
    OR (OLD.status = 'executing' AND NEW.status IN ('settled', 'cancelled')))
  THEN
    RAISE EXCEPTION 'Illegal operation intent transition' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'settled' THEN NEW.settled_at := COALESCE(NEW.settled_at, clock_timestamp()); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operation_intent_insert_guard
BEFORE INSERT ON rorca.operation_intents
FOR EACH ROW EXECUTE FUNCTION rorca.operation_intent_insert_guard_v1();
CREATE TRIGGER operation_intent_guard
BEFORE UPDATE ON rorca.operation_intents
FOR EACH ROW EXECUTE FUNCTION rorca.operation_intent_guard_v1();
CREATE TRIGGER operation_intent_delete_guard
BEFORE DELETE ON rorca.operation_intents
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE TABLE rorca.authority_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL,
  intent_id UUID NOT NULL,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  requesting_principal TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  binding_reference TEXT NOT NULL,
  binding_generation BIGINT NOT NULL,
  environment TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  constraints_json JSONB NOT NULL
    CHECK (jsonb_typeof(constraints_json) = 'object'
      AND octet_length(constraints_json::TEXT) <= 32768
      AND rorca.authority_json_is_redacted_v1(constraints_json)),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired')),
  maximum_uses INTEGER NOT NULL CHECK (maximum_uses BETWEEN 1 AND 1000),
  expires_at TIMESTAMPTZ NOT NULL,
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (workspace_id, request_digest),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES rorca.operation_intents(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_reference, binding_generation)
    REFERENCES rorca.execution_authority_bindings(workspace_id, binding_reference, generation) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CHECK (resolved_at IS NULL OR resolved_at >= created_at)
);

CREATE OR REPLACE FUNCTION rorca.authority_request_insert_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  operation_intent rorca.operation_intents%ROWTYPE;
BEGIN
  SELECT * INTO STRICT operation_intent FROM rorca.operation_intents
   WHERE workspace_id = NEW.workspace_id AND id = NEW.intent_id;
  IF NEW.status <> 'pending' OR NEW.resolved_at IS NOT NULL
    OR operation_intent.status <> 'proposed'
    OR (operation_intent.run_id, operation_intent.story_id, operation_intent.requesting_principal,
        operation_intent.capability_id, operation_intent.binding_reference,
        operation_intent.binding_generation, operation_intent.environment,
        operation_intent.provider_resource_id, operation_intent.operation,
        operation_intent.constraints_json, operation_intent.evidence_digest)
       IS DISTINCT FROM
       (NEW.run_id, NEW.story_id, NEW.requesting_principal, NEW.capability_id,
        NEW.binding_reference, NEW.binding_generation, NEW.environment,
        NEW.provider_resource_id, NEW.operation, NEW.constraints_json, NEW.evidence_digest)
  THEN
    RAISE EXCEPTION 'Authority request does not match its proposed operation intent' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.authority_request_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.intent_id IS DISTINCT FROM NEW.intent_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.story_id IS DISTINCT FROM NEW.story_id
    OR OLD.requesting_principal IS DISTINCT FROM NEW.requesting_principal
    OR OLD.capability_id IS DISTINCT FROM NEW.capability_id
    OR OLD.binding_reference IS DISTINCT FROM NEW.binding_reference
    OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.constraints_json IS DISTINCT FROM NEW.constraints_json
    OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.maximum_uses IS DISTINCT FROM NEW.maximum_uses
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
    OR OLD.provenance_json IS DISTINCT FROM NEW.provenance_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Authority request digest and scope are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved', 'denied', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'Illegal authority request transition' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  NEW.resolved_at := COALESCE(NEW.resolved_at, clock_timestamp());
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_request_insert_guard
BEFORE INSERT ON rorca.authority_requests
FOR EACH ROW EXECUTE FUNCTION rorca.authority_request_insert_guard_v1();
CREATE TRIGGER authority_request_guard
BEFORE UPDATE ON rorca.authority_requests
FOR EACH ROW EXECUTE FUNCTION rorca.authority_request_guard_v1();
CREATE TRIGGER authority_request_delete_guard
BEFORE DELETE ON rorca.authority_requests
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE TABLE rorca.authority_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  requesting_principal TEXT NOT NULL,
  operator_principal TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'denied')),
  decision_digest TEXT NOT NULL CHECK (decision_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  reason_code TEXT NOT NULL CHECK (octet_length(reason_code) BETWEEN 1 AND 256),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, request_id),
  UNIQUE (workspace_id, decision_digest),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES rorca.authority_requests(workspace_id, id) ON DELETE RESTRICT,
  CHECK (requesting_principal <> operator_principal)
);

CREATE OR REPLACE FUNCTION rorca.authority_decision_apply_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  authority_request rorca.authority_requests%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority_request
    FROM rorca.authority_requests
   WHERE workspace_id = NEW.workspace_id AND id = NEW.request_id
   FOR UPDATE;
  IF authority_request.status <> 'pending'
    OR authority_request.expires_at <= clock_timestamp()
    OR authority_request.request_digest IS DISTINCT FROM NEW.request_digest
    OR authority_request.requesting_principal IS DISTINCT FROM NEW.requesting_principal
  THEN
    RAISE EXCEPTION 'Decision requires the exact current unexpired request digest' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION rorca.authority_decision_resolve_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
BEGIN
  UPDATE rorca.authority_requests
     SET status = NEW.decision, resolved_at = clock_timestamp()
   WHERE workspace_id = NEW.workspace_id AND id = NEW.request_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_decision_apply
BEFORE INSERT ON rorca.authority_decisions
FOR EACH ROW EXECUTE FUNCTION rorca.authority_decision_apply_v1();
CREATE TRIGGER authority_decision_resolve
AFTER INSERT ON rorca.authority_decisions
FOR EACH ROW EXECUTE FUNCTION rorca.authority_decision_resolve_v1();
CREATE TRIGGER authority_decision_mutation_guard
BEFORE UPDATE OR DELETE ON rorca.authority_decisions
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE TABLE rorca.authority_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL,
  request_id UUID NOT NULL,
  decision_id UUID NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  binding_reference TEXT NOT NULL,
  binding_generation BIGINT NOT NULL,
  environment TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  constraints_json JSONB NOT NULL
    CHECK (jsonb_typeof(constraints_json) = 'object'
      AND octet_length(constraints_json::TEXT) <= 32768
      AND rorca.authority_json_is_redacted_v1(constraints_json)),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  secret_reference TEXT NOT NULL
    CHECK (octet_length(secret_reference) <= 1024 AND secret_reference ~ '^(vault|infisical)://[^[:space:]]+$'),
  secret_fingerprint TEXT NOT NULL CHECK (secret_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  maximum_uses INTEGER NOT NULL CHECK (maximum_uses BETWEEN 1 AND 1000),
  uses_consumed INTEGER NOT NULL DEFAULT 0 CHECK (uses_consumed >= 0 AND uses_consumed <= maximum_uses),
  fencing_generation BIGINT NOT NULL DEFAULT 1 CHECK (fencing_generation > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'expired', 'revoked')),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (workspace_id, decision_id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, request_id)
    REFERENCES rorca.authority_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, decision_id)
    REFERENCES rorca.authority_decisions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_reference, binding_generation)
    REFERENCES rorca.execution_authority_bindings(workspace_id, binding_reference, generation) ON DELETE RESTRICT,
  CHECK (expires_at >= created_at),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'active' AND uses_consumed < maximum_uses)
    OR (status = 'exhausted' AND uses_consumed = maximum_uses)
    OR status IN ('expired', 'revoked')),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE OR REPLACE FUNCTION rorca.authority_grant_insert_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  authority_request rorca.authority_requests%ROWTYPE;
  authority_decision rorca.authority_decisions%ROWTYPE;
  provider_binding rorca.execution_authority_bindings%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority_request FROM rorca.authority_requests
   WHERE workspace_id = NEW.workspace_id AND id = NEW.request_id;
  SELECT * INTO STRICT authority_decision FROM rorca.authority_decisions
   WHERE workspace_id = NEW.workspace_id AND id = NEW.decision_id;
  SELECT * INTO STRICT provider_binding FROM rorca.execution_authority_bindings
   WHERE workspace_id = NEW.workspace_id
     AND binding_reference = NEW.binding_reference AND generation = NEW.binding_generation;
  IF NEW.status <> 'active' OR NEW.uses_consumed <> 0 OR NEW.revoked_at IS NOT NULL
    OR NEW.expires_at <= clock_timestamp()
    OR NEW.expires_at > authority_request.expires_at
    OR authority_request.status <> 'approved'
    OR authority_decision.decision <> 'approved'
    OR authority_decision.request_id IS DISTINCT FROM NEW.request_id
    OR authority_request.request_digest IS DISTINCT FROM NEW.request_digest
    OR (authority_request.run_id, authority_request.story_id, authority_request.capability_id,
        authority_request.binding_reference, authority_request.binding_generation,
        authority_request.environment, authority_request.provider_resource_id,
        authority_request.operation, authority_request.constraints_json, authority_request.evidence_digest,
        authority_request.maximum_uses)
       IS DISTINCT FROM
       (NEW.run_id, NEW.story_id, NEW.capability_id, NEW.binding_reference, NEW.binding_generation,
        NEW.environment, NEW.provider_resource_id, NEW.operation, NEW.constraints_json,
        NEW.evidence_digest, NEW.maximum_uses)
    OR provider_binding.status <> 'active'
    OR provider_binding.secret_reference IS DISTINCT FROM NEW.secret_reference
    OR provider_binding.secret_fingerprint IS DISTINCT FROM NEW.secret_fingerprint
    OR provider_binding.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
  THEN
    RAISE EXCEPTION 'Grant does not bind the exact approved request and active provider binding' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.authority_grant_update_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.request_id IS DISTINCT FROM NEW.request_id
    OR OLD.decision_id IS DISTINCT FROM NEW.decision_id
    OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.story_id IS DISTINCT FROM NEW.story_id
    OR OLD.capability_id IS DISTINCT FROM NEW.capability_id
    OR OLD.binding_reference IS DISTINCT FROM NEW.binding_reference
    OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.constraints_json IS DISTINCT FROM NEW.constraints_json
    OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR OLD.secret_reference IS DISTINCT FROM NEW.secret_reference
    OR OLD.secret_fingerprint IS DISTINCT FROM NEW.secret_fingerprint
    OR OLD.maximum_uses IS DISTINCT FROM NEW.maximum_uses
    OR OLD.fencing_generation IS DISTINCT FROM NEW.fencing_generation
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.provenance_json IS DISTINCT FROM NEW.provenance_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
  THEN
    RAISE EXCEPTION 'Authority grant identity and scope are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'active'
    OR NEW.status NOT IN ('active', 'exhausted', 'expired', 'revoked')
    OR NEW.uses_consumed < OLD.uses_consumed
    OR NEW.uses_consumed > OLD.uses_consumed + 1
    OR (NEW.status = 'active' AND NEW.uses_consumed = OLD.uses_consumed)
  THEN
    RAISE EXCEPTION 'Illegal authority grant transition or use count' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'revoked' THEN NEW.revoked_at := COALESCE(NEW.revoked_at, clock_timestamp()); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_grant_insert_guard
BEFORE INSERT ON rorca.authority_grants
FOR EACH ROW EXECUTE FUNCTION rorca.authority_grant_insert_guard_v1();
CREATE TRIGGER authority_grant_update_guard
BEFORE UPDATE ON rorca.authority_grants
FOR EACH ROW EXECUTE FUNCTION rorca.authority_grant_update_guard_v1();
CREATE TRIGGER authority_grant_delete_guard
BEFORE DELETE ON rorca.authority_grants
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE OR REPLACE FUNCTION rorca.consume_authority_grant_v1(
  p_grant_id UUID,
  p_request_digest TEXT,
  p_workspace_id TEXT,
  p_run_id BIGINT,
  p_story_id TEXT,
  p_environment TEXT,
  p_provider_resource_id TEXT,
  p_operation TEXT,
  p_fencing_generation BIGINT
)
RETURNS rorca.authority_grants
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  authority_grant rorca.authority_grants%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority_grant FROM rorca.authority_grants WHERE id = p_grant_id FOR UPDATE;
  IF authority_grant.status <> 'active'
    OR authority_grant.expires_at <= clock_timestamp()
    OR authority_grant.request_digest IS DISTINCT FROM p_request_digest
    OR (authority_grant.workspace_id, authority_grant.run_id, authority_grant.story_id,
        authority_grant.environment, authority_grant.provider_resource_id,
        authority_grant.operation, authority_grant.fencing_generation)
       IS DISTINCT FROM
       (p_workspace_id, p_run_id, p_story_id, p_environment, p_provider_resource_id,
        p_operation, p_fencing_generation)
  THEN
    RAISE EXCEPTION 'Exact active unexpired authority grant required' USING ERRCODE = '42501';
  END IF;
  UPDATE rorca.authority_grants
     SET uses_consumed = uses_consumed + 1,
         status = CASE WHEN uses_consumed + 1 = maximum_uses THEN 'exhausted' ELSE 'active' END
   WHERE id = p_grant_id
   RETURNING * INTO authority_grant;
  RETURN authority_grant;
END;
$$;

CREATE TABLE rorca.credential_leases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL,
  grant_id UUID NOT NULL,
  binding_reference TEXT NOT NULL,
  binding_generation BIGINT NOT NULL,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  lease_purpose TEXT NOT NULL CHECK (octet_length(lease_purpose) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  secret_reference TEXT NOT NULL
    CHECK (octet_length(secret_reference) <= 1024 AND secret_reference ~ '^(vault|infisical)://[^[:space:]]+$'),
  secret_fingerprint TEXT NOT NULL CHECK (secret_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  fencing_generation BIGINT NOT NULL CHECK (fencing_generation > 0),
  maximum_uses INTEGER NOT NULL CHECK (maximum_uses BETWEEN 1 AND 1000),
  uses_consumed INTEGER NOT NULL DEFAULT 0 CHECK (uses_consumed >= 0 AND uses_consumed <= maximum_uses),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'active', 'exhausted', 'revoked', 'expired', 'reconciliation_required')),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  CONSTRAINT credential_leases_workspace_idempotency_key_uniq
    UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, grant_id, fencing_generation),
  FOREIGN KEY (workspace_id, grant_id)
    REFERENCES rorca.authority_grants(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_reference, binding_generation)
    REFERENCES rorca.execution_authority_bindings(workspace_id, binding_reference, generation) ON DELETE RESTRICT,
  CHECK (expires_at >= created_at),
  CHECK ((status IN ('prepared', 'active') AND uses_consumed < maximum_uses)
    OR (status = 'exhausted' AND uses_consumed = maximum_uses)
    OR status IN ('reconciliation_required', 'revoked', 'expired')),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE OR REPLACE FUNCTION rorca.credential_lease_insert_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  authority_grant rorca.authority_grants%ROWTYPE;
  provider_binding rorca.execution_authority_bindings%ROWTYPE;
BEGIN
  SELECT * INTO STRICT authority_grant FROM rorca.authority_grants
   WHERE workspace_id = NEW.workspace_id AND id = NEW.grant_id;
  SELECT * INTO STRICT provider_binding FROM rorca.execution_authority_bindings
   WHERE workspace_id = NEW.workspace_id
     AND binding_reference = NEW.binding_reference AND generation = NEW.binding_generation;
  IF NEW.status <> 'prepared' OR NEW.uses_consumed <> 0
    OR authority_grant.status NOT IN ('active', 'exhausted')
    OR authority_grant.uses_consumed < 1
    OR NEW.maximum_uses > authority_grant.maximum_uses
    OR NEW.fencing_generation IS DISTINCT FROM authority_grant.fencing_generation
    OR NEW.expires_at > authority_grant.expires_at
    OR (authority_grant.run_id, authority_grant.story_id, authority_grant.binding_reference,
        authority_grant.binding_generation, authority_grant.environment,
        authority_grant.provider_resource_id, authority_grant.operation,
        authority_grant.secret_reference, authority_grant.secret_fingerprint)
       IS DISTINCT FROM
       (NEW.run_id, NEW.story_id, NEW.binding_reference, NEW.binding_generation,
        NEW.environment, NEW.provider_resource_id, NEW.operation,
        NEW.secret_reference, NEW.secret_fingerprint)
    OR provider_binding.status <> 'active'
  THEN
    RAISE EXCEPTION 'Credential lease does not match its consumed grant and active binding' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

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
CREATE TRIGGER credential_lease_insert_guard
BEFORE INSERT ON rorca.credential_leases
FOR EACH ROW EXECUTE FUNCTION rorca.credential_lease_insert_guard_v1();
CREATE TRIGGER credential_lease_guard
BEFORE UPDATE ON rorca.credential_leases
FOR EACH ROW EXECUTE FUNCTION rorca.credential_lease_guard_v1();
CREATE TRIGGER credential_lease_delete_guard
BEFORE DELETE ON rorca.credential_leases
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE TABLE rorca.execution_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL,
  intent_id UUID NOT NULL,
  grant_id UUID NOT NULL,
  lease_id UUID NOT NULL,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 512),
  fencing_generation BIGINT NOT NULL CHECK (fencing_generation > 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'running', 'uncertain', 'settled')),
  provider_operation_reference TEXT
    CHECK (provider_operation_reference IS NULL OR octet_length(provider_operation_reference) BETWEEN 1 AND 1024),
  failure_digest TEXT CHECK (failure_digest IS NULL OR failure_digest ~ '^sha256:[0-9a-f]{64}$'),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  started_at TIMESTAMPTZ,
  uncertain_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key, fencing_generation),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES rorca.operation_intents(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, grant_id)
    REFERENCES rorca.authority_grants(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, lease_id)
    REFERENCES rorca.credential_leases(workspace_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK ((status IN ('running', 'uncertain', 'settled')) = (started_at IS NOT NULL)),
  CHECK ((status IN ('uncertain', 'settled') AND uncertain_at IS NOT NULL) OR status NOT IN ('uncertain')),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (started_at IS NULL OR started_at >= created_at),
  CHECK (uncertain_at IS NULL OR uncertain_at >= started_at),
  CHECK (settled_at IS NULL OR settled_at >= started_at)
);

CREATE OR REPLACE FUNCTION rorca.execution_attempt_insert_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  latest_attempt rorca.execution_attempts%ROWTYPE;
  authority_grant rorca.authority_grants%ROWTYPE;
  credential_lease rorca.credential_leases%ROWTYPE;
BEGIN
  IF NEW.status <> 'reserved' OR NEW.started_at IS NOT NULL
    OR NEW.uncertain_at IS NOT NULL OR NEW.settled_at IS NOT NULL
  THEN
    RAISE EXCEPTION 'Execution attempt must begin reserved' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'authority-attempt:' || NEW.workspace_id || ':' || NEW.idempotency_key, 0
  ));
  SELECT * INTO latest_attempt FROM rorca.execution_attempts
   WHERE workspace_id = NEW.workspace_id AND idempotency_key = NEW.idempotency_key
   ORDER BY fencing_generation DESC LIMIT 1;
  IF latest_attempt.id IS NULL THEN
    IF NEW.fencing_generation <> 1 THEN
      RAISE EXCEPTION 'Initial execution fencing generation must be one' USING ERRCODE = '40001';
    END IF;
  ELSIF latest_attempt.status <> 'uncertain'
    OR NEW.fencing_generation <> latest_attempt.fencing_generation + 1
  THEN
    RAISE EXCEPTION 'Stale or duplicate execution fencing generation' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO STRICT authority_grant FROM rorca.authority_grants
   WHERE workspace_id = NEW.workspace_id AND id = NEW.grant_id;
  SELECT * INTO STRICT credential_lease FROM rorca.credential_leases
   WHERE workspace_id = NEW.workspace_id AND id = NEW.lease_id;
  IF authority_grant.request_digest IS DISTINCT FROM NEW.request_digest
    OR authority_grant.uses_consumed < 1
    OR authority_grant.status NOT IN ('active', 'exhausted')
    OR authority_grant.expires_at <= clock_timestamp()
    OR credential_lease.grant_id IS DISTINCT FROM NEW.grant_id
    OR credential_lease.status <> 'active'
    OR credential_lease.expires_at <= clock_timestamp()
    OR (authority_grant.run_id, authority_grant.story_id, authority_grant.environment,
        authority_grant.provider_resource_id, authority_grant.operation)
       IS DISTINCT FROM
       (NEW.run_id, NEW.story_id, NEW.environment, NEW.provider_resource_id, NEW.operation)
    OR (credential_lease.run_id, credential_lease.story_id, credential_lease.environment,
        credential_lease.provider_resource_id, credential_lease.operation)
       IS DISTINCT FROM
       (NEW.run_id, NEW.story_id, NEW.environment, NEW.provider_resource_id, NEW.operation)
  THEN
    RAISE EXCEPTION 'Execution attempt lacks exact consumed grant and active lease scope' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.execution_attempt_update_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  latest_generation BIGINT;
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.intent_id IS DISTINCT FROM NEW.intent_id
    OR OLD.grant_id IS DISTINCT FROM NEW.grant_id
    OR OLD.lease_id IS DISTINCT FROM NEW.lease_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.story_id IS DISTINCT FROM NEW.story_id
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.request_digest IS DISTINCT FROM NEW.request_digest
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.fencing_generation IS DISTINCT FROM NEW.fencing_generation
    OR OLD.provenance_json IS DISTINCT FROM NEW.provenance_json
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Execution attempt identity and scope are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT MAX(fencing_generation) INTO latest_generation
    FROM rorca.execution_attempts
   WHERE workspace_id = OLD.workspace_id AND idempotency_key = OLD.idempotency_key;
  IF OLD.fencing_generation IS DISTINCT FROM latest_generation THEN
    RAISE EXCEPTION 'Stale execution fencing generation cannot transition' USING ERRCODE = '40001';
  END IF;
  IF NOT ((OLD.status = 'reserved' AND NEW.status IN ('running', 'uncertain'))
    OR (OLD.status = 'running' AND NEW.status IN ('uncertain', 'settled'))
    OR (OLD.status = 'uncertain' AND NEW.status = 'settled'))
  THEN
    RAISE EXCEPTION 'Illegal execution attempt transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.status = 'settled' AND NOT EXISTS (
    SELECT 1 FROM rorca.execution_receipts receipt WHERE receipt.attempt_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Execution attempt settlement requires an append-only receipt' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status IN ('running', 'uncertain', 'settled') THEN NEW.started_at := COALESCE(NEW.started_at, clock_timestamp()); END IF;
  IF NEW.status = 'uncertain' THEN NEW.uncertain_at := COALESCE(NEW.uncertain_at, clock_timestamp()); END IF;
  IF NEW.status = 'settled' THEN NEW.settled_at := COALESCE(NEW.settled_at, clock_timestamp()); END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_attempt_insert_guard
BEFORE INSERT ON rorca.execution_attempts
FOR EACH ROW EXECUTE FUNCTION rorca.execution_attempt_insert_guard_v1();
CREATE TRIGGER execution_attempt_update_guard
BEFORE UPDATE ON rorca.execution_attempts
FOR EACH ROW EXECUTE FUNCTION rorca.execution_attempt_update_guard_v1();
CREATE TRIGGER execution_attempt_delete_guard
BEFORE DELETE ON rorca.execution_attempts
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE TABLE rorca.execution_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority.v1'
    CHECK (schema_version = 'rorca.execution-authority.v1'),
  workspace_id TEXT NOT NULL,
  attempt_id UUID NOT NULL,
  intent_id UUID NOT NULL,
  grant_id UUID NOT NULL,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  story_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  receipt_digest TEXT NOT NULL CHECK (receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key TEXT NOT NULL,
  fencing_generation BIGINT NOT NULL CHECK (fencing_generation > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'reconciled_succeeded', 'reconciled_failed')),
  provider_receipt_reference TEXT NOT NULL CHECK (octet_length(provider_receipt_reference) BETWEEN 1 AND 1024),
  secret_reference TEXT NOT NULL
    CHECK (octet_length(secret_reference) <= 1024 AND secret_reference ~ '^(vault|infisical)://[^[:space:]]+$'),
  secret_fingerprint TEXT NOT NULL CHECK (secret_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  redacted_payload JSONB NOT NULL
    CHECK (jsonb_typeof(redacted_payload) = 'object'
      AND octet_length(redacted_payload::TEXT) <= 32768
      AND rorca.authority_json_is_redacted_v1(redacted_payload)),
  provenance_json JSONB NOT NULL
    CHECK (jsonb_typeof(provenance_json) = 'object'
      AND octet_length(provenance_json::TEXT) <= 16384
      AND rorca.authority_json_is_redacted_v1(provenance_json)),
  status TEXT NOT NULL DEFAULT 'settled' CHECK (status = 'settled'),
  retention_class TEXT NOT NULL CHECK (retention_class IN ('standard', 'extended', 'legal_hold')),
  retained_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, attempt_id),
  UNIQUE (workspace_id, receipt_digest),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, attempt_id)
    REFERENCES rorca.execution_attempts(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, intent_id)
    REFERENCES rorca.operation_intents(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, grant_id)
    REFERENCES rorca.authority_grants(workspace_id, id) ON DELETE RESTRICT,
  CHECK (settled_at >= created_at),
  CHECK (retention_class = 'legal_hold' OR retained_until IS NOT NULL),
  CHECK (retained_until IS NULL OR retained_until >= settled_at)
);

CREATE OR REPLACE FUNCTION rorca.execution_receipt_settle_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  execution_attempt rorca.execution_attempts%ROWTYPE;
  latest_generation BIGINT;
BEGIN
  SELECT * INTO STRICT execution_attempt FROM rorca.execution_attempts
   WHERE workspace_id = NEW.workspace_id AND id = NEW.attempt_id FOR UPDATE;
  SELECT MAX(fencing_generation) INTO latest_generation FROM rorca.execution_attempts
   WHERE workspace_id = NEW.workspace_id AND idempotency_key = execution_attempt.idempotency_key;
  IF execution_attempt.status NOT IN ('running', 'uncertain')
    OR execution_attempt.fencing_generation IS DISTINCT FROM latest_generation
    OR (execution_attempt.intent_id, execution_attempt.grant_id, execution_attempt.run_id,
        execution_attempt.story_id, execution_attempt.environment,
        execution_attempt.provider_resource_id, execution_attempt.operation,
        execution_attempt.request_digest, execution_attempt.idempotency_key,
        execution_attempt.fencing_generation)
       IS DISTINCT FROM
       (NEW.intent_id, NEW.grant_id, NEW.run_id, NEW.story_id, NEW.environment,
        NEW.provider_resource_id, NEW.operation, NEW.request_digest,
        NEW.idempotency_key, NEW.fencing_generation)
  THEN
    RAISE EXCEPTION 'Receipt does not settle the latest exact execution attempt' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION rorca.execution_receipt_finish_attempt_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
BEGIN
  UPDATE rorca.execution_attempts SET status = 'settled'
   WHERE workspace_id = NEW.workspace_id AND id = NEW.attempt_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER execution_receipt_settle
BEFORE INSERT ON rorca.execution_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.execution_receipt_settle_v1();
CREATE TRIGGER execution_receipt_finish_attempt
AFTER INSERT ON rorca.execution_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.execution_receipt_finish_attempt_v1();
CREATE TRIGGER execution_receipt_mutation_guard
BEFORE UPDATE OR DELETE ON rorca.execution_receipts
FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE INDEX authority_requests_inbox_idx
  ON rorca.authority_requests(workspace_id, status, expires_at, created_at);
CREATE INDEX authority_grants_scope_idx
  ON rorca.authority_grants(workspace_id, run_id, story_id, status, expires_at);
CREATE INDEX credential_leases_scope_idx
  ON rorca.credential_leases(workspace_id, run_id, story_id, status, expires_at);
CREATE INDEX execution_attempts_recovery_idx
  ON rorca.execution_attempts(workspace_id, status, updated_at)
  WHERE status IN ('reserved', 'running', 'uncertain');
CREATE INDEX execution_receipts_retention_idx
  ON rorca.execution_receipts(workspace_id, retention_class, retained_until);

REVOKE ALL ON TABLE
  rorca.execution_authority_bindings,
  rorca.operation_intents,
  rorca.authority_requests,
  rorca.authority_decisions,
  rorca.authority_grants,
  rorca.credential_leases,
  rorca.execution_attempts,
  rorca.execution_receipts
  FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION rorca.authority_json_is_redacted_v1(JSONB) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION rorca.consume_authority_grant_v1(
  UUID, TEXT, TEXT, BIGINT, TEXT, TEXT, TEXT, TEXT, BIGINT
) FROM PUBLIC, authenticated, anon;

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
    'GRANT SELECT, INSERT, UPDATE ON TABLE rorca.execution_authority_bindings, rorca.operation_intents, rorca.authority_requests, rorca.authority_grants, rorca.credential_leases, rorca.execution_attempts TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE rorca.authority_decisions, rorca.execution_receipts TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION rorca.authority_json_is_redacted_v1(JSONB) TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION rorca.consume_authority_grant_v1(UUID,TEXT,TEXT,BIGINT,TEXT,TEXT,TEXT,TEXT,BIGINT) TO %I',
    runtime_user
  );
END;
$$;

COMMENT ON TABLE rorca.operation_intents IS
  'REA-001 OperationIntent v1; exact provider effect scope and canonical digest.';
COMMENT ON TABLE rorca.authority_requests IS
  'REA-001 AuthorityRequest v1; immutable operator decision subject with independent expiry.';
COMMENT ON TABLE rorca.authority_decisions IS
  'REA-001 AuthorityDecision v1; append-only exact-digest decision by a distinct operator principal.';
COMMENT ON TABLE rorca.authority_grants IS
  'REA-001 AuthorityGrant v1; exact scope, bounded uses, expiry, and opaque secret reference only.';
COMMENT ON TABLE rorca.credential_leases IS
  'REA-001 CredentialLease v1; fenced minimum-lifetime opaque secret binding.';
COMMENT ON TABLE rorca.execution_attempts IS
  'REA-001 ExecutionAttempt v1; monotonically fenced reserved/running/uncertain/settled durability.';
COMMENT ON TABLE rorca.execution_receipts IS
  'REA-001 ExecutionReceipt v1; settled append-only redacted provider evidence with queryable retention metadata.';
COMMENT ON TABLE rorca.execution_authority_bindings IS
  'REA-001 ProviderBinding v1; versioned provider resource and reference-only credential binding.';
