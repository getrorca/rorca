-- REA-003: durable run-level Execution Authority preflight.
--
-- The migration runner wraps this file and its schema marker in one transaction.
-- Populated upgrades remain forward-fix plus backup/restore. This migration owns
-- application tables only and never reads, writes, or manages pgboss objects.

ALTER TABLE rorca.pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_lifecycle_status_check;
ALTER TABLE rorca.pipeline_runs
  ADD CONSTRAINT pipeline_runs_lifecycle_status_check CHECK (lifecycle_status IN (
    'queued', 'waiting_for_authorization', 'waiting_for_authentication',
    'waiting_for_change_window', 'starting', 'pty_attached', 'running',
    'validating', 'finished', 'failed', 'cancelled'
  ));

CREATE OR REPLACE FUNCTION rorca.pipeline_runs_assign_initial_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.lifecycle_status IS NULL THEN
    NEW.lifecycle_status := CASE
      WHEN NEW.status = 'queued' THEN 'queued'
      WHEN NEW.status = 'WAITING_FOR_AUTHORIZATION' THEN 'waiting_for_authorization'
      WHEN NEW.status = 'WAITING_FOR_AUTHENTICATION' THEN 'waiting_for_authentication'
      WHEN NEW.status = 'WAITING_FOR_CHANGE_WINDOW' THEN 'waiting_for_change_window'
      WHEN NEW.status = 'cancelled' THEN 'cancelled'
      WHEN NEW.status = 'done' THEN 'finished'
      WHEN NEW.status IN ('failed', 'partial_failure') THEN 'failed'
      ELSE 'running'
    END;
  END IF;
  NEW.lifecycle_updated_at := COALESCE(NEW.lifecycle_updated_at, clock_timestamp());
  RETURN NEW;
END;
$$;

CREATE TABLE rorca.authority_run_preflights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority-preflight.v1'
    CHECK (schema_version = 'rorca.execution-authority-preflight.v1'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  spec_revision TEXT NOT NULL CHECK (spec_revision ~ '^sha256:[0-9a-f]{64}$'),
  environment TEXT NOT NULL CHECK (octet_length(environment) BETWEEN 1 AND 256),
  policy_revision TEXT NOT NULL CHECK (policy_revision ~ '^sha256:[0-9a-f]{64}$'),
  preflight_digest TEXT NOT NULL CHECK (preflight_digest ~ '^sha256:[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN (
    'AUTHORIZED', 'WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_AUTHENTICATION',
    'WAITING_FOR_CHANGE_WINDOW', 'INVALIDATED'
  )),
  wait_expires_at TIMESTAMPTZ,
  pending_story_position INTEGER NOT NULL DEFAULT 0 CHECK (pending_story_position >= 0),
  invalidation_reason TEXT CHECK (invalidation_reason IS NULL OR octet_length(invalidation_reason) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  invalidated_at TIMESTAMPTZ,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, run_id, preflight_digest),
  CHECK (updated_at >= created_at),
  CHECK ((status = 'INVALIDATED') = (invalidated_at IS NOT NULL)),
  CHECK ((status IN ('WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_AUTHENTICATION', 'WAITING_FOR_CHANGE_WINDOW'))
    = (wait_expires_at IS NOT NULL)),
  CHECK (wait_expires_at IS NULL OR wait_expires_at > created_at),
  CHECK (invalidated_at IS NULL OR invalidated_at >= created_at)
);
CREATE UNIQUE INDEX authority_run_preflights_one_active_idx
  ON rorca.authority_run_preflights(workspace_id, run_id)
  WHERE invalidated_at IS NULL;
CREATE INDEX authority_run_preflights_wait_idx
  ON rorca.authority_run_preflights(workspace_id, status, wait_expires_at)
  WHERE invalidated_at IS NULL;

