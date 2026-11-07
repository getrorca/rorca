-- Bind ContextEpoch retirement to durable evidence and make dispatch projection exact.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM rorca.continuation_dispatches) THEN
    RAISE EXCEPTION 'Existing continuation dispatches require explicit hash/payload reconciliation before projection migration'
      USING ERRCODE='55000';
  END IF;
END;
$$;

ALTER TABLE rorca.continuation_dispatches
  ADD COLUMN dispatch_hash TEXT,
  ADD COLUMN payload_json JSONB;
ALTER TABLE rorca.continuation_dispatches
  ALTER COLUMN dispatch_hash SET NOT NULL,
  ALTER COLUMN payload_json SET NOT NULL,
  ADD CONSTRAINT continuation_dispatch_hash_ck CHECK(dispatch_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT continuation_dispatch_payload_ck CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=262144);

CREATE TABLE rorca.context_epoch_retirement_evidence (
  workspace_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN('migration_fixtures','rollback_fixtures','break_markers','release_notes','next_major_declaration')),
  status TEXT NOT NULL CHECK(status IN('passed','failed')),
  source_ref TEXT NOT NULL,
  trust_level TEXT NOT NULL CHECK(trust_level IN('host_observed','provider_verified','provider_human')),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,evidence_hash),
  UNIQUE(workspace_id,evidence_kind,evidence_hash)
);

CREATE TABLE rorca.context_epoch_retirement_review_decisions (
  workspace_id TEXT NOT NULL,
  review_receipt_id TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK(evidence_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted BOOLEAN NOT NULL,
  reviewer_authority_ref TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,review_receipt_id),
  UNIQUE(workspace_id,evidence_hash)
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['context_epoch_retirement_evidence','context_epoch_retirement_review_decisions'] LOOP
    EXECUTE format('ALTER TABLE rorca.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON rorca.%I USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=%I.workspace_id AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting(''request.jwt.claim.sub'',true),''''),(NULLIF(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub'')))) WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=%I.workspace_id AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting(''request.jwt.claim.sub'',true),''''),(NULLIF(current_setting(''request.jwt.claims'',true),'''')::jsonb->>''sub''))))',
      'wave2_workspace_'||table_name,table_name,table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON rorca.%I FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation()',
      'wave2_immutable_'||table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON rorca.%I FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate()',
      'wave2_no_truncate_'||table_name,table_name);
  END LOOP;
END;
$$;

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729140000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729139000
  AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729140000 AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c') THEN
    RAISE EXCEPTION 'Wave 2 retirement/projection readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
