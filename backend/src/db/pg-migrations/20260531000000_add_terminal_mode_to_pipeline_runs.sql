-- Add terminal_mode to pipeline_runs so each run declares how terminal output
-- should be rendered and replayed.
ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS terminal_mode TEXT NOT NULL DEFAULT 'ansi-html'
    CHECK (terminal_mode IN ('ansi-html', 'pty'));
