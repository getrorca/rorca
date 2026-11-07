-- 20260806120100_wave5_forgejo_adapter_fix.sql
-- Wave 5 Forgejo adapter remediation (lane 5A): the base adapter migration
-- froze the shared release-intent contract but omitted the columns its own
-- module INSERT/SELECT reference, and never granted the split principals DML
-- on the shared ledger it now actuates.
--
--   * repository_instance_url, proposal_hash, changed_path_manifest_hash are
--     written by prepareForgejoRunReleaseIntent (INSERT) and read back by
--     loadIntent; without them the adapter fails closed at runtime.
--   * pipeline_run_release_intents DML (intent freeze, reconcile) and
--     pipeline_runs SELECT (frozen-run revalidation) run under the runtime and
--     canonical writer principals; base migrations never granted either.

ALTER TABLE pipeline_run_release_intents
  ADD COLUMN IF NOT EXISTS repository_instance_url TEXT,
  ADD COLUMN IF NOT EXISTS proposal_hash TEXT
    CHECK (proposal_hash IS NULL OR proposal_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS changed_path_manifest_hash TEXT
    CHECK (changed_path_manifest_hash IS NULL OR changed_path_manifest_hash ~ '^sha256:[0-9a-f]{64}$');

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
DECLARE writer_user TEXT := current_setting('rorca.canonical_writer_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' OR writer_user IS NULL OR writer_user='' THEN
    RAISE EXCEPTION 'Wave 5 Forgejo adapter fix principals required' USING ERRCODE='42501';
  END IF;
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE rorca.pipeline_run_release_intents TO %I',runtime_user);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON TABLE rorca.pipeline_run_release_intents TO %I',writer_user);
  EXECUTE format('GRANT SELECT ON TABLE rorca.pipeline_runs TO %I',runtime_user);
  EXECUTE format('GRANT SELECT ON TABLE rorca.pipeline_runs TO %I',writer_user);
END $$;
