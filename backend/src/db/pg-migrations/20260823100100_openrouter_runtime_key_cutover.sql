-- OSR-003: provider-neutral target staging, real completion evidence, and cutover receipt state.
-- This table contains only resource identities, SecretStore fingerprints, and redacted evidence.
-- Runtime and management credential values remain confined to SecretStore and trusted adapters.

CREATE TABLE IF NOT EXISTS rorca.runtime_key_rotation_cutovers (
  intent_id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL CHECK (intent_digest ~ '^sha256:[0-9a-f]{64}$'),
  provider_binding_id UUID NOT NULL,
  execution_id UUID NOT NULL,
  fencing_token BIGINT NOT NULL CHECK (fencing_token > 0),
  state TEXT NOT NULL CHECK (state IN (
    'REPLACEMENT_READY',
    'WAITING_FOR_AUTHORIZATION',
    'BINDING_STAGED',
    'TARGET_DEPLOYED',
    'CANARY_PASSED',
    'BINDING_ACTIVE',
    'OLD_KEY_DISABLED',
    'COMPLETED'
  )),
  resume_state TEXT CHECK (resume_state IS NULL OR resume_state IN (
    'REPLACEMENT_READY',
    'BINDING_STAGED',
    'TARGET_DEPLOYED',
    'CANARY_PASSED',
    'BINDING_ACTIVE',
    'OLD_KEY_DISABLED'
  )),
  waiting_reason_code TEXT CHECK (
    waiting_reason_code IS NULL
    OR (btrim(waiting_reason_code) <> '' AND length(waiting_reason_code) <= 120)
  ),
  timeout_consumed_ms BIGINT NOT NULL DEFAULT 0 CHECK (timeout_consumed_ms >= 0),
  timeout_started_at TIMESTAMPTZ,
  old_provider_resource_id TEXT NOT NULL,
  target_binding_generation BIGINT CHECK (target_binding_generation IS NULL OR target_binding_generation > 0),
  target_requires_deployment BOOLEAN,
  deployed_revision TEXT CHECK (
    deployed_revision IS NULL
    OR (btrim(deployed_revision) <> '' AND length(deployed_revision) <= 255)
  ),
  canary_evidence JSONB CHECK (canary_evidence IS NULL OR jsonb_typeof(canary_evidence) = 'object'),
  old_key_disabled_at TIMESTAMPTZ,
  rejection_evidence JSONB CHECK (rejection_evidence IS NULL OR jsonb_typeof(rejection_evidence) = 'object'),
  receipt JSONB CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_key_rotation_cutover_intent_fk
    FOREIGN KEY (intent_id, workspace_id, intent_digest, provider_binding_id)
    REFERENCES rorca.runtime_key_rotation_intents(id, workspace_id, intent_digest, provider_binding_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_cutover_old_resource_fk
    FOREIGN KEY (provider_binding_id, old_provider_resource_id)
    REFERENCES rorca.provider_key_resources(provider_binding_id, provider_resource_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_cutover_scope_key UNIQUE (workspace_id, intent_digest),
  CONSTRAINT runtime_key_rotation_cutover_wait_check CHECK (
    (state = 'WAITING_FOR_AUTHORIZATION'
      AND resume_state IS NOT NULL
      AND waiting_reason_code IS NOT NULL
      AND timeout_started_at IS NULL)
    OR (state <> 'WAITING_FOR_AUTHORIZATION'
      AND resume_state IS NULL
      AND waiting_reason_code IS NULL)
  ),
  CONSTRAINT runtime_key_rotation_cutover_stage_check CHECK (
    state IN ('REPLACEMENT_READY', 'WAITING_FOR_AUTHORIZATION')
    OR (target_binding_generation IS NOT NULL AND target_requires_deployment IS NOT NULL)
  ),
  CONSTRAINT runtime_key_rotation_cutover_deploy_check CHECK (
    state IN ('REPLACEMENT_READY', 'WAITING_FOR_AUTHORIZATION', 'BINDING_STAGED')
    OR deployed_revision IS NOT NULL
  ),
  CONSTRAINT runtime_key_rotation_cutover_canary_check CHECK (
    state IN ('REPLACEMENT_READY', 'WAITING_FOR_AUTHORIZATION', 'BINDING_STAGED', 'TARGET_DEPLOYED')
    OR canary_evidence IS NOT NULL
  ),
  CONSTRAINT runtime_key_rotation_cutover_disable_check CHECK (
    state <> 'OLD_KEY_DISABLED' AND state <> 'COMPLETED'
    OR old_key_disabled_at IS NOT NULL
  ),
  CONSTRAINT runtime_key_rotation_cutover_complete_check CHECK (
    state <> 'COMPLETED'
    OR (rejection_evidence IS NOT NULL AND receipt IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_key_rotation_cutovers_state
  ON rorca.runtime_key_rotation_cutovers (workspace_id, state, updated_at DESC);

REVOKE ALL PRIVILEGES ON TABLE rorca.runtime_key_rotation_cutovers FROM PUBLIC;
