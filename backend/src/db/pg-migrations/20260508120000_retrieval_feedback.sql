-- Retrieval feedback and learning loop state for GraphRAG ranking.
-- Stores lightweight usefulness signals for retrieval candidates so repeated
-- successful use can influence future ranking decisions.

CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  candidate_key TEXT NOT NULL,
  candidate_kind TEXT NOT NULL,
  skill_name TEXT NOT NULL DEFAULT '',
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  observation_count INTEGER NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  usefulness_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, candidate_key, candidate_kind, skill_name)
);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_workspace_candidate
  ON retrieval_feedback (workspace_id, candidate_key);

CREATE INDEX IF NOT EXISTS idx_retrieval_feedback_workspace_usefulness
  ON retrieval_feedback (workspace_id, usefulness_score DESC, last_seen_at DESC);
