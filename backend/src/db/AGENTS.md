# AGENTS.md — backend/src/db/

PostgreSQL database layer. `pg` Pool — fully async. Always use `await` for DB calls.

## index.ts

Connects via `DATABASE_URL` env var (or individual `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`). On startup:
- Creates a connection pool (max 20, idle timeout 30s)
- Runs all `.sql` files in `pg-migrations/` (tracked in `schema_migrations` table)

```typescript
import { query, queryOne, execute, transaction } from '../db/index';

// Single row — returns T | undefined
const row = await queryOne<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);

// Multiple rows — returns T[]
const rows = await query<PipelineRunRow>('SELECT * FROM pipeline_runs ORDER BY id DESC');

// Write — returns { rowCount: number }
const result = await execute('INSERT INTO ...', [val1, val2]);

// Transaction
const result = await transaction(async (client) => {
  await client.query('INSERT INTO ...', [val1]);
  await client.query('UPDATE ...', [val2]);
  return 'done';
});
```

## Table Reference

| Table | Primary Key | Description |
|-------|------------|-------------|
| `workspaces` | `id` TEXT | Registered project repos. `path` = absolute filesystem path. |
| `direction_layers` | `id` SERIAL | L1–L3 YAML content. One row per `(layer, workspace_id, domain)`. |
| `pipeline_runs` | `id` SERIAL | Execution engine runs. `pid`, `status`, `branch_name`, `worktree_path`. |
| `story_results` | `id` SERIAL | Per-story pass/fail/skip per run. `run_id` FK → `pipeline_runs`. |
| `wal_events` | `id` SERIAL | Audit log + SSE feed. `event_type`, `workspace_id`, `spec_id`, `payload` JSONB. |
| `workspace_context` | `id` SERIAL | Hydrated schema snapshot + git memory YAML. One row per workspace. |
| `spec_versions` | `id` SERIAL | Version history for specs. `status`: pending/approved/rejected. |
| `templates` | `id` SERIAL | Reusable spec templates. Snapshot of `story_structure` JSON + direction layers. |

## Adding a Migration

1. Create `backend/src/db/pg-migrations/050_my_feature.sql` (use next available number)
2. Wrap in transaction with version tracking:
   ```sql
   BEGIN;
   CREATE TABLE IF NOT EXISTS my_table (...);
   INSERT INTO schema_migrations (version, filename) VALUES (50, '050_my_feature.sql');
   COMMIT;
   ```
3. The migration runs automatically on next backend start.

## Common Mistakes

- **Missing `await` on DB calls**: All pg queries are async. Forgetting `await` returns a pending Promise — you'll get `[object Promise]` instead of data.
- **Using `?` placeholders**: PostgreSQL uses numbered placeholders (`$1`, `$2`, ...). Use the `rewritePlaceholders()` utility only during migration.
- **Missing workspace filter**: Any data query scoped to a workspace must include `WHERE workspace_id = $1`. WAL events, spec_versions, pipeline_runs — all workspace-scoped.
- **JSONB operators**: Use `->` for JSON object access, `->>` for text extraction, `@>` for containment. Not `json_extract()` (that's SQLite).
- **Connection pooling**: Don't hold a transaction open during LLM calls. Pool max is 20 — long transactions starve other requests.
