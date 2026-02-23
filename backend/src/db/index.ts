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
