-- Durable bounded worker terminalization reason used by fresh/retry closeout.
-- Worker SQL has always treated this as application-table authority; add it
-- forward-only so pre-spawn and worktree-guard failures cannot be acknowledged
-- while the canonical run remains queued.
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS summary TEXT;

ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_summary_length_ck CHECK (
    summary IS NULL OR char_length(summary) <= 4000
  ) NOT VALID;
