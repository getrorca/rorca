-- Split max_concurrent_runs into two settings:
--   queue_max_concurrent   — concurrency for queued (non-worktree) pipeline:run jobs (default 1)
--   run_now_max_concurrent — concurrency for immediate worktree-isolated runs (default 3)
-- The old max_concurrent_runs row is kept for backwards compatibility but no longer used.

INSERT INTO worker_settings (key, value, updated_at)
VALUES ('queue_max_concurrent', '1', NOW())
ON CONFLICT (key) DO NOTHING;

INSERT INTO worker_settings (key, value, updated_at)
VALUES ('run_now_max_concurrent', '3', NOW())
ON CONFLICT (key) DO NOTHING;
