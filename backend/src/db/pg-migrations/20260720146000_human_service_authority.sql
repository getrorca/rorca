-- Non-forgeable provider-human authority for service-relayed lifecycle and retry actions.
-- Application tables only; this migration never touches pgboss.*.

ALTER TABLE provider_human_authority_receipts
  DROP CONSTRAINT IF EXISTS provider_human_authority_receipts_purpose_check;
ALTER TABLE provider_human_authority_receipts
  ADD CONSTRAINT provider_human_authority_receipts_purpose_check CHECK (purpose IN (
    'authoring_plan_confirmation', 'spec_set_approval', 'retry_approval', 'lifecycle_decision'
  ));

ALTER TABLE ssdlc_decisions
  ADD COLUMN IF NOT EXISTS provider_human_receipt_id UUID
    REFERENCES provider_human_authority_receipts(id) ON DELETE RESTRICT;
ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_principal_type_check;
ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_principal_type_check CHECK (principal_type IN (
    'local_admin', 'authenticated_user', 'provider_human', 'hermes', 'internal_service'
  ));
ALTER TABLE ssdlc_decisions
  DROP CONSTRAINT IF EXISTS ssdlc_decisions_source_channel_check;
ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_source_channel_check CHECK (source_channel IN (
    'local', 'api', 'provider', 'hermes', 'internal'
  ));
ALTER TABLE ssdlc_decisions
  ADD CONSTRAINT ssdlc_decisions_provider_human_receipt_check CHECK (
    (principal_type = 'provider_human') = (provider_human_receipt_id IS NOT NULL)
  ) NOT VALID;

ALTER TABLE governed_retry_human_approvals
  ADD COLUMN IF NOT EXISTS provider_human_receipt_id UUID
    REFERENCES provider_human_authority_receipts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS provider TEXT,
  ADD COLUMN IF NOT EXISTS provider_tenant_id TEXT;
ALTER TABLE governed_retry_human_approvals
  DROP CONSTRAINT IF EXISTS governed_retry_human_approvals_principal_type_check;
ALTER TABLE governed_retry_human_approvals
  ADD CONSTRAINT governed_retry_human_approvals_principal_type_check CHECK (
    principal_type IN ('authenticated_user', 'provider_human')
  );
ALTER TABLE governed_retry_human_approvals
  DROP CONSTRAINT IF EXISTS governed_retry_human_approvals_source_channel_check;
ALTER TABLE governed_retry_human_approvals
  ADD CONSTRAINT governed_retry_human_approvals_source_channel_check CHECK (
    source_channel IN ('api', 'provider')
  );
ALTER TABLE governed_retry_human_approvals
  ADD CONSTRAINT governed_retry_human_approvals_provider_check CHECK (
    (principal_type = 'provider_human'
      AND source_channel = 'provider'
      AND provider_human_receipt_id IS NOT NULL
      AND btrim(provider) <> ''
      AND btrim(provider_tenant_id) <> '')
    OR
    (principal_type = 'authenticated_user'
      AND source_channel = 'api'
      AND provider_human_receipt_id IS NULL
      AND provider IS NULL
      AND provider_tenant_id IS NULL)
  ) NOT VALID;

CREATE OR REPLACE FUNCTION enforce_governed_retry_human_approval_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'governed retry human approvals are append-only';
  END IF;
  IF OLD.consumed_at IS NULL
     AND NEW.consumed_at IS NOT NULL
     AND NEW.consumed_retry_run_id IS NOT NULL
     AND NEW.consumed_idempotency_key IS NOT NULL
     AND ROW(NEW.id, NEW.receipt_hash, NEW.workspace_id, NEW.original_run_id,
             NEW.preview_hash, NEW.packet_hash, NEW.preview_identity_hash, NEW.scope_hash,
             NEW.rationale, NEW.rationale_hash, NEW.principal_type, NEW.principal_id,
             NEW.principal_auth_id, NEW.principal_display_label, NEW.source_channel,
             NEW.provider_human_receipt_id, NEW.provider, NEW.provider_tenant_id,
             NEW.idempotency_key, NEW.request_hash, NEW.claims, NEW.issued_at,
             NEW.expires_at, NEW.revoked_at, NEW.created_at)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.receipt_hash, OLD.workspace_id, OLD.original_run_id,
             OLD.preview_hash, OLD.packet_hash, OLD.preview_identity_hash, OLD.scope_hash,
             OLD.rationale, OLD.rationale_hash, OLD.principal_type, OLD.principal_id,
             OLD.principal_auth_id, OLD.principal_display_label, OLD.source_channel,
             OLD.provider_human_receipt_id, OLD.provider, OLD.provider_tenant_id,
             OLD.idempotency_key, OLD.request_hash, OLD.claims, OLD.issued_at,
             OLD.expires_at, OLD.revoked_at, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'governed retry human approvals are immutable except for one exact consumption';
END;
$$;
