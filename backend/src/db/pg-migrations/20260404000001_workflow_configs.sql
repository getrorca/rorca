-- Workflow router configuration table
-- Stores per-workflow runtime, provider, and model settings

CREATE TABLE IF NOT EXISTS workflow_configs (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id   TEXT          NOT NULL UNIQUE,
  runtime       TEXT          NOT NULL DEFAULT 'native',
  provider      TEXT          NOT NULL DEFAULT 'claude-cli',
  model         TEXT,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_workflow_id CHECK (
    workflow_id IN ('spec_generation', 'pipeline_execution', 'memory_consolidation')
  ),
  CONSTRAINT chk_runtime CHECK (
    runtime IN ('native', 'claude', 'opencode', 'codex')
  )
);

-- Seed default rows (idempotent)
INSERT INTO workflow_configs (workflow_id, runtime, provider)
VALUES
  ('spec_generation',        'native', 'claude-cli'),
  ('pipeline_execution',     'claude', 'claude-cli'),
  ('memory_consolidation',   'native', 'claude-cli')
ON CONFLICT (workflow_id) DO NOTHING;
