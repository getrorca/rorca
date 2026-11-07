-- Reassert split-principal dependencies introduced after the Wave 2 cutover.
-- Release qualification intentionally remains runtime-read-only; crypto stays
-- callable only by the two bounded service principals.

REVOKE ALL ON TABLE rorca.run_findings FROM PUBLIC;
REVOKE ALL ON SEQUENCE rorca.run_findings_id_seq FROM PUBLIC;
REVOKE ALL ON TABLE rorca.ssdlc_reconciliation_receipts FROM PUBLIC;
REVOKE ALL ON TABLE rorca.ssdlc_release_qualifications FROM PUBLIC;
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

  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON rorca.run_findings TO %I', runtime_user);
  EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE rorca.run_findings_id_seq TO %I', runtime_user);
  EXECUTE format('GRANT SELECT,INSERT ON rorca.ssdlc_reconciliation_receipts TO %I', runtime_user);
  EXECUTE format('GRANT SELECT ON rorca.ssdlc_release_qualifications TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(text,text) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(bytea,text) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.hmac(bytea,bytea,text) TO %I', runtime_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(text,text) TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.digest(bytea,text) TO %I', writer_user);
  EXECUTE format('GRANT EXECUTE ON FUNCTION rorca.hmac(bytea,bytea,text) TO %I', writer_user);
END $$;
