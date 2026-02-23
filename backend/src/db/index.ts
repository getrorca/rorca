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
}

runMigrations();
