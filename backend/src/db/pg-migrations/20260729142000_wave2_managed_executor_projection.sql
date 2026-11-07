-- Integrate disabled-default governed compatibility observations into canonical story-result persistence.

CREATE TABLE rorca.managed_executor_compatibility_events (
  workspace_id TEXT NOT NULL,
  run_id BIGINT NOT NULL,
  story_id TEXT NOT NULL,
  story_result_id BIGINT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN('observe','enforce')),
  availability TEXT NOT NULL CHECK(availability IN('available','legacy_unmappable')),
  projection_hash TEXT NOT NULL CHECK(projection_hash ~ '^sha256:[0-9a-f]{64}$'),
  observed_status TEXT NOT NULL,
  authoritative BOOLEAN NOT NULL CHECK(authoritative=FALSE),
  execution_authority TEXT NOT NULL CHECK(execution_authority='none'),
  merge_authority TEXT NOT NULL CHECK(merge_authority='none'),
  deployment_authority TEXT NOT NULL CHECK(deployment_authority='none'),
  payload_json JSONB NOT NULL CHECK(jsonb_typeof(payload_json)='object' AND octet_length(payload_json::text)<=32768),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,story_result_id),
  UNIQUE(workspace_id,projection_hash),
  FOREIGN KEY(story_result_id) REFERENCES rorca.story_results(id) ON DELETE RESTRICT
);
ALTER TABLE rorca.managed_executor_compatibility_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY managed_executor_compatibility_events_workspace_policy ON rorca.managed_executor_compatibility_events
  USING (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=managed_executor_compatibility_events.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))))
  WITH CHECK (EXISTS (SELECT 1 FROM rorca.workspace_members wm WHERE wm.workspace_id=managed_executor_compatibility_events.workspace_id
    AND wm.user_auth_id::text=COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),(NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))));
CREATE TRIGGER managed_executor_compatibility_events_immutable BEFORE UPDATE OR DELETE ON rorca.managed_executor_compatibility_events
  FOR EACH ROW EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER managed_executor_compatibility_events_no_truncate BEFORE TRUNCATE ON rorca.managed_executor_compatibility_events
  FOR EACH STATEMENT EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729142000, installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729141000
  AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729142000 AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c') THEN
    RAISE EXCEPTION 'Wave 2 managed executor projection readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
