import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DB_PATH || './rorca.db';
export const db: DatabaseType = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function runMigrations() {
  // Migrations are .sql files in src/db/migrations/ — resolve for both dev (tsx) and compiled (dist/) modes
  let migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    // Running from compiled backend/dist/db/ — look at source directory
    migrationsDir = path.join(__dirname, '..', '..', 'src', 'db', 'migrations');
  }
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    db.exec(sql);
  }

  // US-003: Add preferred_model column idempotently (SQLite lacks ADD COLUMN IF NOT EXISTS)
  const cols = db.pragma('table_info(direction_layers)') as { name: string }[];
  if (!cols.some(c => c.name === 'preferred_model')) {
    db.exec('ALTER TABLE direction_layers ADD COLUMN preferred_model TEXT');
  }

  // 006: Add branch_name + worktree_path to pipeline_runs (idempotent)
  const runCols = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runCols.some(c => c.name === 'branch_name')) {
    db.exec('ALTER TABLE pipeline_runs ADD COLUMN branch_name TEXT');
  }
  if (!runCols.some(c => c.name === 'worktree_path')) {
    db.exec('ALTER TABLE pipeline_runs ADD COLUMN worktree_path TEXT');
  }

  // US-005: FTS5 virtual table for full-text spec search
  const ftsExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='spec_search_index'`
  ).get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE spec_search_index USING fts5(
        spec_slug UNINDEXED,
        workspace_id UNINDEXED,
        spec_title,
        story_titles,
        story_descriptions,
        acceptance_criteria,
        status UNINDEXED,
        generated_at UNINDEXED,
        tokenize='unicode61'
      )
    `);
  }

  // V2-002: Add revoked_at column to refresh_tokens (idempotent)
  const rtCols = db.pragma('table_info(refresh_tokens)') as { name: string }[];
  if (!rtCols.some(c => c.name === 'revoked_at')) {
    db.exec('ALTER TABLE refresh_tokens ADD COLUMN revoked_at TEXT');
  }

  // V2-003: Add github_id column to users for account linking (idempotent)
  const userCols = db.pragma('table_info(users)') as { name: string }[];
  if (!userCols.some(c => c.name === 'github_id')) {
    db.exec('ALTER TABLE users ADD COLUMN github_id TEXT');
  }

  // V2-004: Add role column to users (idempotent)
  const userColsV2004 = db.pragma('table_info(users)') as { name: string }[];
  if (!userColsV2004.some(c => c.name === 'role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }

  // V2-005: Add avatar_url column to users (idempotent)
  const userColsV2005 = db.pragma('table_info(users)') as { name: string }[];
  if (!userColsV2005.some(c => c.name === 'avatar_url')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  }

  // V2-110: Add email_verified_at column to users (idempotent)
  const userColsV2110 = db.pragma('table_info(users)') as { name: string }[];
  if (!userColsV2110.some(c => c.name === 'email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  }

  // V2-111: Add plan column to users (idempotent)
  const userColsV2111 = db.pragma('table_info(users)') as { name: string }[];
  if (!userColsV2111.some(c => c.name === 'plan')) {
    db.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'");
  }

  // V2-017: Add 'timeout' to story_results status CHECK + elapsed_seconds column (idempotent)
  const storyResultsSql = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='story_results'`
  ).get() as { sql: string } | undefined)?.sql || '';
  if (!storyResultsSql.includes('timeout')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE story_results_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
        story_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pass','fail','skip','retry','timeout')),
        retries INTEGER NOT NULL DEFAULT 0,
        log_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        elapsed_seconds INTEGER
      );
      INSERT INTO story_results_new (id, run_id, story_id, status, retries, log_path, started_at, finished_at)
        SELECT id, run_id, story_id, status, retries, log_path, started_at, finished_at FROM story_results;
      DROP TABLE story_results;
      ALTER TABLE story_results_new RENAME TO story_results;
    `);
    db.pragma('foreign_keys = ON');
  }

  // Also add elapsed_seconds if story_results exists but without it (edge case: table was already recreated above)
  const srCols = db.pragma('table_info(story_results)') as { name: string }[];
  if (!srCols.some(c => c.name === 'elapsed_seconds')) {
    db.exec('ALTER TABLE story_results ADD COLUMN elapsed_seconds INTEGER');
  }

  // V2-025: Add input_tokens and output_tokens columns to story_results (idempotent)
  const srColsV2025 = db.pragma('table_info(story_results)') as { name: string }[];
  if (!srColsV2025.some(c => c.name === 'input_tokens')) {
    db.exec('ALTER TABLE story_results ADD COLUMN input_tokens INTEGER');
  }
  if (!srColsV2025.some(c => c.name === 'output_tokens')) {
    db.exec('ALTER TABLE story_results ADD COLUMN output_tokens INTEGER');
  }

  // V2-083: Add 'excluded' to story_results status CHECK (idempotent)
  const storyResultsSqlExcl = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='story_results'`
  ).get() as { sql: string } | undefined)?.sql || '';
  if (!storyResultsSqlExcl.includes('excluded')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE story_results_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES pipeline_runs(id),
        story_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pass','fail','skip','retry','timeout','excluded')),
        retries INTEGER NOT NULL DEFAULT 0,
        log_path TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        elapsed_seconds INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER
      );
      INSERT INTO story_results_new (id, run_id, story_id, status, retries, log_path, started_at, finished_at, elapsed_seconds, input_tokens, output_tokens)
        SELECT id, run_id, story_id, status, retries, log_path, started_at, finished_at, elapsed_seconds, input_tokens, output_tokens FROM story_results;
      DROP TABLE story_results;
      ALTER TABLE story_results_new RENAME TO story_results;
    `);
    db.pragma('foreign_keys = ON');
  }

  // V2-020: Add trigger_type column to pipeline_runs (idempotent)
  const runColsV2020 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsV2020.some(c => c.name === 'trigger_type')) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'");
  }

  // US-004: Add 'partial_failure' to pipeline_runs status CHECK constraint (idempotent)
  const tableSql = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_runs'`
  ).get() as { sql: string } | undefined)?.sql || '';
  if (!tableSql.includes('partial_failure')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE pipeline_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_path TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        status TEXT NOT NULL CHECK(status IN ('running','paused','done','failed','partial_failure')),
        pid INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        branch_name TEXT,
        worktree_path TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'manual'
      );
      INSERT INTO pipeline_runs_new SELECT id, spec_path, workspace_id, status, pid, started_at, finished_at, branch_name, worktree_path, COALESCE(trigger_type, 'manual') FROM pipeline_runs;
      DROP TABLE pipeline_runs;
      ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs;
    `);
    db.pragma('foreign_keys = ON');
  }

  // V2-101: Add 'cancelled' to pipeline_runs status CHECK constraint (idempotent)
  const tableSqlV101 = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='pipeline_runs'`
  ).get() as { sql: string } | undefined)?.sql || '';
  if (!tableSqlV101.includes('cancelled')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE pipeline_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        spec_path TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        status TEXT NOT NULL CHECK(status IN ('running','paused','done','failed','partial_failure','cancelled')),
        pid INTEGER,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        branch_name TEXT,
        worktree_path TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'manual'
      );
      INSERT INTO pipeline_runs_new SELECT id, spec_path, workspace_id, status, pid, started_at, finished_at, branch_name, worktree_path, trigger_type FROM pipeline_runs;
      DROP TABLE pipeline_runs;
      ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs;
    `);
    db.pragma('foreign_keys = ON');

    // Re-add columns that were added after the initial table definition
    const colsAfterRebuild = db.pragma('table_info(pipeline_runs)') as { name: string }[];
    if (!colsAfterRebuild.some(c => c.name === 'retried_from_run_id')) {
      db.exec('ALTER TABLE pipeline_runs ADD COLUMN retried_from_run_id INTEGER REFERENCES pipeline_runs(id)');
    }
    if (!colsAfterRebuild.some(c => c.name === 'log_path')) {
      db.exec('ALTER TABLE pipeline_runs ADD COLUMN log_path TEXT');
    }
  }

  // V2-020: Ensure trigger_type exists after potential rebuild (idempotent)
  const runColsPost = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsPost.some(c => c.name === 'trigger_type')) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'");
  }

  // V2-078: Add retried_from_run_id column to pipeline_runs (idempotent)
  const runColsV2078 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsV2078.some(c => c.name === 'retried_from_run_id')) {
    db.exec('ALTER TABLE pipeline_runs ADD COLUMN retried_from_run_id INTEGER REFERENCES pipeline_runs(id)');
  }

  // V2-080: Add log_path column to pipeline_runs (idempotent)
  const runColsV2080 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsV2080.some(c => c.name === 'log_path')) {
    db.exec('ALTER TABLE pipeline_runs ADD COLUMN log_path TEXT');
  }

  // EQ-004: Add agent column to pipeline_runs (idempotent) — 'claude' | 'opencode'
  const runColsEQ004 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsEQ004.some(c => c.name === 'agent')) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
  }

  // V2-031: Add pr_template column to workspaces (idempotent)
  const wsCols = db.pragma('table_info(workspaces)') as { name: string }[];
  if (!wsCols.some(c => c.name === 'pr_template')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN pr_template TEXT');
  }

  // V2-086: Add pipeline_config column to workspaces (idempotent)
  const wsColsV86 = db.pragma('table_info(workspaces)') as { name: string }[];
  if (!wsColsV86.some(c => c.name === 'pipeline_config')) {
    db.exec("ALTER TABLE workspaces ADD COLUMN pipeline_config TEXT NOT NULL DEFAULT '{}'");
  }

  // V2-084: Add ROI calculator config columns to workspaces (idempotent)
  const wsColsROI = db.pragma('table_info(workspaces)') as { name: string }[];
  if (!wsColsROI.some(c => c.name === 'roi_hours_per_story')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN roi_hours_per_story REAL NOT NULL DEFAULT 4.0');
  }
  if (!wsColsROI.some(c => c.name === 'roi_hourly_rate')) {
    db.exec('ALTER TABLE workspaces ADD COLUMN roi_hourly_rate REAL NOT NULL DEFAULT 75.0');
  }

  // V2-035: Add last_active_at column to team_members (idempotent)
  const tmCols = db.pragma('table_info(team_members)') as { name: string }[];
  if (!tmCols.some(c => c.name === 'last_active_at')) {
    db.exec('ALTER TABLE team_members ADD COLUMN last_active_at TEXT');
  }

  // V2-041: Add team_id + author_id + usage_count to templates (idempotent)
  const tplCols = db.pragma('table_info(templates)') as { name: string }[];
  if (!tplCols.some(c => c.name === 'team_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN team_id TEXT REFERENCES teams(id) ON DELETE SET NULL');
  }
  if (!tplCols.some(c => c.name === 'author_id')) {
    db.exec('ALTER TABLE templates ADD COLUMN author_id TEXT REFERENCES users(id) ON DELETE SET NULL');
  }
  if (!tplCols.some(c => c.name === 'usage_count')) {
    db.exec('ALTER TABLE templates ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!tplCols.some(c => c.name === 'last_used_at')) {
    db.exec('ALTER TABLE templates ADD COLUMN last_used_at TEXT');
  }

  // V2-044: Enhance model_pricing with provider, per-1M costs, effective_date (idempotent)
  const mpCols = db.pragma('table_info(model_pricing)') as { name: string }[];
  if (!mpCols.some(c => c.name === 'provider')) {
    db.exec("ALTER TABLE model_pricing ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic'");
  }
  if (!mpCols.some(c => c.name === 'input_cost_per_1m')) {
    db.exec('ALTER TABLE model_pricing ADD COLUMN input_cost_per_1m REAL');
    // Backfill from existing per-1k values (multiply by 1000)
    db.exec('UPDATE model_pricing SET input_cost_per_1m = input_cost_per_1k * 1000 WHERE input_cost_per_1m IS NULL');
  }
  if (!mpCols.some(c => c.name === 'output_cost_per_1m')) {
    db.exec('ALTER TABLE model_pricing ADD COLUMN output_cost_per_1m REAL');
    db.exec('UPDATE model_pricing SET output_cost_per_1m = output_cost_per_1k * 1000 WHERE output_cost_per_1m IS NULL');
  }
  if (!mpCols.some(c => c.name === 'effective_date')) {
    db.exec("ALTER TABLE model_pricing ADD COLUMN effective_date TEXT DEFAULT ''");
    db.exec("UPDATE model_pricing SET effective_date = datetime('now') WHERE effective_date = ''");
  }

  // V2-115: Add base_url column to api_key_vault for OpenAI-compat configurable endpoints (idempotent)
  const vaultCols = db.pragma('table_info(api_key_vault)') as { name: string }[];
  if (!vaultCols.some(c => c.name === 'base_url')) {
    db.exec('ALTER TABLE api_key_vault ADD COLUMN base_url TEXT');
  }

  // EQ-009: Add parallelism column to pipeline_runs (integer, default 1)
  const runColsEQ009 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsEQ009.some(c => c.name === 'parallelism')) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN parallelism INTEGER NOT NULL DEFAULT 1");
  }

  // EQ-010: Add worktree_path and worktree_branch columns to story_results (idempotent)
  const srColsEQ010 = db.pragma('table_info(story_results)') as { name: string }[];
  if (!srColsEQ010.some(c => c.name === 'worktree_path')) {
    db.exec('ALTER TABLE story_results ADD COLUMN worktree_path TEXT');
  }
  if (!srColsEQ010.some(c => c.name === 'worktree_branch')) {
    db.exec('ALTER TABLE story_results ADD COLUMN worktree_branch TEXT');
  }

  // EQ-007: Add author_name column to story_comments for guest reviewers (idempotent)
  const scCols = db.pragma('table_info(story_comments)') as { name: string }[];
  if (!scCols.some(c => c.name === 'author_name')) {
    db.exec('ALTER TABLE story_comments ADD COLUMN author_name TEXT');
  }

  // EQ-007: Make user_id nullable for guest comments (story_comments was NOT NULL)
  // SQLite doesn't allow ALTER COLUMN, but new rows can insert NULL via the review route
  // because the NOT NULL constraint applies at INSERT time and we handle it in code.
  // We need to rebuild the table to allow NULL user_id.
  const scSql = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='story_comments'`
  ).get() as { sql: string } | undefined)?.sql || '';
  if (scSql.includes('user_id TEXT NOT NULL')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE story_comments_new (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL,
        story_id TEXT NOT NULL,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        author_name TEXT
      );
      INSERT INTO story_comments_new (id, spec_id, story_id, user_id, body, created_at, resolved_at, author_name)
        SELECT id, spec_id, story_id, user_id, body, created_at, resolved_at, author_name FROM story_comments;
      DROP TABLE story_comments;
      ALTER TABLE story_comments_new RENAME TO story_comments;
      CREATE INDEX IF NOT EXISTS idx_story_comments_spec_story ON story_comments(spec_id, story_id);
    `);
    db.pragma('foreign_keys = ON');
  }

  // UI-031: Add auto-PR settings columns to workspace_github_webhooks (idempotent)
  const ghCols = db.pragma('table_info(workspace_github_webhooks)') as { name: string }[];
  if (!ghCols.some(c => c.name === 'auto_pr_enabled')) {
    db.exec("ALTER TABLE workspace_github_webhooks ADD COLUMN auto_pr_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!ghCols.some(c => c.name === 'auto_pr_target_branch')) {
    db.exec("ALTER TABLE workspace_github_webhooks ADD COLUMN auto_pr_target_branch TEXT NOT NULL DEFAULT 'main'");
  }
  if (!ghCols.some(c => c.name === 'auto_pr_reviewers')) {
    db.exec("ALTER TABLE workspace_github_webhooks ADD COLUMN auto_pr_reviewers TEXT NOT NULL DEFAULT '[]'");
  }

  // EQ-012: Add default_parallelism column to workspaces (integer 1-10, default 1)
  const wsColsEQ012 = db.pragma('table_info(workspaces)') as { name: string }[];
  if (!wsColsEQ012.some(c => c.name === 'default_parallelism')) {
    db.exec("ALTER TABLE workspaces ADD COLUMN default_parallelism INTEGER NOT NULL DEFAULT 1");
  }

  // RQ-001: Create run_queue table (idempotent)
  const rqExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='run_queue'`
  ).get();
  if (!rqExists) {
    db.exec(`
      CREATE TABLE run_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
        spec_id TEXT NOT NULL,
        spec_path TEXT NOT NULL,
        parallelism INTEGER NOT NULL DEFAULT 1,
        auto_worktree INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        triggered_at TEXT
      );
      CREATE INDEX idx_run_queue_workspace_status ON run_queue(workspace_id, status);
    `);
  }

  // RQ-002: Add error_message column to run_queue (idempotent)
  const rqCols = db.pragma('table_info(run_queue)') as { name: string }[];
  if (rqCols.length > 0 && !rqCols.some(c => c.name === 'error_message')) {
    db.exec("ALTER TABLE run_queue ADD COLUMN error_message TEXT");
  }

  // OC-003: Add opencode_server_pid column to pipeline_runs (idempotent)
  const runColsOC003 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsOC003.some(c => c.name === 'opencode_server_pid')) {
    db.exec('ALTER TABLE pipeline_runs ADD COLUMN opencode_server_pid INTEGER');
  }

  // OC-006: Add agent_model column to pipeline_runs (idempotent)
  const runColsOC006 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsOC006.some(c => c.name === 'agent_model')) {
    db.exec('ALTER TABLE pipeline_runs ADD COLUMN agent_model TEXT');
  }

  // OC-007: Add agent_type column to pipeline_runs (idempotent)
  // Canonical column for agent type ('claude' | 'opencode'). Supersedes the earlier 'agent' column (EQ-004).
  const runColsOC007 = db.pragma('table_info(pipeline_runs)') as { name: string }[];
  if (!runColsOC007.some(c => c.name === 'agent_type')) {
    db.exec("ALTER TABLE pipeline_runs ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'");
    // Backfill from existing 'agent' column so historical rows stay consistent
    db.exec("UPDATE pipeline_runs SET agent_type = agent WHERE agent IS NOT NULL AND agent != ''");
  }

  // OC-009: agent_config table for persisting execution engine settings (hot-reloadable)
  const agentConfigExists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='agent_config'`
  ).get();
  if (!agentConfigExists) {
    db.exec(`
      CREATE TABLE agent_config (
        id TEXT PRIMARY KEY,
        agent_type TEXT NOT NULL DEFAULT 'claude',
        agent_model TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }
}

runMigrations();
