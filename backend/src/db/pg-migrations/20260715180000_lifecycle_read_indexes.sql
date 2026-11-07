-- 20260715180000_lifecycle_read_indexes.sql
-- LFC-013: measured lifecycle portfolio/phase read paths.
-- These indexes support bounded snapshot reads; no response cache is introduced.

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_lifecycle_spec_latest
  ON pipeline_runs (
    workspace_id,
    (regexp_replace(spec_path, '^.*/|\.json$', '', 'g')),
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_ssdlc_evidence_lifecycle_snapshot
  ON ssdlc_lifecycle_evidence (workspace_id, spec_slug, observed_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_ssdlc_decisions_lifecycle_snapshot
  ON ssdlc_decisions (workspace_id, spec_slug, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_spec_search_lifecycle_workspace
  ON spec_search_index (workspace_id, generated_at DESC, spec_slug);
