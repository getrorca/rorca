-- MOG-004: Canonical memory-to-memory ontology relations.
-- Relational truth lives in Postgres first; AGE is only a derived projection.
-- Supported semantics:
--   SUPERSEDES     = directional replacement. The source memory replaces the target memory.
--   CONFLICTS_WITH = symmetric incompatibility. The pair is canonicalized to avoid duplicate rows.

CREATE TABLE IF NOT EXISTS memory_relations (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('SUPERSEDES', 'CONFLICTS_WITH')),
  canonical_key TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  restored_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  CHECK (source_memory_id <> target_memory_id),
  CHECK (
    (status = 'active' AND deleted_at IS NULL AND superseded_at IS NULL)
    OR (status = 'deleted' AND deleted_at IS NOT NULL)
    OR (status = 'superseded' AND superseded_at IS NOT NULL)
  ),
  UNIQUE (workspace_id, relation_type, source_memory_id, target_memory_id),
  UNIQUE (workspace_id, canonical_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_relations_workspace_status
  ON memory_relations (workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_relations_source
  ON memory_relations (workspace_id, source_memory_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_relations_target
  ON memory_relations (workspace_id, target_memory_id, updated_at DESC);
