-- 20260618140000_spec_repair_recovery_indexes.sql — Repair recovery lookup indexes.
-- Speeds idempotent repair decisions for post-save enrichment stages without touching pgboss-managed schema.

CREATE INDEX IF NOT EXISTS idx_spec_jobs_repair_recovery
  ON spec_jobs(workspace_id, spec_id, job_type, status, created_at DESC)
  WHERE job_type IN ('enrich', 'match-skills');
