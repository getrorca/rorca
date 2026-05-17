-- Durable retrieval telemetry for operator analytics and offline GraphRAG tuning.
-- Keeps a lightweight event log of ranking decisions while retrieval_feedback stores
-- longer-lived candidate usefulness/outcome signals.

CREATE TABLE IF NOT EXISTS retrieval_telemetry_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query_preview TEXT NOT NULL,
  matched_skills JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_candidate_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  dropped_candidate_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  needs_more_evidence BOOLEAN NOT NULL DEFAULT false,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  token_budget INTEGER NOT NULL DEFAULT 0 CHECK (token_budget >= 0),
  contradiction_count INTEGER NOT NULL DEFAULT 0 CHECK (contradiction_count >= 0),
  contradiction_pairs JSONB NOT NULL DEFAULT '[]'::jsonb,
  retrieval_tier TEXT CHECK (retrieval_tier IN ('cache', 'search', 'hybrid')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retrieval_telemetry_events_workspace_created
  ON retrieval_telemetry_events (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_telemetry_events_created
  ON retrieval_telemetry_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_retrieval_telemetry_events_workspace_tier
  ON retrieval_telemetry_events (workspace_id, retrieval_tier, created_at DESC);
