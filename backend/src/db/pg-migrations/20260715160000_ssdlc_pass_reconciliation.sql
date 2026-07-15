-- LFC-010: workspace/version identities for deterministic pass reconciliation.
-- `passes` remains in approved JSON; these columns bind result projections and
-- spec snapshots to their immutable evidence/workspace without creating a new
-- lifecycle source of truth.

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS spec_id TEXT,
  ADD COLUMN IF NOT EXISTS spec_revision TEXT,
  ADD COLUMN IF NOT EXISTS story_revision TEXT,
  ADD COLUMN IF NOT EXISTS manifest_hash TEXT REFERENCES story_execution_manifests(manifest_hash),
  ADD COLUMN IF NOT EXISTS closeout_decision_id TEXT REFERENCES story_closeout_decisions(decision_id),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE story_results sr
SET spec_id = regexp_replace(pr.spec_path, '^.*/|\\.json$', '', 'g'),
    created_at = COALESCE(sr.started_at, NOW())
FROM pipeline_runs pr
WHERE pr.id = sr.run_id
  AND sr.spec_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_story_results_reconcile_scope
  ON story_results (spec_id, story_id, created_at DESC, run_id);

ALTER TABLE spec_versions
  ADD COLUMN IF NOT EXISTS workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;

-- Preserve the existing global (spec_slug, version) uniqueness contract used by
-- legacy version routes/ON CONFLICT clauses. New rows carry workspace identity,
-- while version numbers remain monotonic per slug across workspaces.
CREATE INDEX IF NOT EXISTS idx_spec_versions_reconcile_scope
  ON spec_versions (workspace_id, spec_slug, version DESC);
