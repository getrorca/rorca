-- Crash-safe, idempotent continuation dispatch publication and append-only outcomes.

CREATE TABLE rorca.continuation_dispatch_outbox (
  workspace_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  continuation_key TEXT NOT NULL CHECK(continuation_key ~ '^sha256:[0-9a-f]{64}$'),
  delivery_key TEXT NOT NULL CHECK(delivery_key ~ '^sha256:[0-9a-f]{64}$'),
  payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK(state IN('pending','claimed','sent','failed','unknown','quarantined')),
  claim_owner TEXT,
  claim_fence BIGINT NOT NULL DEFAULT 0 CHECK(claim_fence>=0),
  claim_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 100),
  transport_receipt_hash TEXT CHECK(transport_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  last_error_code TEXT,
  state_version BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,dispatch_id),
  UNIQUE(workspace_id,continuation_key),
  UNIQUE(workspace_id,delivery_key),
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES rorca.continuation_dispatches(workspace_id,dispatch_id) ON DELETE RESTRICT,
  CHECK((state='claimed')=(claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
);

CREATE TABLE rorca.continuation_dispatch_outcomes (
  workspace_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  outcome_sequence BIGINT NOT NULL CHECK(outcome_sequence>0),
  claim_fence BIGINT NOT NULL CHECK(claim_fence>0),
  outcome_hash TEXT NOT NULL CHECK(outcome_hash ~ '^sha256:[0-9a-f]{64}$'),
  outcome_state TEXT NOT NULL CHECK(outcome_state IN('sent','failed_retryable','failed_permanent','unknown')),
  transport_accepted BOOLEAN NOT NULL,
  transport_receipt_hash TEXT CHECK(transport_receipt_hash ~ '^sha256:[0-9a-f]{64}$'),
  reason_code TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,dispatch_id,outcome_sequence),
  UNIQUE(workspace_id,dispatch_id,outcome_hash),
  FOREIGN KEY(workspace_id,dispatch_id) REFERENCES rorca.continuation_dispatch_outbox(workspace_id,dispatch_id) ON DELETE RESTRICT,
  CHECK(NOT transport_accepted OR transport_receipt_hash IS NOT NULL)
);

CREATE INDEX continuation_dispatch_outbox_recovery_idx
  ON rorca.continuation_dispatch_outbox(state,claim_expires_at,updated_at);

ALTER TABLE rorca.continuation_dispatch_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE rorca.continuation_dispatch_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY continuation_dispatch_outbox_workspace_policy ON rorca.continuation_dispatch_outbox
  USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=continuation_dispatch_outbox.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
      (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))))
  WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=continuation_dispatch_outbox.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
      (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))));
CREATE POLICY continuation_dispatch_outcomes_workspace_policy ON rorca.continuation_dispatch_outcomes
  USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=continuation_dispatch_outcomes.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
      (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))))
  WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=continuation_dispatch_outcomes.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
      (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))));

CREATE TRIGGER continuation_dispatch_outcomes_immutable
  BEFORE UPDATE OR DELETE ON rorca.continuation_dispatch_outcomes FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER continuation_dispatch_outcomes_no_truncate
  BEFORE TRUNCATE ON rorca.continuation_dispatch_outcomes FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729137000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729136000
  AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729137000 AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2') THEN
    RAISE EXCEPTION 'Wave 2 continuation dispatch outbox readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
