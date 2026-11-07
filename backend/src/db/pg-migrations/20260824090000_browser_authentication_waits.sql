-- 20260824090000_browser_authentication_waits.sql
-- BSB-003: durable, operator-only browser step-up authentication waits.

ALTER TABLE rorca.authority_provider_leases
  ADD CONSTRAINT authority_provider_leases_authentication_identity_key
  UNIQUE (id, binding_id, workspace_id, profile_generation);

CREATE TABLE rorca.browser_authentication_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id UUID NOT NULL,
  binding_id UUID NOT NULL,
  workspace_id TEXT NOT NULL,
  external_provider TEXT NOT NULL CHECK (external_provider IN ('claude', 'chatgpt')),
  run_id TEXT NOT NULL CHECK (btrim(run_id) <> ''),
  story_id TEXT NOT NULL CHECK (btrim(story_id) <> ''),
  purpose TEXT NOT NULL CHECK (btrim(purpose) <> ''),
  profile_generation INTEGER NOT NULL CHECK (profile_generation > 0),
  step_type TEXT NOT NULL CHECK (step_type IN (
    'login_expired', 'consent', 'mfa', 'passkey', 'captcha',
    'account_locked', 'provider_step_up', 'anti_automation'
  )),
  evidence JSONB NOT NULL CHECK (
    jsonb_typeof(evidence) = 'object'
    AND evidence->>'redaction' = 'required'
    AND lower(evidence::text) !~ '"(password|cookie|totp.?seed|passkey.?private|recovery.?code|access.?token|refresh.?token|private.?key)"[[:space:]]*:'
  ),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  takeover_checkpoint_digest TEXT NOT NULL
    CHECK (takeover_checkpoint_digest ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'WAITING_FOR_AUTHENTICATION' CHECK (state IN (
    'WAITING_FOR_AUTHENTICATION', 'REVALIDATING', 'RESUMED', 'CANCELLED',
    'DENIED', 'EXPIRED', 'UNHEALTHY', 'POLICY_PROHIBITED'
  )),
  disposition TEXT CHECK (disposition IN ('resumed', 'terminal', 'retryable')),
  outcome_code TEXT,
  run_pause_owned BOOLEAN NOT NULL DEFAULT FALSE,
  resume_count SMALLINT NOT NULL DEFAULT 0 CHECK (resume_count BETWEEN 0 AND 1),
  detected_at TIMESTAMPTZ NOT NULL,
  authentication_expires_at TIMESTAMPTZ NOT NULL
    CHECK (authentication_expires_at > detected_at),
  resolution_observation JSONB CHECK (
    resolution_observation IS NULL OR (
      jsonb_typeof(resolution_observation) = 'object'
      AND resolution_observation->>'redaction' = 'required'
      AND lower(resolution_observation::text) !~ '"(password|cookie|totp.?seed|passkey.?private|recovery.?code|access.?token|refresh.?token|private.?key)"[[:space:]]*:'
    )
  ),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resumed_at TIMESTAMPTZ,
  FOREIGN KEY (lease_id, binding_id, workspace_id, profile_generation)
    REFERENCES rorca.authority_provider_leases (
      id, binding_id, workspace_id, profile_generation
    ) ON DELETE RESTRICT,
  CHECK (
    (state = 'WAITING_FOR_AUTHENTICATION'
      AND disposition IS NULL AND outcome_code IS NULL
      AND resolution_observation IS NULL AND resolved_by IS NULL
      AND resolved_at IS NULL AND resumed_at IS NULL AND resume_count = 0)
    OR
    (state = 'REVALIDATING'
      AND disposition IS NULL AND outcome_code IS NULL
      AND resolution_observation IS NULL AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NULL AND resumed_at IS NULL AND resume_count = 0)
    OR
    (state = 'RESUMED' AND disposition = 'resumed'
      AND outcome_code = 'AUTHENTICATION_RESUMED'
      AND resolution_observation IS NOT NULL
      AND resolution_observation->>'schemaVersion' = 'rorca.browser-authentication-revalidation.v1'
      AND resolution_observation->>'challengePresent' = 'false'
      AND resolution_observation->>'redaction' = 'required'
      AND resolution_observation->'health'->>'provider' = 'healthy'
      AND resolution_observation->'health'->>'session' = 'healthy'
      AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NOT NULL AND resumed_at = resolved_at AND resume_count = 1)
    OR
    (state = 'CANCELLED' AND disposition = 'terminal'
      AND outcome_code = 'AUTHENTICATION_CANCELLED'
      AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NOT NULL AND resumed_at IS NULL AND resume_count = 0)
    OR
    (state = 'DENIED' AND disposition = 'terminal'
      AND outcome_code = 'AUTHENTICATION_DENIED'
      AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NOT NULL AND resumed_at IS NULL AND resume_count = 0)
    OR
    (state = 'POLICY_PROHIBITED' AND disposition = 'terminal'
      AND outcome_code = 'AUTHENTICATION_POLICY_PROHIBITED'
      AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NOT NULL AND resumed_at IS NULL AND resume_count = 0)
    OR
    (state = 'EXPIRED' AND disposition = 'retryable'
      AND outcome_code = 'AUTHENTICATION_EXPIRED'
      AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NOT NULL AND resumed_at IS NULL AND resume_count = 0)
    OR
    (state = 'UNHEALTHY' AND disposition = 'retryable'
      AND outcome_code = 'AUTHENTICATION_UNHEALTHY'
      AND NULLIF(btrim(resolved_by), '') IS NOT NULL
      AND resolved_at IS NOT NULL AND resumed_at IS NULL AND resume_count = 0)
  )
);

