-- 20260810120000_lifecycle_profile_hash.sql
-- Track the canonical stage-profile hash on compiled plans so a stage-mapping
-- change (general-sdlc-7 profile) supersedes plans compiled under the previous
-- mapping even when the spec material hash is unchanged.
-- runPgMigrations supplies the transaction boundary for this file.

ALTER TABLE ssdlc_compiled_plans
  ADD COLUMN IF NOT EXISTS profile_hash TEXT;

-- NULL on legacy rows can never equal a real sha256 digest, so historical plans
-- are recompiled under the active profile before they can be reused or validated.
ALTER TABLE ssdlc_compiled_plans
  DROP CONSTRAINT IF EXISTS ssdlc_compiled_plans_identity_unique;

ALTER TABLE ssdlc_compiled_plans
  ADD CONSTRAINT ssdlc_compiled_plans_identity_unique UNIQUE (
    workspace_id,
    spec_slug,
    spec_version,
    compiler_version,
    normalized_input_hash,
    profile_hash
  );
