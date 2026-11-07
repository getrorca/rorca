-- Worker settings table: persists configurable worker parameters (e.g. max_concurrent_runs)
-- so they survive backend restarts without touching .env.

CREATE TABLE IF NOT EXISTS worker_settings (
  id         SERIAL PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
