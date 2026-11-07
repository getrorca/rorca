-- OSR-002: immutable, provider-neutral runtime-key rotation intent and one fenced replacement claim.
-- Key values remain in integration_vault_secrets; these tables store only exact scope, digests,
-- provider resource identities, lifecycle, policy, and SecretStore references.

CREATE TABLE IF NOT EXISTS rorca.runtime_key_rotation_intents (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider = 'openrouter'),
  provider_binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  provider_account_id TEXT NOT NULL CHECK (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 255),
  current_runtime_secret_id UUID NOT NULL,
  current_runtime_secret_kind TEXT NOT NULL DEFAULT 'runtime_key' CHECK (current_runtime_secret_kind = 'runtime_key'),
  current_key_fingerprint TEXT NOT NULL CHECK (current_key_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  target_adapter_id TEXT NOT NULL CHECK (btrim(target_adapter_id) <> '' AND length(target_adapter_id) <= 120),
  target_binding_id TEXT NOT NULL CHECK (btrim(target_binding_id) <> '' AND length(target_binding_id) <= 255),
  target_workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  target_environment_id TEXT NOT NULL CHECK (btrim(target_environment_id) <> '' AND length(target_environment_id) <= 255),
  target_generation BIGINT NOT NULL CHECK (target_generation > 0),
  desired_name TEXT NOT NULL CHECK (btrim(desired_name) <> '' AND length(desired_name) <= 120),
  declared_limits JSONB NOT NULL CHECK (
    jsonb_typeof(declared_limits) = 'object'
    AND (declared_limits - ARRAY['creditLimitUsd', 'usageLimit', 'limitReset', 'includeByokInLimit']::TEXT[]) = '{}'::jsonb
    AND declared_limits ?& ARRAY['creditLimitUsd', 'usageLimit', 'limitReset', 'includeByokInLimit']
    AND jsonb_typeof(declared_limits -> 'creditLimitUsd') = 'number'
    AND (declared_limits ->> 'creditLimitUsd')::NUMERIC > 0
    AND (
      declared_limits -> 'usageLimit' = 'null'::jsonb
      OR (jsonb_typeof(declared_limits -> 'usageLimit') = 'number'
          AND (declared_limits ->> 'usageLimit')::NUMERIC >= 0)
    )
    AND (
      declared_limits -> 'limitReset' = 'null'::jsonb
      OR declared_limits ->> 'limitReset' IN ('daily', 'weekly', 'monthly')
    )
    AND jsonb_typeof(declared_limits -> 'includeByokInLimit') = 'boolean'
  ),
  canary_contract JSONB NOT NULL CHECK (jsonb_typeof(canary_contract) = 'object'),
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms > 0 AND timeout_ms <= 86400000),
  rollback_action TEXT NOT NULL CHECK (
    rollback_action IN ('restore-prior-binding', 'disable-replacement', 'delete-replacement')
  ),
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  intent_payload JSONB NOT NULL CHECK (jsonb_typeof(intent_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_key_rotation_intent_binding_fk
    FOREIGN KEY (provider_binding_id, workspace_id, binding_generation, provider_account_id)
    REFERENCES rorca.provider_authority_bindings(id, workspace_id, generation, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_intent_current_secret_fk
    FOREIGN KEY (current_runtime_secret_id, provider, current_runtime_secret_kind)
    REFERENCES rorca.integration_vault_secrets(id, provider, secret_kind)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_intent_target_workspace_check CHECK (target_workspace_id = workspace_id),
  CONSTRAINT runtime_key_rotation_intent_digest_key UNIQUE (workspace_id, intent_digest),
  CONSTRAINT runtime_key_rotation_intent_scope_key
    UNIQUE (id, workspace_id, intent_digest, provider_binding_id)
);

CREATE OR REPLACE FUNCTION rorca.reject_runtime_key_rotation_intent_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'runtime-key rotation intents are immutable' USING ERRCODE = '23514';
END
$function$;

DROP TRIGGER IF EXISTS runtime_key_rotation_intent_immutable ON rorca.runtime_key_rotation_intents;
CREATE TRIGGER runtime_key_rotation_intent_immutable
  BEFORE UPDATE OR DELETE ON rorca.runtime_key_rotation_intents
  FOR EACH ROW EXECUTE FUNCTION rorca.reject_runtime_key_rotation_intent_mutation();

CREATE TABLE IF NOT EXISTS rorca.runtime_key_rotation_replacements (
  intent_id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider = 'openrouter'),
  provider_binding_id UUID NOT NULL,
  stable_name TEXT NOT NULL CHECK (
    btrim(stable_name) <> ''
    AND length(stable_name) <= 120
    AND stable_name ~ '\[rorca:[0-9a-f]{64}\]$'
    AND right(stable_name, 72) = ('[rorca:' || substring(intent_digest FROM 8) || ']')
  ),
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  execution_id UUID NOT NULL,
  operation_state TEXT NOT NULL CHECK (operation_state IN ('creating', 'creation-uncertain', 'settled')),
  lifecycle_state TEXT NOT NULL CHECK (
    lifecycle_state IN ('pending', 'active', 'revoked', 'cleanup-required', 'reconciled')
  ),
  provider_resource_id TEXT,
  runtime_secret_id UUID,
  runtime_secret_kind TEXT NOT NULL DEFAULT 'runtime_key' CHECK (runtime_secret_kind = 'runtime_key'),
  declared_limits JSONB NOT NULL CHECK (jsonb_typeof(declared_limits) = 'object'),
  target_binding JSONB NOT NULL CHECK (jsonb_typeof(target_binding) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_key_rotation_replacement_intent_fk
    FOREIGN KEY (intent_id, workspace_id, intent_digest, provider_binding_id)
    REFERENCES rorca.runtime_key_rotation_intents(id, workspace_id, intent_digest, provider_binding_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_replacement_resource_fk
    FOREIGN KEY (provider_binding_id, provider_resource_id)
    REFERENCES rorca.provider_key_resources(provider_binding_id, provider_resource_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_replacement_secret_fk
    FOREIGN KEY (runtime_secret_id, provider, runtime_secret_kind)
    REFERENCES rorca.integration_vault_secrets(id, provider, secret_kind)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_replacement_operation_check CHECK (
    (operation_state IN ('creating', 'creation-uncertain')
      AND lifecycle_state = 'pending'
      AND provider_resource_id IS NULL
      AND runtime_secret_id IS NULL)
    OR (operation_state = 'settled' AND provider_resource_id IS NOT NULL)
  ),
  CONSTRAINT runtime_key_rotation_replacement_reference_check CHECK (
    runtime_secret_id IS NULL OR provider_resource_id IS NOT NULL
  ),
  CONSTRAINT runtime_key_rotation_replacement_reconciled_check CHECK (
    lifecycle_state NOT IN ('active', 'reconciled') OR runtime_secret_id IS NOT NULL
  ),
  CONSTRAINT runtime_key_rotation_replacement_stable_name_key UNIQUE (provider_binding_id, stable_name)
);

CREATE OR REPLACE FUNCTION rorca.enforce_runtime_key_rotation_replacement_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
  immutable_limits JSONB;
  immutable_target JSONB;
BEGIN
  SELECT intent.declared_limits,
         jsonb_build_object(
           'adapterId', intent.target_adapter_id,
           'bindingId', intent.target_binding_id,
           'workspaceId', intent.target_workspace_id,
           'environmentId', intent.target_environment_id,
           'generation', intent.target_generation
         )
    INTO immutable_limits, immutable_target
    FROM rorca.runtime_key_rotation_intents AS intent
   WHERE intent.id = NEW.intent_id
     AND intent.workspace_id = NEW.workspace_id
     AND intent.intent_digest = NEW.intent_digest
     AND intent.provider_binding_id = NEW.provider_binding_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'replacement does not match an exact rotation intent scope' USING ERRCODE = '23503';
  END IF;
  IF NEW.declared_limits IS DISTINCT FROM immutable_limits
     OR NEW.target_binding IS DISTINCT FROM immutable_target THEN
    RAISE EXCEPTION 'replacement limits and target binding must match the immutable intent'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.intent_id IS DISTINCT FROM OLD.intent_id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_binding_id IS DISTINCT FROM OLD.provider_binding_id
    OR NEW.stable_name IS DISTINCT FROM OLD.stable_name
    OR NEW.declared_limits IS DISTINCT FROM OLD.declared_limits
    OR NEW.target_binding IS DISTINCT FROM OLD.target_binding
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'replacement immutable scope cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

DROP TRIGGER IF EXISTS runtime_key_rotation_replacement_scope
  ON rorca.runtime_key_rotation_replacements;
CREATE TRIGGER runtime_key_rotation_replacement_scope
  BEFORE INSERT OR UPDATE ON rorca.runtime_key_rotation_replacements
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_runtime_key_rotation_replacement_scope();

CREATE INDEX IF NOT EXISTS idx_runtime_key_rotation_intents_binding
  ON rorca.runtime_key_rotation_intents (provider_binding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_key_rotation_replacements_lifecycle
  ON rorca.runtime_key_rotation_replacements (workspace_id, lifecycle_state, updated_at DESC);

REVOKE ALL PRIVILEGES ON TABLE rorca.runtime_key_rotation_intents FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.runtime_key_rotation_replacements FROM PUBLIC;
