-- 20260811090000_memory_workspace_shares.sql — Cross-workspace memory sharing
--
-- A memory may be shared into additional workspaces so platform knowledge
-- posted from one workspace (e.g. rorca-universal-assurance) is retrievable
-- from the canonical rorca workspace (and any other linked workspace) without
-- duplicating rows. Sharing is additive visibility: the owning workspace
-- remains the authoritative source; retrieval unions the shares.

CREATE TABLE IF NOT EXISTS rorca.memory_workspace_shares (
  memory_id BIGINT NOT NULL REFERENCES rorca.memories(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES rorca.workspaces(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (memory_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS memory_workspace_shares_workspace_idx
  ON rorca.memory_workspace_shares(workspace_id);

DO $$
DECLARE runtime_user TEXT := current_setting('rorca.runtime_database_user',TRUE);
BEGIN
  IF runtime_user IS NULL OR runtime_user='' THEN RAISE EXCEPTION 'rorca.runtime_database_user must identify the runtime principal'; END IF;
  EXECUTE format('GRANT SELECT,INSERT,DELETE ON rorca.memory_workspace_shares TO %I',runtime_user);
END $$;
