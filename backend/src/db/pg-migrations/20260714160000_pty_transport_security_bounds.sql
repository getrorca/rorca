-- Bound interactive PTY control-plane mutations and give local authenticated
-- typing a purpose-built request budget. NOT VALID constraints protect all new
-- rows without making a legacy upgrade fail on already-consumed historical rows.

ALTER TABLE run_pty_resize_requests
  DROP CONSTRAINT IF EXISTS run_pty_resize_requests_dimensions_check;
ALTER TABLE run_pty_resize_requests
  ADD CONSTRAINT run_pty_resize_requests_dimensions_check
  CHECK (cols BETWEEN 1 AND 500 AND rows BETWEEN 1 AND 200) NOT VALID;

ALTER TABLE run_pty_input_requests
  DROP CONSTRAINT IF EXISTS run_pty_input_requests_byte_length_check;
ALTER TABLE run_pty_input_requests
  ADD CONSTRAINT run_pty_input_requests_byte_length_check
  CHECK (byte_length BETWEEN 1 AND 65536) NOT VALID;

INSERT INTO rate_limits (endpoint_pattern, tier, max_requests, window_seconds)
VALUES
  ('POST /api/pipeline/runs/:runId/input', 'authenticated', 600, 60),
  ('POST /api/pipeline/runs/:runId/input', 'unauthenticated', 120, 60)
ON CONFLICT (endpoint_pattern, tier) DO UPDATE
SET max_requests = EXCLUDED.max_requests,
    window_seconds = EXCLUDED.window_seconds,
    updated_at = NOW();
