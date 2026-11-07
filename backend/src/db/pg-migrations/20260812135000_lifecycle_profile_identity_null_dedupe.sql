-- 20260812135000_lifecycle_profile_identity_null_dedupe.sql
-- Preserve compiled-plan replay identity for legacy rows whose profile hash predates profile tracking.
-- PostgreSQL 16 NULLS NOT DISTINCT keeps profile_hash nullable for migration compatibility without
-- allowing duplicate legacy identities.
-- runPgMigrations supplies the transaction boundary for this file.

ALTER TABLE rorca.ssdlc_compiled_plans
  DROP CONSTRAINT IF EXISTS ssdlc_compiled_plans_identity_unique;

ALTER TABLE rorca.ssdlc_compiled_plans
  ADD CONSTRAINT ssdlc_compiled_plans_identity_unique UNIQUE NULLS NOT DISTINCT (
    workspace_id,
    spec_slug,
    spec_version,
    compiler_version,
    normalized_input_hash,
    profile_hash
  );
