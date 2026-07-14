-- Migration: 20260713170000_gitreins_evidence
-- Purpose: Append-only, workspace-scoped GitReins execution-gate evidence.
-- Public API is read-only; only the canonical engine/store inserts rows.

CREATE TABLE IF NOT EXISTS gitreins_evidence (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id BIGINT NOT NULL,
  story_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('observe', 'enforce')),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error')),
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    'pass', 'judge_failed', 'missing_config', 'missing_binary', 'timeout',
    'output_limit', 'invalid_evidence', 'exit_mismatch', 'evidence_store_failed'
  )),
  schema_version TEXT NOT NULL DEFAULT '1.0',
  command TEXT NOT NULL DEFAULT 'judge' CHECK (command = 'judge'),
  scope TEXT NOT NULL DEFAULT 'working-tree' CHECK (scope = 'working-tree'),
  worktree BOOLEAN NOT NULL DEFAULT false,
  duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  evidence JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gitreins_evidence_workspace_created
  ON gitreins_evidence(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gitreins_evidence_run_story
  ON gitreins_evidence(run_id, story_id, attempt DESC, id DESC);

CREATE OR REPLACE FUNCTION reject_gitreins_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'gitreins_evidence is append-only; % is not permitted', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE TRIGGER gitreins_evidence_append_only
BEFORE UPDATE OR DELETE ON gitreins_evidence
FOR EACH ROW EXECUTE FUNCTION reject_gitreins_evidence_mutation();

CREATE OR REPLACE TRIGGER gitreins_evidence_no_truncate
BEFORE TRUNCATE ON gitreins_evidence
FOR EACH STATEMENT EXECUTE FUNCTION reject_gitreins_evidence_mutation();

COMMENT ON TABLE gitreins_evidence IS
  'Append-only GitReins v1 evidence emitted by the canonical execution engine; no public mutation API.';
