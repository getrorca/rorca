# AGENTS.md — backend/src/db/migrations/

SQLite migration files. Run automatically at backend startup in alphabetical order.

## Migration Files

| File | What It Adds |
|------|-------------|
| `001_init.sql` | Core tables: `workspaces`, `direction_layers`, `pipeline_runs`, `story_results`, `wal_events` |
| `002_workspace_context.sql` | `workspace_context` table: schema snapshot, git memory, ingestion hashes |
| `003_spec_versions.sql` | `spec_versions` table: version tracking + approval workflow |
| `004_templates.sql` | `templates` table: reusable spec templates with story structure |
| `005_model_selection.sql` | `preferred_model` column on `direction_layers` (L3 only) |
| `006_retry_support.sql` | `branch_name` + `worktree_path` columns on `pipeline_runs` |

## Rules

1. **Always use `IF NOT EXISTS`** for new tables
2. **`ALTER TABLE ADD COLUMN`** is handled with try/catch in `index.ts` — if the column already exists SQLite throws "duplicate column name", which is caught and ignored
3. **Number files sequentially**: `007_feature_name.sql`, `008_next.sql`
4. **No rollbacks**: SQLite DDL is not transactional. Plan schema before adding.
5. **No foreign key drops**: Removing FK constraints in SQLite requires table recreation — avoid if possible.

## Template for New Migration

```sql
-- 007_my_feature.sql
-- Brief description of what this adds

CREATE TABLE IF NOT EXISTS my_new_table (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Add column to existing table (try/catch in index.ts handles "duplicate column" error)
ALTER TABLE pipeline_runs ADD COLUMN my_new_col TEXT;
```

## Current Schema Quick Reference

```sql
workspaces(id, label, path, domains, created_at)
direction_layers(id, layer, workspace_id, domain, content_yaml, preferred_model, updated_at)
pipeline_runs(id, spec_path, workspace_id, status, pid, branch_name, worktree_path, started_at, finished_at)
story_results(id, run_id, story_id, status, retries, log_path, created_at)
wal_events(id, ts, event_type, workspace_id, spec_id, story_id, actor, payload)
workspace_context(id, workspace_id, schema_snapshot, git_memory, schema_hash, git_hash, updated_at)
spec_versions(id, spec_slug, version, content_json, status, rejection_reason, created_at)
templates(id, name, description, source_spec_id, brief, story_structure, direction_layers, story_count, created_at)
```
