-- 20260628000000_retrieval_traces.sql — Retrieval trace persistence (Context Intelligence Platform US-018).
--
-- Stores replayable retrieval traces for debugging and quality evaluation.
-- Each trace records the query/brief, graph freshness, candidate counts, selected items,
-- score breakdowns, token estimates, and degradation flags — per the retrievalTrace
-- shared contract (shared/contracts/retrieval.ts).
--
-- The trace payload is stored as JSONB so it can be indexed/queried for offline analysis.
-- Sensitive values (large raw content) are redacted before persistence by retrieval-trace.ts.
--
-- pgboss.* tables are NOT touched by this migration (and must never be — see AGENTS.md).

CREATE TABLE IF NOT EXISTS retrieval_traces (
  trace_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brief_hash TEXT NOT NULL,
  git_sha TEXT,
  policy TEXT,
  graph_mode TEXT CHECK (graph_mode IN ('full', 'lite', 'disabled')),
  degraded BOOLEAN DEFAULT false,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  selected_count INTEGER NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  token_estimate INTEGER CHECK (token_estimate IS NULL OR token_estimate >= 0),
  -- The full redacted trace payload per the retrievalTrace contract.
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup traces by workspace, most recent first (operator dashboard).
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_workspace_created
  ON retrieval_traces (workspace_id, created_at DESC);

-- Lookup traces by brief hash (cache/replay key for replaying retrievals).
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_brief_hash
  ON retrieval_traces (brief_hash, created_at DESC);

-- Lookup traces by graph mode for degradation analysis.
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_graph_mode
  ON retrieval_traces (graph_mode, created_at DESC)
  WHERE graph_mode IS NOT NULL;

-- Link retrieval traces to spec generation logs for audit/debugging.
-- The spec_generation_logs table gets a retrieval_trace_ids column (text[]) so one log can
-- reference multiple traces (e.g. enrichment + ranking passes).
ALTER TABLE spec_generation_logs
  ADD COLUMN IF NOT EXISTS retrieval_trace_ids TEXT[]
    DEFAULT '{}'::TEXT[];
