-- Truthful derived cancellation state and lease-bound proposal review transitions.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rorca.execution_cancellation_acknowledgements)
     OR EXISTS (SELECT 1 FROM rorca.plan_change_proposals) THEN
    RAISE EXCEPTION 'Existing cancellation acknowledgements or unbound proposals require explicit operator reconciliation'
      USING ERRCODE='55000';
  END IF;
END;
$$;

ALTER TABLE rorca.execution_cancellation_acknowledgements
  ADD COLUMN disposition TEXT,
  ADD COLUMN acknowledged_at TIMESTAMPTZ;
ALTER TABLE rorca.execution_cancellation_acknowledgements
  ALTER COLUMN disposition SET NOT NULL,
  ALTER COLUMN acknowledged_at SET NOT NULL,
  ADD CONSTRAINT cancellation_ack_disposition_ck CHECK(disposition IN('acknowledged','graceful','forced_expiry','lost_runtime','conflicted'));

CREATE VIEW rorca.execution_cancellation_effective_state AS
SELECT r.workspace_id,r.cancellation_id,r.attempt_id,r.lease_id,r.fencing_token,r.state request_state,
  CASE WHEN accepted.acknowledgement_id IS NULL THEN r.state ELSE accepted.disposition END effective_disposition,
  accepted.acknowledgement_id,accepted.acknowledged_at,accepted.runtime_id,
  (accepted.acknowledgement_id IS NOT NULL) acknowledged,
  TRUE request_row_immutable
FROM rorca.execution_cancellation_requests r
LEFT JOIN LATERAL (
  SELECT a.acknowledgement_id,a.disposition,a.acknowledged_at,a.runtime_id
  FROM rorca.execution_cancellation_acknowledgements a
  WHERE a.workspace_id=r.workspace_id AND a.cancellation_id=r.cancellation_id AND a.classification='accepted'
  ORDER BY a.received_at,a.acknowledgement_id LIMIT 1
) accepted ON TRUE;

ALTER TABLE rorca.plan_change_proposals
  ADD COLUMN attempt_id TEXT,
  ADD COLUMN lease_id TEXT,
  ADD COLUMN fencing_token BIGINT,
  ADD COLUMN activation_hash TEXT,
  ADD COLUMN state_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE rorca.plan_change_proposals
  ALTER COLUMN attempt_id SET NOT NULL,
  ALTER COLUMN lease_id SET NOT NULL,
  ALTER COLUMN fencing_token SET NOT NULL,
  ALTER COLUMN activation_hash SET NOT NULL,
  ADD CONSTRAINT plan_change_proposal_fence_ck CHECK(fencing_token>0),
  ADD CONSTRAINT plan_change_proposal_activation_ck CHECK(activation_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT plan_change_proposal_lease_fk FOREIGN KEY(workspace_id,lease_id) REFERENCES rorca.execution_leases(workspace_id,lease_id) ON DELETE RESTRICT,
  ADD CONSTRAINT plan_change_proposal_attempt_fk FOREIGN KEY(workspace_id,attempt_id) REFERENCES rorca.governed_execution_attempts(workspace_id,attempt_id) ON DELETE RESTRICT;

CREATE TABLE rorca.plan_change_proposal_heads (
  workspace_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  current_state TEXT NOT NULL CHECK(current_state IN('proposed','under_review','accepted','rejected','stale')),
  state_version BIGINT NOT NULL DEFAULT 1 CHECK(state_version>0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,proposal_id),
  FOREIGN KEY(workspace_id,proposal_id) REFERENCES rorca.plan_change_proposals(workspace_id,proposal_id) ON DELETE RESTRICT
);
ALTER TABLE rorca.plan_change_proposal_heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_change_proposal_heads_workspace_policy ON rorca.plan_change_proposal_heads
  USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=plan_change_proposal_heads.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))))
  WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=plan_change_proposal_heads.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))));

CREATE TABLE rorca.plan_change_proposal_reviews (
  workspace_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  review_sequence BIGINT NOT NULL CHECK(review_sequence>0),
  prior_state TEXT NOT NULL CHECK(prior_state IN('proposed','under_review','accepted','rejected','stale')),
  next_state TEXT NOT NULL CHECK(next_state IN('under_review','accepted','rejected','stale')),
  reviewer_authority_ref TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  review_hash TEXT NOT NULL CHECK(review_hash ~ '^sha256:[0-9a-f]{64}$'),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,proposal_id,review_sequence),
  UNIQUE(workspace_id,proposal_id,review_hash),
  FOREIGN KEY(workspace_id,proposal_id) REFERENCES rorca.plan_change_proposals(workspace_id,proposal_id) ON DELETE RESTRICT
);
ALTER TABLE rorca.plan_change_proposal_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY plan_change_proposal_reviews_workspace_policy ON rorca.plan_change_proposal_reviews
  USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=plan_change_proposal_reviews.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))))
  WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=plan_change_proposal_reviews.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))));
CREATE TRIGGER plan_change_proposal_reviews_immutable BEFORE UPDATE OR DELETE ON rorca.plan_change_proposal_reviews
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER plan_change_proposal_reviews_no_truncate BEFORE TRUNCATE ON rorca.plan_change_proposal_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729139000,
    contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c',
    installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729138000
  AND contract_source_digest='sha256:35285e9ec3cd1b1d832e92f2fad977b3c986d63f77a2ae303cb020d30ee99247';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729139000 AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c') THEN
    RAISE EXCEPTION 'Wave 2 cancellation/proposal readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
