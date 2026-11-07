-- Bind continuation retry accounting to one exact canonical subject and append-only transitions.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rorca.continuation_retry_budgets) THEN
    RAISE EXCEPTION 'Existing unbound continuation retry budgets require explicit operator reconciliation before Wave 2 retry subject migration'
      USING ERRCODE='55000';
  END IF;
END;
$$;

ALTER TABLE rorca.continuation_retry_budgets
  ADD COLUMN retry_budget_id TEXT,
  ADD COLUMN scope_key TEXT,
  ADD COLUMN attempt_id TEXT,
  ADD COLUMN lease_id TEXT,
  ADD COLUMN fencing_token BIGINT,
  ADD COLUMN activation_hash TEXT,
  ADD COLUMN checkpoint_hash TEXT,
  ADD COLUMN bundle_hash TEXT,
  ADD COLUMN payload_json JSONB;

ALTER TABLE rorca.continuation_retry_budgets
  ALTER COLUMN retry_budget_id SET NOT NULL,
  ALTER COLUMN scope_key SET NOT NULL,
  ALTER COLUMN attempt_id SET NOT NULL,
  ALTER COLUMN lease_id SET NOT NULL,
  ALTER COLUMN fencing_token SET NOT NULL,
  ALTER COLUMN activation_hash SET NOT NULL,
  ALTER COLUMN checkpoint_hash SET NOT NULL,
  ALTER COLUMN bundle_hash SET NOT NULL,
  ALTER COLUMN payload_json SET NOT NULL,
  ADD CONSTRAINT continuation_retry_budget_id_uq UNIQUE(workspace_id,retry_budget_id),
  ADD CONSTRAINT continuation_retry_scope_hash_ck CHECK(scope_key ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT continuation_retry_authority_hash_ck CHECK(activation_hash ~ '^sha256:[0-9a-f]{64}$' AND checkpoint_hash ~ '^sha256:[0-9a-f]{64}$' AND bundle_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT continuation_retry_fence_ck CHECK(fencing_token>0),
  ADD CONSTRAINT continuation_retry_lease_fk FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT,
  ADD CONSTRAINT continuation_retry_attempt_fk FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT;

CREATE TABLE rorca.continuation_retry_events (
  workspace_id TEXT NOT NULL,
  continuation_key TEXT NOT NULL,
  event_sequence BIGINT NOT NULL CHECK(event_sequence>0),
  retry_fence BIGINT NOT NULL CHECK(retry_fence>=0),
  phase TEXT NOT NULL CHECK(phase IN('retrieval','transport')),
  event_type TEXT NOT NULL CHECK(event_type IN('claimed','stale_reclaimed','released','succeeded','retryable_failed','permanent_conflict','exhausted','quarantined')),
  owner TEXT,
  reason_code TEXT NOT NULL,
  event_hash TEXT NOT NULL CHECK(event_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,continuation_key,event_sequence),
  UNIQUE(workspace_id,continuation_key,event_hash),
  FOREIGN KEY(workspace_id,continuation_key) REFERENCES rorca.continuation_retry_budgets(workspace_id,continuation_key) ON DELETE RESTRICT
);

ALTER TABLE rorca.continuation_retry_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY continuation_retry_events_workspace_policy ON rorca.continuation_retry_events
  USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=continuation_retry_events.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
      (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))))
  WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=continuation_retry_events.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
      (NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))));
CREATE TRIGGER continuation_retry_events_immutable BEFORE UPDATE OR DELETE ON rorca.continuation_retry_events
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER continuation_retry_events_no_truncate BEFORE TRUNCATE ON rorca.continuation_retry_events
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729138000,
    contract_source_digest='sha256:35285e9ec3cd1b1d832e92f2fad977b3c986d63f77a2ae303cb020d30ee99247',
    installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729137000
  AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729138000 AND contract_source_digest='sha256:35285e9ec3cd1b1d832e92f2fad977b3c986d63f77a2ae303cb020d30ee99247') THEN
    RAISE EXCEPTION 'Wave 2 retry subject readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
