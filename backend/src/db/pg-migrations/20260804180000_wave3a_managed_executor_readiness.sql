-- Wave 3A / ROR-28 exact prerequisite gate. Additive and fail closed.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rorca.wave2_effective_readiness
    WHERE ready=TRUE AND migration_version=20260731157000
      AND contract_source_digest='sha256:1111a20f8b6e8cfca7ddcf8861069989bdd7b7c4b52c5b12e26cb2ff8ad6bbfb'
      AND prerequisite_receipt_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Wave 3A requires the exact accepted Wave 2 readiness chain' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rorca.completion_schema_readiness
    WHERE singleton=TRUE AND protocol_version=1 AND migration_version=20260804170000
      AND contract_source_digest='sha256:6efbecef9d1a2d6252dbf34fb870e48f95a793a1547bf505bce34e21277be2b5'
      AND state='ready'
  ) THEN
    RAISE EXCEPTION 'Wave 3A requires the exact Wave 2 completion protocol' USING ERRCODE='55000';
  END IF;
END;
$$;

CREATE TABLE rorca.wave3a_schema_readiness (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  contract_version TEXT NOT NULL CHECK(contract_version='rorca.managed-executor.v1'),
  wave2_implementation_git_sha TEXT NOT NULL CHECK(wave2_implementation_git_sha='1420fb4c819aad692894da9449bc4958ed74dd49'),
  wave2_migration_head BIGINT NOT NULL CHECK(wave2_migration_head=20260731157000),
  wave2_completion_migration BIGINT NOT NULL CHECK(wave2_completion_migration=20260804170000),
  wave3a_spec_sha256 TEXT NOT NULL CHECK(wave3a_spec_sha256='sha256:249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d'),
  allowed_parallel_pair JSONB NOT NULL CHECK(allowed_parallel_pair='["ROR-25", "ROR-28"]'::jsonb),
  serialized_integration_paths JSONB NOT NULL CHECK(jsonb_typeof(serialized_integration_paths)='array'),
  migration_version BIGINT NOT NULL CHECK(migration_version IN(20260804180000,20260804181000,20260804182000)),
  state TEXT NOT NULL CHECK(state IN('installing','ready','blocked')),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK(state<>'ready' OR migration_version>=20260804180000)
);

INSERT INTO rorca.wave3a_schema_readiness(
  singleton,contract_version,wave2_implementation_git_sha,wave2_migration_head,wave2_completion_migration,
  wave3a_spec_sha256,allowed_parallel_pair,serialized_integration_paths,migration_version,state)
VALUES(
  TRUE,'rorca.managed-executor.v1','1420fb4c819aad692894da9449bc4958ed74dd49',20260731157000,20260804170000,
  'sha256:249b8fc33c6223acd63549f28c59714dfe3212df3b4d00572f9aef2e2252060d',
  '["ROR-25", "ROR-28"]'::jsonb,
  '["packages/rorca-public-contract","scripts/generate-governed-contract-artifacts.ts","generated schemas","docs/implementation/governed-mission-waves-coverage.json"]'::jsonb,
  20260804180000,'installing'
);


CREATE TRIGGER wave3a_schema_readiness_immutable
BEFORE DELETE ON rorca.wave3a_schema_readiness FOR EACH ROW
EXECUTE FUNCTION rorca.w2_reject_immutable_mutation();
CREATE TRIGGER wave3a_schema_readiness_no_truncate
BEFORE TRUNCATE ON rorca.wave3a_schema_readiness FOR EACH STATEMENT
EXECUTE FUNCTION rorca.w2_reject_immutable_truncate();

REVOKE ALL PRIVILEGES ON TABLE rorca.wave3a_schema_readiness FROM PUBLIC,authenticated,anon;
