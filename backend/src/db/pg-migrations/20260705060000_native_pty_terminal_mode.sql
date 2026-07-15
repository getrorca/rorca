-- Allow native interactive CLI PTY sessions as a first-class terminal mode.
-- Existing modes remain unchanged:
--   ansi-html: legacy chunked ANSI/HTML replay
--   pty:       reliable non-interactive print/exec command inside xterm PTY
--   native-pty: real interactive CLI in xterm PTY with marker-based completion

ALTER TABLE pipeline_runs
  DROP CONSTRAINT IF EXISTS pipeline_runs_terminal_mode_check;

ALTER TABLE pipeline_runs
  ADD CONSTRAINT pipeline_runs_terminal_mode_check
  CHECK (terminal_mode IN ('ansi-html', 'pty', 'native-pty'));