CREATE UNIQUE INDEX browser_authentication_one_open_lease_idx
  ON rorca.browser_authentication_requests (lease_id)
  WHERE state IN ('WAITING_FOR_AUTHENTICATION', 'REVALIDATING');
CREATE UNIQUE INDEX browser_authentication_one_open_run_idx
  ON rorca.browser_authentication_requests (workspace_id, run_id)
  WHERE state IN ('WAITING_FOR_AUTHENTICATION', 'REVALIDATING');
CREATE INDEX browser_authentication_run_state_idx
  ON rorca.browser_authentication_requests (workspace_id, run_id, state, authentication_expires_at);
CREATE INDEX browser_authentication_expiry_idx
  ON rorca.browser_authentication_requests (authentication_expires_at)
  WHERE state = 'WAITING_FOR_AUTHENTICATION';

CREATE OR REPLACE FUNCTION rorca.enforce_browser_authentication_request_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Browser authentication requests are retained; hard deletion is forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.lease_id <> OLD.lease_id
    OR NEW.binding_id <> OLD.binding_id
    OR NEW.workspace_id <> OLD.workspace_id
    OR NEW.external_provider <> OLD.external_provider
    OR NEW.run_id <> OLD.run_id
    OR NEW.story_id <> OLD.story_id
    OR NEW.purpose <> OLD.purpose
    OR NEW.profile_generation <> OLD.profile_generation
    OR NEW.step_type <> OLD.step_type
    OR NEW.evidence <> OLD.evidence
    OR NEW.evidence_digest <> OLD.evidence_digest
    OR NEW.takeover_checkpoint_digest <> OLD.takeover_checkpoint_digest
    OR NEW.detected_at <> OLD.detected_at
    OR NEW.authentication_expires_at <> OLD.authentication_expires_at
    OR NEW.run_pause_owned <> OLD.run_pause_owned THEN
    RAISE EXCEPTION 'Browser authentication request identity, evidence, checkpoint, and expiry are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state NOT IN ('WAITING_FOR_AUTHENTICATION', 'REVALIDATING') THEN
    RAISE EXCEPTION 'Terminal browser authentication request state is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'WAITING_FOR_AUTHENTICATION'
    AND NEW.state NOT IN (
      'WAITING_FOR_AUTHENTICATION', 'REVALIDATING', 'CANCELLED', 'DENIED',
      'EXPIRED', 'UNHEALTHY', 'POLICY_PROHIBITED'
    ) THEN
    RAISE EXCEPTION 'Browser authentication completion requires health revalidation'
      USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'REVALIDATING'
    AND NEW.state NOT IN (
      'REVALIDATING', 'RESUMED', 'CANCELLED', 'DENIED',
      'EXPIRED', 'UNHEALTHY', 'POLICY_PROHIBITED'
    ) THEN
    RAISE EXCEPTION 'Invalid browser authentication revalidation settlement'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER browser_authentication_request_lifecycle_guard
  BEFORE UPDATE OR DELETE ON rorca.browser_authentication_requests
  FOR EACH ROW EXECUTE FUNCTION rorca.enforce_browser_authentication_request_lifecycle();

ALTER TABLE rorca.authority_provider_receipts
  DROP CONSTRAINT authority_provider_receipts_event_type_check;
ALTER TABLE rorca.authority_provider_receipts
  ADD CONSTRAINT authority_provider_receipts_event_type_check CHECK (event_type IN (
    'enrollment_started', 'enrollment_completed', 'profile_use_denied',
    'profile_quarantined', 'profile_deleted',
    'browser_lease_requested', 'browser_lease_issued', 'browser_security_denied',
    'browser_lease_revoked', 'browser_lease_uncertain', 'browser_lease_reconciled',
    'browser_authentication_requested', 'browser_authentication_revalidating',
    'browser_authentication_resumed', 'browser_authentication_terminal'
  ));

REVOKE ALL ON TABLE rorca.browser_authentication_requests FROM PUBLIC;

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = '' THEN
    RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal';
  END IF;
  EXECUTE format(
    'GRANT SELECT,INSERT,UPDATE ON rorca.browser_authentication_requests TO %I', runtime_user
  );
END $$;

COMMENT ON TABLE rorca.browser_authentication_requests IS
  'Durable typed browser step-up waits. Contains redacted observations and checkpoint digests only; no credentials, cookies, tokens, TOTP seeds, recovery codes, or browser profile material.';
