-- 20260627120000_workspace_hydration.sql — Hilo workspace hydration status (Context Intelligence Platform US-003).
--
-- Tracks each Hilo-backed hydration of a workspace checkout: its status, the git SHA it ran
-- against (freshness key), the rebuildable graph output location, normalized counts, runtime,
-- staleness, and structured errors. See docs/context-intelligence-platform.md §2.1 / §3 / §6.
--
-- Source-of-truth note (§3): the Hilo graph itself is rebuildable and is NOT durable truth — this
-- table only records the *status/provenance* of hydration so a stale graph is detectable (US-009)
-- and re-buildable. It is append-per-attempt; "latest status" is the most recent row per workspace.
--
-- pgboss.* tables are NOT touched by this migration (and must never be — see AGENTS.md).

CREATE TABLE IF NOT EXISTS workspace_hydration (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'hilo',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'stale', 'cancelled')),
  -- Commit the hydration ran against; hydration freshness is keyed to this SHA (US-003/US-009).
  git_sha TEXT,
  -- Location of the rebuildable graph output (rebuildable artifact, not durable truth).
  graph_path TEXT,
  -- Normalized counts produced by graph normalization (US-008): file nodes, imports,
  -- reverse importers, tests/tested_by, roles, relation counts, etc.
  counts_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms BIGINT CHECK (duration_ms IS NULL OR duration_ms >= 0),
  -- Why the hydration is considered stale (e.g. 'git_sha_changed'); set when status = 'stale'.
  stale_reason TEXT,
  -- Structured error payload when status = 'failed'.
  error_json JSONB,
  -- Provider/normalization version, config echo, and other observability metadata (US-038).
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Latest-status lookups per workspace ("what is this workspace's current hydration state?").
CREATE INDEX IF NOT EXISTS idx_workspace_hydration_workspace_created
  ON workspace_hydration (workspace_id, created_at DESC);

-- Latest hydration of a given status per workspace (e.g. latest 'succeeded' for freshness).
CREATE INDEX IF NOT EXISTS idx_workspace_hydration_workspace_status
  ON workspace_hydration (workspace_id, status, created_at DESC);

-- Freshness checks: is there a hydration for the current git SHA? (US-009)
CREATE INDEX IF NOT EXISTS idx_workspace_hydration_workspace_sha
  ON workspace_hydration (workspace_id, git_sha);

-- Observability of in-flight hydration across all workspaces (US-011/US-012/US-038).
CREATE INDEX IF NOT EXISTS idx_workspace_hydration_active
  ON workspace_hydration (status, created_at DESC)
  WHERE status IN ('pending', 'running');
