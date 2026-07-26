-- 20260720151000_wave_dispatch_starting_status.sql
-- Align the public pipeline status constraint with the fenced queued -> starting
-- -> running dispatch protocol introduced by wave production governance.

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_status_check,
  ADD CONSTRAINT pipeline_runs_status_check CHECK (status IN (
    'running', 'paused', 'done', 'failed', 'partial_failure', 'cancelled',
    'queued', 'starting', 'release_pending', 'pi_native'
  ));