CREATE TABLE rorca.authority_preflight_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version TEXT NOT NULL DEFAULT 'rorca.execution-authority-preflight.v1'
    CHECK (schema_version = 'rorca.execution-authority-preflight.v1'),
  workspace_id TEXT NOT NULL,
  run_id BIGINT NOT NULL REFERENCES rorca.pipeline_runs(id) ON DELETE RESTRICT,
  preflight_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  story_id TEXT NOT NULL CHECK (octet_length(story_id) BETWEEN 1 AND 512),
  capability_id TEXT NOT NULL CHECK (octet_length(capability_id) BETWEEN 1 AND 256),
  binding_reference TEXT NOT NULL CHECK (octet_length(binding_reference) BETWEEN 1 AND 256),
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  environment TEXT NOT NULL CHECK (octet_length(environment) BETWEEN 1 AND 256),
  provider_resource_id TEXT NOT NULL CHECK (octet_length(provider_resource_id) BETWEEN 1 AND 1024),
  requested_mode TEXT NOT NULL CHECK (octet_length(requested_mode) BETWEEN 1 AND 256),
  constraints_json JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(constraints_json) = 'object'
      AND octet_length(constraints_json::TEXT) <= 32768
      AND rorca.authority_json_is_redacted_v1(constraints_json)),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  requirement_digest TEXT NOT NULL CHECK (requirement_digest ~ '^sha256:[0-9a-f]{64}$'),
  adapter_id TEXT NOT NULL CHECK (octet_length(adapter_id) BETWEEN 1 AND 256),
  adapter_policy_revision TEXT NOT NULL CHECK (adapter_policy_revision ~ '^sha256:[0-9a-f]{64}$'),
  binding_health TEXT NOT NULL CHECK (binding_health IN ('healthy', 'unhealthy')),
  credential_mintability TEXT NOT NULL CHECK (credential_mintability IN ('mintable', 'authentication_required', 'unavailable')),
  change_window TEXT NOT NULL CHECK (change_window IN ('open', 'closed')),
  outcome TEXT NOT NULL CHECK (outcome IN (
    'AUTHORIZED', 'WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_AUTHENTICATION',
    'WAITING_FOR_CHANGE_WINDOW'
  )),
  operation_intent_id UUID,
  authority_request_id UUID,
  authority_grant_id UUID,
  wait_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, preflight_id, ordinal),
  UNIQUE (workspace_id, preflight_id, requirement_digest),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, preflight_id)
    REFERENCES rorca.authority_run_preflights(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, binding_reference, binding_generation)
    REFERENCES rorca.execution_authority_bindings(workspace_id, binding_reference, generation) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, operation_intent_id)
    REFERENCES rorca.operation_intents(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authority_request_id)
    REFERENCES rorca.authority_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, authority_grant_id)
    REFERENCES rorca.authority_grants(workspace_id, id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at),
  CHECK ((authority_request_id IS NULL) = (operation_intent_id IS NULL)),
  CHECK (outcome NOT IN ('WAITING_FOR_AUTHORIZATION', 'AUTHORIZED') OR authority_request_id IS NOT NULL),
  CHECK (outcome <> 'AUTHORIZED' OR authority_grant_id IS NOT NULL),
  CHECK (authority_grant_id IS NULL OR authority_request_id IS NOT NULL),
  CHECK ((outcome IN ('WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_AUTHENTICATION', 'WAITING_FOR_CHANGE_WINDOW'))
    = (wait_expires_at IS NOT NULL)),
  CHECK (wait_expires_at IS NULL OR wait_expires_at > created_at)
);
CREATE INDEX authority_preflight_requirements_request_idx
  ON rorca.authority_preflight_requirements(workspace_id, authority_request_id)
  WHERE authority_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION rorca.authority_run_preflight_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.spec_revision IS DISTINCT FROM NEW.spec_revision
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.policy_revision IS DISTINCT FROM NEW.policy_revision
    OR OLD.preflight_digest IS DISTINCT FROM NEW.preflight_digest
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Authority preflight identity and context are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'INVALIDATED' OR NEW.status NOT IN (
    'AUTHORIZED', 'WAITING_FOR_AUTHORIZATION', 'WAITING_FOR_AUTHENTICATION',
    'WAITING_FOR_CHANGE_WINDOW', 'INVALIDATED'
  ) THEN
    RAISE EXCEPTION 'Illegal authority preflight transition' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  IF NEW.status = 'INVALIDATED' THEN
    NEW.invalidated_at := COALESCE(NEW.invalidated_at, clock_timestamp());
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_run_preflight_guard
  BEFORE UPDATE ON rorca.authority_run_preflights
  FOR EACH ROW EXECUTE FUNCTION rorca.authority_run_preflight_guard_v1();
CREATE TRIGGER authority_run_preflight_delete_guard
  BEFORE DELETE ON rorca.authority_run_preflights
  FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE OR REPLACE FUNCTION rorca.authority_preflight_requirement_guard_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.run_id IS DISTINCT FROM NEW.run_id
    OR OLD.preflight_id IS DISTINCT FROM NEW.preflight_id
    OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
    OR OLD.story_id IS DISTINCT FROM NEW.story_id
    OR OLD.capability_id IS DISTINCT FROM NEW.capability_id
    OR OLD.binding_reference IS DISTINCT FROM NEW.binding_reference
    OR OLD.binding_generation IS DISTINCT FROM NEW.binding_generation
    OR OLD.environment IS DISTINCT FROM NEW.environment
    OR OLD.provider_resource_id IS DISTINCT FROM NEW.provider_resource_id
    OR OLD.requested_mode IS DISTINCT FROM NEW.requested_mode
    OR OLD.constraints_json IS DISTINCT FROM NEW.constraints_json
    OR OLD.evidence_digest IS DISTINCT FROM NEW.evidence_digest
    OR OLD.requirement_digest IS DISTINCT FROM NEW.requirement_digest
    OR OLD.adapter_id IS DISTINCT FROM NEW.adapter_id
    OR OLD.adapter_policy_revision IS DISTINCT FROM NEW.adapter_policy_revision
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'Authority preflight requirement identity and request are immutable' USING ERRCODE = '55000';
  END IF;
  IF (OLD.operation_intent_id IS NOT NULL AND OLD.operation_intent_id IS DISTINCT FROM NEW.operation_intent_id)
    OR (OLD.authority_request_id IS NOT NULL AND OLD.authority_request_id IS DISTINCT FROM NEW.authority_request_id)
  THEN
    RAISE EXCEPTION 'Authority preflight request cannot be replaced' USING ERRCODE = '55000';
  END IF;
  IF OLD.authority_grant_id IS NOT NULL AND OLD.authority_grant_id IS DISTINCT FROM NEW.authority_grant_id THEN
    RAISE EXCEPTION 'Authority preflight grant cannot be replaced' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_preflight_requirement_guard
  BEFORE UPDATE ON rorca.authority_preflight_requirements
  FOR EACH ROW EXECUTE FUNCTION rorca.authority_preflight_requirement_guard_v1();
