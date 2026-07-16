-- LFC-009: Persist host-enforced execution/safety options and the bounded
-- completion packet presented at story closeout. These are metadata only;
-- lifecycle authority remains in the shared closeout contracts.

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS effective_options JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(effective_options) = 'object');

ALTER TABLE story_results
  ADD COLUMN IF NOT EXISTS completion_packet JSONB
    CHECK (completion_packet IS NULL OR jsonb_typeof(completion_packet) = 'object');
