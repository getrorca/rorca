-- OSR-005: bounded, redacted live qualification and fail-closed workspace rollout policy.
-- Provider and runtime credential values remain in SecretStore and trusted adapters.

CREATE TABLE IF NOT EXISTS rorca.runtime_key_rotation_qualifications (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'openrouter' CHECK (provider = 'openrouter'),
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE RESTRICT,
  provider_binding_id UUID NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  provider_account_id TEXT NOT NULL CHECK (btrim(provider_account_id) <> '' AND length(provider_account_id) <= 255),
  fixture_id TEXT NOT NULL CHECK (btrim(fixture_id) <> '' AND length(fixture_id) <= 120),
  target_binding JSONB NOT NULL CHECK (jsonb_typeof(target_binding) = 'object'),
  spend_limit_usd NUMERIC(12, 6) NOT NULL CHECK (spend_limit_usd > 0 AND spend_limit_usd <= 5),
  observed_spend_usd NUMERIC(12, 6) CHECK (observed_spend_usd IS NULL OR observed_spend_usd >= 0),
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms > 0 AND timeout_ms <= 3600000),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
  grant_issued_at TIMESTAMPTZ NOT NULL,
  grant_expires_at TIMESTAMPTZ NOT NULL CHECK (grant_expires_at > grant_issued_at),
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'passed', 'failed', 'rolled-back')),
  evidence JSONB CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
  receipt JSONB CHECK (receipt IS NULL OR jsonb_typeof(receipt) = 'object'),
  receipt_digest TEXT CHECK (receipt_digest IS NULL OR receipt_digest ~ '^sha256:[0-9a-f]{64}$'),
  failure_code TEXT CHECK (failure_code IS NULL OR (btrim(failure_code) <> '' AND length(failure_code) <= 120)),
  rollback_receipt JSONB CHECK (rollback_receipt IS NULL OR jsonb_typeof(rollback_receipt) = 'object'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  CONSTRAINT runtime_key_rotation_qualification_binding_fk
    FOREIGN KEY (provider_binding_id, workspace_id, binding_generation, provider_account_id)
    REFERENCES rorca.provider_authority_bindings(id, workspace_id, generation, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_qualification_request_key UNIQUE (workspace_id, request_digest),
  CONSTRAINT runtime_key_rotation_qualification_state_check CHECK (
    (state = 'running' AND evidence IS NULL AND receipt IS NULL AND receipt_digest IS NULL
      AND failure_code IS NULL AND completed_at IS NULL AND rollback_receipt IS NULL AND rolled_back_at IS NULL)
    OR (state = 'passed' AND evidence IS NOT NULL AND receipt IS NOT NULL AND receipt_digest IS NOT NULL
      AND failure_code IS NULL AND completed_at IS NOT NULL AND rollback_receipt IS NULL AND rolled_back_at IS NULL)
    OR (state = 'failed' AND receipt IS NULL AND receipt_digest IS NULL
      AND failure_code IS NOT NULL AND completed_at IS NOT NULL AND rollback_receipt IS NULL AND rolled_back_at IS NULL)
    OR (state = 'rolled-back' AND evidence IS NOT NULL AND receipt IS NOT NULL AND receipt_digest IS NOT NULL
      AND failure_code IS NULL AND completed_at IS NOT NULL AND rollback_receipt IS NOT NULL AND rolled_back_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_key_rotation_qualifications_binding
  ON rorca.runtime_key_rotation_qualifications (provider_binding_id, state, completed_at DESC);

CREATE TABLE IF NOT EXISTS rorca.runtime_key_rotation_policies (
  provider_binding_id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  binding_generation BIGINT NOT NULL CHECK (binding_generation > 0),
  provider_account_id TEXT NOT NULL,
  qualification_id UUID NOT NULL REFERENCES rorca.runtime_key_rotation_qualifications(id) ON DELETE RESTRICT,
  policy_version TEXT NOT NULL CHECK (policy_version = 'rorca.openrouter-runtime-key-rotation-policy.v1'),
  policy_digest TEXT NOT NULL CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
  policy JSONB NOT NULL CHECK (jsonb_typeof(policy) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  accepted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > accepted_at),
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT runtime_key_rotation_policy_binding_fk
    FOREIGN KEY (provider_binding_id, workspace_id, binding_generation, provider_account_id)
    REFERENCES rorca.provider_authority_bindings(id, workspace_id, generation, provider_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT runtime_key_rotation_policy_workspace_key UNIQUE (workspace_id, provider_binding_id),
  CONSTRAINT runtime_key_rotation_policy_status_check CHECK (
    (status = 'active' AND disabled_at IS NULL)
    OR (status = 'disabled' AND disabled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_runtime_key_rotation_policies_available
  ON rorca.runtime_key_rotation_policies (workspace_id, status, expires_at);

REVOKE ALL PRIVILEGES ON TABLE rorca.runtime_key_rotation_qualifications FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE rorca.runtime_key_rotation_policies FROM PUBLIC;
