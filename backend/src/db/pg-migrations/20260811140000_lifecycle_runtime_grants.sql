-- 20260811140000_lifecycle_runtime_grants.sql
-- The lifecycle reconciliation and release-qualification artifacts were
-- created by 20260811110000 without granting the runtime principal, which
-- fails closed under the split-principal topology (the portfolio read model
-- and the qualification runner both execute through the runtime pool).
-- Mirror the grant pattern established by
-- 20260811100000_run_findings_runtime_grants.sql: derive the principal from
-- the rorca.runtime_database_user GUC and fail loudly when it is absent
-- rather than silently skipping the grant.
--
-- UPDATE/DELETE remain blocked by the append-only triggers created in
-- 20260811110000; the broad grant mirrors the run_findings convention and
-- keeps future operator repair paths from needing another migration.

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal'; END IF;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.ssdlc_reconciliation_receipts TO %I',runtime_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.ssdlc_release_qualifications TO %I',runtime_user);
END $$;
