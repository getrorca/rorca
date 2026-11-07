-- 20260820020000_rorca_schema_pgcrypto_runtime_grants.sql
-- Memory synthesis and post-save workflow jobs call schema-qualified
-- rorca.digest(...) / rorca.hmac(...). Derive the split principals from the
-- migration contract; deployments may not use the default role names.

REVOKE ALL ON FUNCTION rorca.digest(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.digest(bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rorca.hmac(bytea, bytea, text) FROM PUBLIC;

DO $$
DECLARE
  runtime_user TEXT := current_setting('rorca.runtime_database_user', TRUE);
  writer_user TEXT := current_setting('rorca.canonical_writer_database_user', TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = runtime_user AND principal_class = 'internal_runtime'
     ) THEN
    RAISE EXCEPTION 'registered Wave 2 runtime principal is required' USING ERRCODE = '42501';
  END IF;
  IF writer_user IS NULL OR writer_user = ''
     OR NOT EXISTS (
       SELECT 1 FROM rorca.wave2_database_principals
       WHERE database_user = writer_user AND principal_class = 'canonical_writer'
     ) THEN
    RAISE EXCEPTION 'registered Wave 2 canonical writer principal is required' USING ERRCODE = '42501';
  END IF;

  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(text,text) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(bytea,text) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.hmac(bytea,bytea,text) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(text,text) TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(bytea,text) TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.hmac(bytea,bytea,text) TO %I', writer_user);
END $$;
