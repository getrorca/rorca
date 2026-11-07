-- Advance Wave 2 readiness after runtime-event continuation identities and typed phase material became explicit.

UPDATE rorca.wave2_schema_readiness
SET contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2',
    migration_version=20260729134000,
    installed_at=clock_timestamp()
WHERE singleton=TRUE AND state='ready' AND migration_version=20260729133000
  AND contract_source_digest='sha256:4fb7606213db1f78df5e61829bfb6561a800088169b225d9e1262f7ab2de7b6f';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM rorca.wave2_schema_readiness
    WHERE singleton=TRUE AND state='ready' AND migration_version=20260729134000
      AND contract_source_digest='sha256:b06bd5bdd4d999879d14a548b29c91ddd09cc702c280d6fa651cccc0baeeddb2'
  ) THEN
    RAISE EXCEPTION 'Wave 2 runtime event contract alignment failed closed' USING ERRCODE='55000';
  END IF;
END;
$$;
