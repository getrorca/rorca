# Migration Rename Script

This script converts sequential migration filenames (001–078) to timestamp format (YYYYMMDDHHMMSS).

## Purpose

Rorca is migrating from sequential migration numbering to timestamp-based filenames for better multi-branch merge safety. Sequential numbering (001, 002, 003) causes conflicts when parallel branches independently create the same migration number. Timestamps guarantee uniqueness and preserve chronological order.

## Usage

```bash
# Dry-run: preview all changes without renaming
npx tsx backend/scripts/rename-migrations.ts --dry-run

# Actually rename files
npx tsx backend/scripts/rename-migrations.ts
```

## How It Works

### Phase 1: Git History Lookup
For each sequential migration file, the script queries git history to find the commit date of its first add (earliest appearance). This becomes the timestamp's basis.

```bash
git log --follow --format=%at --diff-filter=A -- <filepath>
```

**Fallback**: If git history is unavailable (untracked file), uses monotonically increasing timestamps starting from the maximum git-derived timestamp + 1.

### Phase 2: Timestamp Deduplication
Multiple migrations from the same commit (same git timestamp) must get unique ascending timestamps. The script increments by 1 second for each duplicate, ensuring strict monotonicity:

```
File A (committed at T): timestamp = T
File B (committed at T): timestamp = T + 1  (deduplicated)
File C (committed earlier): timestamp = T + 2  (git < previous, so incremented)
```

### Phase 3: Output Mapping
Prints a human-readable table:

```
Old Filename                                      New Filename
────────────────────────────────────────────────────────────
001_init.sql                                      20260313172226_init.sql
002_workspace_context.sql                         20260313172227_workspace_context.sql
...
```

And provides SQL UPDATE statements for the `schema_migrations` tracking table:

```sql
UPDATE schema_migrations SET filename = '20260313172226_init.sql' WHERE version = 1 AND filename = '001_init.sql';
UPDATE schema_migrations SET filename = '20260313172227_workspace_context.sql' WHERE version = 2 AND filename = '002_workspace_context.sql';
...
```

### Phase 4: File Rename (if not --dry-run)
Renames all files from old sequential format to new timestamp format.

## Acceptance Criteria

✅ **Sequential → Timestamp Format**
- All files matching `/^\d{3}_/` are renamed to `/^\d{14}_/`
- Description suffix is preserved: `001_initial_schema.sql` → `20260313172226_initial_schema.sql`

✅ **Strict Monotonic Ordering**
- Timestamps are strictly increasing: `20260313172226` < `20260313172227` < ... (no duplicates)
- Even when git timestamps are out of chronological order, assignments preserve numeric order
- Untracked files get fallback timestamps that maintain monotonicity relative to all previous assignments

✅ **Idempotent Behavior**
- Running the script once renames files
- Running again detects that all files are already in timestamp format and exits with message: `"No sequential migrations found to rename. All files are already in timestamp format or invalid."`
- No errors or re-renames on second run

✅ **Dry-Run Support**
- `--dry-run` flag prints mapping and SQL without renaming
- Clearly indicates dry-run mode at end of output
- Can be run multiple times safely

✅ **Already-Converted Files Untouched**
- Files already in timestamp format (`14_digit_prefix`) are skipped
- Can process mixed sequential + timestamp directories

✅ **Duplicate Numeric Prefixes Handled**
- Real-world case: two `069` files (collision from parallel branches)
- Both are processed: `069_add_source_to_memories.sql` and `069_workspace_context_hydrated_at.sql`
- Each gets unique timestamp while maintaining order: `20260313172294` and `20260313172295`

## Database Migration

**IMPORTANT**: Renaming files on disk is only half the solution. The `schema_migrations` table stores migration filenames as tracking keys. After running this script:

1. Run the provided SQL UPDATE statements to sync the database:
   ```bash
   psql $DATABASE_URL < /dev/stdin <<'EOF'
   BEGIN TRANSACTION;
   UPDATE schema_migrations SET filename = '20260313172226_init.sql' WHERE version = 1 AND filename = '001_init.sql';
   UPDATE schema_migrations SET filename = '20260313172227_workspace_context.sql' WHERE version = 2 AND filename = '002_workspace_context.sql';
   ... (all UPDATE statements from script output)
   COMMIT;
   EOF
   ```

2. Verify the migration runner (`backend/src/db/pg-index.ts`) correctly extracts version numbers from both sequential and timestamp filenames. Currently it uses `parseInt(match[1], 10)` which works for both formats (leading zeros are ignored).

**Schema Compatibility**: The `schema_migrations.version` column uses `INTEGER PRIMARY KEY` (32-bit). A 14-digit timestamp like `20260313172226` equals `20,260,313,172,226` which overflows 32-bit capacity. **This requires a migration to change `version INTEGER` to `version BIGINT`** before timestamps are applied, OR change the tracking strategy to store filenames directly (no numeric extraction). See migration 065 and beyond for how the timestamp-era schema should be structured.

## Implementation Details

### File Organization
- **Script**: `backend/scripts/rename-migrations.ts` (standalone, no external dependencies)
- **Tests**: `backend/scripts/__tests__/rename-migrations.test.ts` (Jest)
- **Node stdlib only**: Uses `fs`, `path`, `child_process` — no npm packages

### Performance
- O(n) where n = number of migration files (78 in current codebase)
- Git queries run serially per file (~500ms total for 78 files with git history)
- Actual renaming is instant (fs.renameSync)

### Error Handling
- Silently skips files not matching migration filename pattern
- Returns `null` for files with no git history (uses fallback monotonic timestamps)
- Throws on unexpected file system errors (e.g., permission denied)
- All errors printed to stderr with context

## Example Output (--dry-run)

```
================================================================================
MIGRATION RENAME MAPPING
================================================================================

Old Filename                                      New Filename
────────────────────────────────────────────────────────────
001_init.sql                                      20260313172226_init.sql
002_workspace_context.sql                         20260313172227_workspace_context.sql
...
078_worker_settings.sql                           20260313172304_worker_settings.sql

================================================================================
SCHEMA MIGRATIONS UPDATE STATEMENT
================================================================================

Run the following SQL to update the schema_migrations table:
(Only required if migrations have already been applied)

BEGIN TRANSACTION;
UPDATE schema_migrations SET filename = '20260313172226_init.sql' WHERE version = 1 AND filename = '001_init.sql';
UPDATE schema_migrations SET filename = '20260313172227_workspace_context.sql' WHERE version = 2 AND filename = '002_workspace_context.sql';
...
COMMIT;

🏁 DRY RUN — No files were renamed.
   Re-run without --dry-run to apply changes.

⚠️  IMPORTANT: Update your database!
    If migrations have already been applied, run the SQL UPDATE statements above.
    See backend/src/db/pg-index.ts for integration details.
```

## Testing

All 9 unit tests pass:
- ✅ Renames sequential files to timestamp format
- ✅ Ensures timestamps are strictly monotonically increasing
- ✅ Is idempotent (already-renamed files left untouched, second run is no-op)
- ✅ Handles duplicate numeric prefixes (two 069s)
- ✅ --dry-run flag prevents renaming
- ✅ No-op when all files are already converted
- ✅ Preserves description suffix
- ✅ Skips non-migration files
- ✅ Handles full range 001–078

Run tests:
```bash
cd backend
npm test -- --testPathPattern=rename-migrations
```