CREATE TRIGGER authority_preflight_requirement_delete_guard
  BEFORE DELETE ON rorca.authority_preflight_requirements
  FOR EACH ROW EXECUTE FUNCTION rorca.authority_reject_mutation_v1();

CREATE OR REPLACE FUNCTION rorca.invalidate_authority_run_preflight_v1(
  p_preflight_id UUID,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  changed BOOLEAN := FALSE;
BEGIN
  IF p_reason IS NULL OR octet_length(p_reason) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Authority preflight invalidation reason is required' USING ERRCODE = '22023';
  END IF;

  UPDATE rorca.authority_grants grant_row
     SET status = 'revoked', revoked_at = clock_timestamp()
    FROM rorca.authority_preflight_requirements requirement
   WHERE requirement.preflight_id = p_preflight_id
     AND requirement.workspace_id = grant_row.workspace_id
     AND requirement.authority_grant_id = grant_row.id
     AND grant_row.status = 'active';

  UPDATE rorca.operation_intents intent
     SET status = 'cancelled'
    FROM rorca.authority_preflight_requirements requirement
   WHERE requirement.preflight_id = p_preflight_id
     AND requirement.workspace_id = intent.workspace_id
     AND requirement.operation_intent_id = intent.id
     AND intent.status IN ('proposed', 'authorized');

  UPDATE rorca.authority_requests request
     SET status = 'cancelled'
    FROM rorca.authority_preflight_requirements requirement
   WHERE requirement.preflight_id = p_preflight_id
     AND requirement.workspace_id = request.workspace_id
     AND requirement.authority_request_id = request.id
     AND request.status = 'pending';

  UPDATE rorca.authority_run_preflights
     SET status = 'INVALIDATED', wait_expires_at = NULL,
         invalidation_reason = p_reason, invalidated_at = clock_timestamp()
   WHERE id = p_preflight_id AND invalidated_at IS NULL;
  changed := FOUND;
  RETURN changed;
END;
$$;

CREATE OR REPLACE FUNCTION rorca.authority_provider_binding_invalidate_preflight_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = rorca, pg_catalog
AS $$
DECLARE
  preflight UUID;
BEGIN
  IF OLD.status = 'active' AND NEW.status IN ('stale', 'revoked') THEN
    FOR preflight IN
      SELECT DISTINCT requirement.preflight_id
        FROM rorca.authority_preflight_requirements requirement
        JOIN rorca.authority_run_preflights batch ON batch.id = requirement.preflight_id
       WHERE requirement.workspace_id = NEW.workspace_id
         AND requirement.binding_reference = NEW.binding_reference
         AND requirement.binding_generation = NEW.generation
         AND batch.invalidated_at IS NULL
    LOOP
      PERFORM rorca.invalidate_authority_run_preflight_v1(
        preflight,
        'provider_binding_generation_changed'
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER authority_provider_binding_invalidate_preflight
  AFTER UPDATE ON rorca.execution_authority_bindings
  FOR EACH ROW EXECUTE FUNCTION rorca.authority_provider_binding_invalidate_preflight_v1();

REVOKE ALL ON TABLE
  rorca.authority_run_preflights,
  rorca.authority_preflight_requirements
  FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION rorca.invalidate_authority_run_preflight_v1(UUID, TEXT)
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
    'GRANT SELECT, INSERT, UPDATE ON TABLE rorca.authority_run_preflights, rorca.authority_preflight_requirements TO %I',
    runtime_user
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION rorca.invalidate_authority_run_preflight_v1(UUID,TEXT) TO %I',
    runtime_user
  );
END;
$$;

COMMENT ON TABLE rorca.authority_run_preflights IS
  'REA-003 one durable exact-revision preflight batch per run context with independent wait expiry and pending story position.';
COMMENT ON TABLE rorca.authority_preflight_requirements IS
  'REA-003 exact per-story capability requirements linked to requests and grants without provider credential values.';
