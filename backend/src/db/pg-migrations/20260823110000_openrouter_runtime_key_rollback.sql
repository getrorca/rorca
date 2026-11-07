-- OSR-004: durable rollback, target restoration, and uncertain old-key disable reconciliation.
-- Recovery evidence is redacted metadata only; credential values remain inside SecretStore and trusted adapters.

ALTER TABLE rorca.runtime_key_rotation_cutovers
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutovers_state_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutovers_resume_state_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutover_wait_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutover_stage_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutover_deploy_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutover_canary_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutover_disable_check,
  DROP CONSTRAINT IF EXISTS runtime_key_rotation_cutover_complete_check,
  ADD COLUMN IF NOT EXISTS failure_state TEXT,
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS restored_binding_generation BIGINT,
  ADD COLUMN IF NOT EXISTS restored_revision TEXT,
  ADD COLUMN IF NOT EXISTS reconciliation_reason_code TEXT,
  ADD COLUMN IF NOT EXISTS recovery_receipt JSONB;

ALTER TABLE rorca.runtime_key_rotation_cutovers
  ADD CONSTRAINT runtime_key_rotation_cutovers_state_check CHECK (state IN (
    'REPLACEMENT_READY',
    'WAITING_FOR_AUTHORIZATION',
    'BINDING_STAGED',
    'TARGET_DEPLOYED',
    'CANARY_PASSED',
    'BINDING_ACTIVE',
    'OLD_KEY_DISABLE_PENDING',
    'OLD_KEY_DISABLED',
    'COMPLETED',
    'ROLLBACK_PENDING',
    'TARGET_RESTORED',
    'ROLLED_BACK'
  )),
  ADD CONSTRAINT runtime_key_rotation_cutovers_resume_state_check CHECK (
    resume_state IS NULL OR resume_state IN (
      'REPLACEMENT_READY',
      'BINDING_STAGED',
      'TARGET_DEPLOYED',
      'CANARY_PASSED',
      'BINDING_ACTIVE',
      'OLD_KEY_DISABLE_PENDING',
      'OLD_KEY_DISABLED'
    )
  ),
  ADD CONSTRAINT runtime_key_rotation_cutovers_failure_state_check CHECK (
    failure_state IS NULL OR failure_state IN (
      'REPLACEMENT_READY',
      'WAITING_FOR_AUTHORIZATION',
      'BINDING_STAGED',
      'TARGET_DEPLOYED',
      'CANARY_PASSED',
      'BINDING_ACTIVE',
      'OLD_KEY_DISABLE_PENDING',
      'OLD_KEY_DISABLED',
      'COMPLETED',
      'ROLLBACK_PENDING',
      'TARGET_RESTORED',
      'ROLLED_BACK'
    )
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_wait_check CHECK (
    (state = 'WAITING_FOR_AUTHORIZATION'
      AND resume_state IS NOT NULL
      AND waiting_reason_code IS NOT NULL
      AND timeout_started_at IS NULL)
    OR (state <> 'WAITING_FOR_AUTHORIZATION'
      AND resume_state IS NULL
      AND waiting_reason_code IS NULL)
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_stage_check CHECK (
    state NOT IN (
      'BINDING_STAGED',
      'TARGET_DEPLOYED',
      'CANARY_PASSED',
      'BINDING_ACTIVE',
      'OLD_KEY_DISABLE_PENDING',
      'OLD_KEY_DISABLED',
      'COMPLETED'
    ) OR (target_binding_generation IS NOT NULL AND target_requires_deployment IS NOT NULL)
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_deploy_check CHECK (
    state NOT IN (
      'TARGET_DEPLOYED',
      'CANARY_PASSED',
      'BINDING_ACTIVE',
      'OLD_KEY_DISABLE_PENDING',
      'OLD_KEY_DISABLED',
      'COMPLETED'
    ) OR deployed_revision IS NOT NULL
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_canary_check CHECK (
    state NOT IN (
      'CANARY_PASSED',
      'BINDING_ACTIVE',
      'OLD_KEY_DISABLE_PENDING',
      'OLD_KEY_DISABLED',
      'COMPLETED'
    ) OR canary_evidence IS NOT NULL
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_disable_check CHECK (
    state NOT IN ('OLD_KEY_DISABLED', 'COMPLETED') OR old_key_disabled_at IS NOT NULL
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_complete_check CHECK (
    state <> 'COMPLETED'
    OR (rejection_evidence IS NOT NULL AND receipt IS NOT NULL AND completed_at IS NOT NULL)
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_failure_check CHECK (
    (failure_state IS NULL AND failure_code IS NULL)
    OR (failure_state IS NOT NULL
      AND failure_code IS NOT NULL
      AND btrim(failure_code) <> ''
      AND length(failure_code) <= 120)
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_restore_check CHECK (
    state NOT IN ('TARGET_RESTORED', 'ROLLED_BACK')
    OR (restored_binding_generation IS NOT NULL
      AND restored_binding_generation > 0
      AND restored_revision IS NOT NULL
      AND btrim(restored_revision) <> ''
      AND length(restored_revision) <= 255)
  ),
  ADD CONSTRAINT runtime_key_rotation_cutover_reconciliation_check CHECK (
    (reconciliation_reason_code IS NULL OR (
      btrim(reconciliation_reason_code) <> ''
      AND length(reconciliation_reason_code) <= 120
      AND recovery_receipt IS NOT NULL
    ))
    AND (recovery_receipt IS NULL OR jsonb_typeof(recovery_receipt) = 'object')
  );
