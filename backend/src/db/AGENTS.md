# AGENTS.md — backend/src/db/

SQLite database layer. `better-sqlite3` — fully synchronous. Never use async/await for DB calls.

## index.ts

Opens `DB_PATH` (env var or `./rorca.db`). On startup:
- Enables WAL mode: `PRAGMA journal_mode = WAL`
- Enables foreign keys: `PRAGMA foreign_keys = ON`
- Runs all `.sql` files in `migrations/` (alphabetical order, auto-idempotent via `IF NOT EXISTS`)

```typescript
import { db } from '../db/index';

// Single row — returns T | undefined
const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;

// Multiple rows — returns T[]
const rows = db.prepare('SELECT * FROM pipeline_runs ORDER BY id DESC').all() as PipelineRunRow[];

// Write — returns RunResult
const result = db.prepare('INSERT INTO ...').run(val1, val2);
const newId = result.lastInsertRowid; // bigint
```

## Table Reference

| Table | Primary Key | Description |
|-------|------------|-------------|
| `workspaces` | `id` INTEGER | Registered project repos. `path` = absolute filesystem path. |
| `direction_layers` | `id` INTEGER | L1–L3 YAML content. One row per `(layer, workspace_id, domain)`. |
| `pipeline_runs` | `id` INTEGER | Execution engine runs. `pid`, `status`, `branch_name`, `worktree_path`. |
| `story_results` | `id` INTEGER | Per-story pass/fail/skip per run. `run_id` FK → `pipeline_runs`. |
| `wal_events` | `id` INTEGER | Audit log + SSE feed. `event_type`, `workspace_id`, `spec_id`, `payload` JSON. |
| `workspace_context` | `id` INTEGER | Hydrated schema snapshot + git memory YAML. One row per workspace. |
| `spec_versions` | `id` INTEGER | Version history for specs. `status`: pending/approved/rejected. |
| `templates` | `id` INTEGER | Reusable spec templates. Snapshot of `story_structure` JSON + direction layers. |

## Key Column Details

### workspaces
- `path`: absolute path e.g. `/Users/dimitriteravanessian/Cashflow-App`. Backend uses this as the working directory for `execution-engine.ts` and to resolve spec file paths.
- `domains`: JSON array of domain strings e.g. `["fintech", "saas"]`

### direction_layers
- `layer`: 1 (global brain), 2 (domain profile), 3 (project brief)
- `content_yaml`: raw YAML string — the Direction Stack content
- `preferred_model`: only set on L3 rows. Used to override default model per workspace.
- `domain`: only meaningful for L2 (domain filter)

### pipeline_runs
- `status`: `running` | `paused` | `done` | `failed`
- `pid`: OS process ID of spawned bash process
- `branch_name`: git branch if `autoWorktree=true`, else NULL
- `worktree_path`: absolute path to worktree directory if `autoWorktree=true`, else NULL
- **Stale runs**: if backend restarts, `status='running'` rows with dead PIDs linger. Fix:
  ```sql
  UPDATE pipeline_runs SET status='failed', finished_at=datetime('now') WHERE status='running';
  ```

### story_results
- `status`: `pass` | `fail` | `skip` | `retry`
- `retries`: integer count (0 = first attempt)
- `log_path`: path to story log file in workspace `scripts/ralph/logs/`

### wal_events
- `event_type`: `workspace_create` | `direction_upsert` | `spec_generate` | `spec_approve` | `spec_reject` | `run_started` | `run_finished` | `story_started` | `story_passed` | `story_failed` | `story_skipped` | `run_blocked` | `context_file_changed` | `story_escalated` | `worktree_created` | `worktree_merged`
- `payload`: JSON object. Shape varies by event_type.

### spec_versions
- `status`: `pending` | `approved` | `rejected`
- `rejection_reason`: text, only set when `status='rejected'`
- `version`: integer, auto-incremented per slug

## Adding a Migration

1. Create `backend/src/db/migrations/039_my_feature.sql` (migrations 001–038 already exist — use next available number)
2. Use `IF NOT EXISTS` / `IF NOT EXISTS column` for idempotency:
   ```sql
   -- New table
   CREATE TABLE IF NOT EXISTS my_table (...);

   -- New column (SQLite ALTER TABLE ADD COLUMN is idempotent via error handling in index.ts)
   ALTER TABLE existing_table ADD COLUMN new_col TEXT;
   ```
3. The migration runs automatically on next backend start.
4. **No rollbacks** — SQLite doesn't support transactional DDL for DROP. Plan schema before adding.

## Common Mistakes

- **`await db.prepare(...).get()`**: `better-sqlite3` is synchronous. The `await` silently wraps a non-Promise value — you won't get an error, but you'll get undefined. **Remove all `await` from DB calls.**
- **Missing workspace filter**: Any data query scoped to a workspace must include `WHERE workspace_id = ?`. WAL events, spec_versions, pipeline_runs — all workspace-scoped.
- **`lastInsertRowid` is bigint**: Cast to number with `Number(result.lastInsertRowid)` before storing in JSON responses.
- **Concurrent writes**: SQLite WAL allows many readers, one writer. Don't hold a transaction open during LLM calls.
