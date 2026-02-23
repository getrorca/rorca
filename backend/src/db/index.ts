import Database, { Database as DatabaseType } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const DB_PATH = process.env.DB_PATH || './rorcha.db';
export const db: DatabaseType = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
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
        worktree_path TEXT
      );
      INSERT INTO pipeline_runs_new SELECT id, spec_path, workspace_id, status, pid, started_at, finished_at, branch_name, worktree_path FROM pipeline_runs;
      DROP TABLE pipeline_runs;
      ALTER TABLE pipeline_runs_new RENAME TO pipeline_runs;
    `);
    db.pragma('foreign_keys = ON');
  }
}

runMigrations();
