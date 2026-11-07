-- 20260618120000_spec_generation_log_fingerprints.sql — Persist deterministic post-save stage fingerprints
-- Adds inspectable fingerprints for enrich and match-skills invalidation decisions.

ALTER TABLE spec_generation_logs
  ADD COLUMN IF NOT EXISTS enrich_fingerprint TEXT;

ALTER TABLE spec_generation_logs
  ADD COLUMN IF NOT EXISTS match_skills_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_spec_generation_logs_slug_enrich_fingerprint
  ON spec_generation_logs (spec_slug, enrich_fingerprint);

CREATE INDEX IF NOT EXISTS idx_spec_generation_logs_slug_match_skills_fingerprint
  ON spec_generation_logs (spec_slug, match_skills_fingerprint);
