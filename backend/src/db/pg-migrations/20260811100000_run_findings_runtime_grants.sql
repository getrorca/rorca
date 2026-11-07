-- 20260811100000_run_findings_runtime_grants.sql
-- US-009: run_findings is read by the runtime principal (feed-forward
-- findings endpoint) and written by the worker during closeout. The original
-- 20260810140000 migration created the table without granting either role,
-- which fails closed under the split-principal topology. Mirror the grant
-- pattern established by 20260811090000_memory_workspace_shares.sql: derive
-- the principal from the rorca.runtime_database_user GUC and fail loudly when
-- it is absent rather than silently skipping the grant.
--
-- The table lives in the `rorca` schema: migration sessions run with
-- search_path=rorca,public, so the unqualified CREATE TABLE in
-- 20260810140000 resolved to rorca.run_findings.

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal'; END IF;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.run_findings TO %I',runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_findings_id_seq TO %I',runtime_user);
END $$;
