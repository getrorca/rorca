-- 051_graph_drift_reports.sql — PG-017: Graph-powered drift detection columns

-- Add spec_id to drift_reports so we can link reports to specific spec runs
ALTER TABLE drift_reports ADD COLUMN IF NOT EXISTS spec_id TEXT;

-- Add impact analysis JSON (blast radius per file)
ALTER TABLE drift_reports ADD COLUMN IF NOT EXISTS impact_json JSONB NOT NULL DEFAULT '[]';

-- Drop and recreate the trigger_type check to allow 'post-run'
ALTER TABLE drift_reports DROP CONSTRAINT IF EXISTS drift_reports_trigger_type_check;
ALTER TABLE drift_reports ADD CONSTRAINT drift_reports_trigger_type_check
  CHECK(trigger_type IN ('manual', 'pre-execution', 'post-run'));

-- Index for spec_id lookups
CREATE INDEX IF NOT EXISTS idx_drift_reports_spec ON drift_reports(spec_id);
