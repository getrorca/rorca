-- 20260810140000_run_findings.sql
-- US-009: Run findings feed-forward (Rorca operational authority).
--
-- A completed run emits a structured findings record (decisions made,
-- deviations from spec, discovered risks, new conventions) derived
-- deterministically from the same persisted evidence the story-result
-- derivation uses. Findings are CAPTURE CANDIDATES: they feed the existing
-- run memory synthesis path (so they surface in L2/L3/MEMORY.md on the next
-- run) and are visible for explicit Genesis capture, but nothing auto-promotes
-- them. `status` stays 'capture_candidate' until an explicit operator action
-- captures or dismisses the finding; this migration creates no promotion
-- surface and no trigger that writes anywhere else.

CREATE TABLE IF NOT EXISTS run_findings (
  id SERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  finding_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'deviation', 'risk', 'convention')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  status TEXT NOT NULL DEFAULT 'capture_candidate'
    CHECK (status IN ('capture_candidate', 'captured', 'dismissed')),
  captured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, finding_key),
  CHECK (status <> 'captured' OR captured_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_run_findings_workspace
  ON run_findings (workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_run_findings_run
  ON run_findings (run_id);
