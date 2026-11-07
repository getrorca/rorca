-- Execution environments, secret profiles, and outbound runner jobs.
-- Rorca remains the control plane; execution hosts own their local credentials.

CREATE TABLE IF NOT EXISTS execution_secret_profiles (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('env', 'mounted-file', 'host-local', 'infisical')),
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_environments (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('remote-rorca', 'local-runner', 'ci-runner')),
  network_mode TEXT NOT NULL DEFAULT 'local' CHECK (network_mode IN ('local', 'tailscale', 'ssh-tunnel', 'public-https')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  supported_agents TEXT[] NOT NULL DEFAULT ARRAY['claude','codex','opencode','pi']::TEXT[],
  allowed_workspace_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  secret_profile_id TEXT REFERENCES execution_secret_profiles(id) ON DELETE SET NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK (max_concurrency >= 1),
  runner_token_hash TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS execution_runner_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES execution_environments(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled')),
  payload JSONB NOT NULL,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id)
);

ALTER TABLE pipeline_runs
  ADD COLUMN IF NOT EXISTS execution_environment TEXT NOT NULL DEFAULT 'remote-rorca';

CREATE INDEX IF NOT EXISTS idx_execution_environments_kind_enabled
  ON execution_environments(kind, enabled);

CREATE INDEX IF NOT EXISTS idx_execution_runner_jobs_environment_status
  ON execution_runner_jobs(environment_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_execution_runner_jobs_run_id
  ON execution_runner_jobs(run_id);

INSERT INTO execution_secret_profiles (id, label, provider, config)
VALUES
  ('remote-rorca-env', 'Remote Rorca host environment', 'env', '{"description":"Use environment variables and mounted runtime files on the remote Rorca host."}'::jsonb),
  ('local-host-auth', 'Local host CLI auth', 'host-local', '{"description":"Use CLI auth files already present on the local execution host."}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO execution_environments (id, label, kind, network_mode, enabled, supported_agents, secret_profile_id, metadata)
VALUES
  ('remote-rorca', 'Remote Rorca worker', 'remote-rorca', 'local', TRUE, ARRAY['claude','codex','opencode','pi']::TEXT[], 'remote-rorca-env', '{"default":true}'::jsonb),
  ('local-user', 'Local user runner', 'local-runner', 'tailscale', TRUE, ARRAY['claude','codex','opencode','pi']::TEXT[], 'local-host-auth', '{"requiresOutboundRunner":true}'::jsonb)
ON CONFLICT (id) DO NOTHING;
