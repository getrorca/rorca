-- Mirror critical semantic bounds in PostgreSQL and advance the generated contract digest.

ALTER TABLE rorca.context_policy_definitions ADD CONSTRAINT context_policy_positive_limits_ck CHECK(
  (body_json->'limits'->>'totalTokens')::INTEGER BETWEEN 1 AND 64000
  AND (body_json->'limits'->>'requiredTokens')::INTEGER BETWEEN 1 AND 48000
  AND (body_json->'limits'->>'requiredSources')::INTEGER BETWEEN 1 AND 500
  AND (body_json->'limits'->>'serializedBytes')::INTEGER BETWEEN 1 AND 4194304
  AND (body_json->'limits'->>'ttlMinutes')::INTEGER BETWEEN 1 AND 60
  AND (body_json->'limits'->>'deltaChain')::INTEGER BETWEEN 1 AND 8
  AND (body_json->'limits'->>'retrievalAttempts')::INTEGER BETWEEN 1 AND 5
  AND (body_json->'limits'->>'transportReconciliations')::INTEGER BETWEEN 1 AND 3
);

ALTER TABLE rorca.context_retrieval_receipts ADD CONSTRAINT context_receipt_token_sum_ck CHECK(
  (payload_json->'tokenAccounting'->>'total')::INTEGER =
  (payload_json->'tokenAccounting'->>'required')::INTEGER
  + (payload_json->'tokenAccounting'->>'advisory')::INTEGER
  + (payload_json->'tokenAccounting'->>'instructions')::INTEGER
  AND finished_at >= created_at
);

ALTER TABLE rorca.context_bundles ADD CONSTRAINT context_bundle_token_sum_ck CHECK(
  (payload_json->'tokenAccounting'->>'total')::INTEGER =
  (payload_json->'tokenAccounting'->>'required')::INTEGER
  + (payload_json->'tokenAccounting'->>'advisory')::INTEGER
  + (payload_json->'tokenAccounting'->>'instructions')::INTEGER
  AND expires_at > created_at
);

ALTER TABLE rorca.execution_cancellation_requests ADD CONSTRAINT cancellation_deadline_order_ck CHECK(deadline_at>requested_at);

UPDATE rorca.wave2_schema_readiness
SET migration_version=20260729143000,
    contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d',
    installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729142000
  AND contract_source_digest='sha256:25cf1b7324834d1b6233606821863f34e1e7719871bf02a327ea4c2e2ed7850c';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM rorca.wave2_schema_readiness WHERE singleton=TRUE AND state='ready'
    AND migration_version=20260729143000 AND contract_source_digest='sha256:ee4bb819784530868104f7f1a25e68d15105ca14ab8578d536055ade69992b2d') THEN
    RAISE EXCEPTION 'Wave 2 semantic contract readiness transition failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
