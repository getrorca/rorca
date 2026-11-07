#!/usr/bin/env npx tsx
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

/**
 * migrate-sqlite-to-pg.ts — One-command SQLite → PostgreSQL migration for Rorca
 *
 * Usage:
 *   npx tsx backend/src/scripts/migrate-sqlite-to-pg.ts \
 *     --sqlite ./rorca.db \
 *     --pg postgres://rorca:rorca@localhost:5432/rorca
 *
 * Prerequisites:
 *   npm install better-sqlite3   (peer dependency, not in package.json)
 *
 * Behavior:
 *   - Migrates all tables in FK-safe order
 *   - Batches of 100 rows per transaction
 *   - ON CONFLICT DO NOTHING for idempotent re-runs
 *   - Per-row errors logged to migration-errors.log (don't halt migration)
 *   - Verification step compares row counts
 *   - Exit 0 on clean success, exit 1 on any errors
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  sqlitePath: string;
  pgUrl: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let sqlitePath = '';
  let pgUrl = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sqlite' && args[i + 1]) {
      sqlitePath = args[++i];
    } else if (args[i] === '--pg' && args[i + 1]) {
      pgUrl = args[++i];
    }
  }

  if (!sqlitePath || !pgUrl) {
    console.error(
      'Usage: npx tsx backend/src/scripts/migrate-sqlite-to-pg.ts --sqlite ./rorca.db --pg postgres://rorca:rorca@localhost:5432/rorca',
    );
    process.exit(1);
  }

  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite file not found: ${sqlitePath}`);
    process.exit(1);
  }

  return { sqlitePath, pgUrl };
}

// ---------------------------------------------------------------------------
// Error logging
// ---------------------------------------------------------------------------

const ERROR_LOG_PATH = path.resolve(process.cwd(), 'migration-errors.log');
let errorLogStream: fs.WriteStream;
let totalErrors = 0;

function initErrorLog(): void {
  errorLogStream = fs.createWriteStream(ERROR_LOG_PATH, { flags: 'w' });
  errorLogStream.write(`# Rorca SQLite→PG Migration Errors — ${new Date().toISOString()}\n\n`);
}

function logError(table: string, rowIdx: number, row: Record<string, unknown>, err: unknown): void {
  totalErrors++;
  const msg = err instanceof Error ? err.message : String(err);
  const line = `[${table}] row ${rowIdx}: ${msg}\n  data: ${JSON.stringify(row).slice(0, 500)}\n\n`;
  errorLogStream.write(line);
}

// ---------------------------------------------------------------------------
// Progress display
// ---------------------------------------------------------------------------

function printProgress(table: string, current: number, total: number, startMs: number): void {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const pct = total > 0 ? Math.round((current / total) * 100) : 100;
  const bar = '#'.repeat(Math.round(pct / 5)).padEnd(20, '-');
  process.stdout.write(`\r  [${bar}] ${table}: ${current}/${total} rows (${elapsed}s)`);
}

// ---------------------------------------------------------------------------
// Data transformation helpers
// ---------------------------------------------------------------------------

/** Parse SQLite 0/1 to boolean. Passes through actual booleans. */
function toBool(val: unknown): boolean | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'boolean') return val;
  if (val === 1 || val === '1' || val === 'true') return true;
  if (val === 0 || val === '0' || val === 'false') return false;
  return null;
}

/** Parse SQLite datetime string to ISO-8601 TIMESTAMPTZ. */
function toTimestamp(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') {
    // Unix epoch seconds
    return new Date(val * 1000).toISOString();
  }
  const s = String(val);
  // Already ISO-8601
  if (s.includes('T') || s.includes('+') || s.endsWith('Z')) return s;
  // SQLite "YYYY-MM-DD HH:MM:SS" format
  const d = new Date(s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse TEXT JSON column → JSONB-safe object. Returns null on failure. */
function toJsonb(val: unknown): unknown {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return val; // Already parsed
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return null; // Logged at call site
    }
  }
  return null;
}

/** Safe JSON stringify for JSONB columns. */
function _jsonbStr(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') {
    try {
      JSON.parse(val); // validate
      return val;
    } catch {
      return null;
    }
  }
  return JSON.stringify(val);
}

// ---------------------------------------------------------------------------
// Table migration definitions
// ---------------------------------------------------------------------------

/** Column type hints for transformation during migration. */
type ColType = 'text' | 'int' | 'real' | 'bool' | 'timestamp' | 'jsonb' | 'raw';

interface TableDef {
  /** Table name in both SQLite and PostgreSQL */
  name: string;
  /** SQLite table name if different from PG (e.g., renamed tables) */
  sqliteName?: string;
  /** Column type overrides for transformation. Unlisted columns pass through as-is. */
  colTypes?: Record<string, ColType>;
  /** Columns forming the unique constraint for ON CONFLICT DO NOTHING */
  conflictCols: string[];
  /** If true, use OVERRIDING SYSTEM VALUE for SERIAL PK */
  hasSerialPk?: boolean;
  /** Columns to skip during migration (e.g., generated columns like tsvector) */
  skipCols?: string[];
}

/**
 * Migration order respects FK constraints:
 * (1) workspaces
 * (2) users + teams
 * (3) direction_layers, spec-related
 * (4) pipeline_runs, story_results, etc.
 * (5) wal_events
 * (6) vault_keys (encrypted blobs)
 * (7) settings + billing + notifications
 * (8) skills + agent_hooks + agent_profiles
 */
const TABLE_DEFS: TableDef[] = [
  // ── Layer 1: Anchor tables (no FK deps) ──
  {
    name: 'workspaces',
    colTypes: {
      domains: 'text',
      pipeline_config: 'text',
      roi_hours_per_story: 'real',
      roi_hourly_rate: 'real',
      default_parallelism: 'int',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'users',
    colTypes: {
      email_verified_at: 'timestamp',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'model_pricing',
    colTypes: {
      input_cost_per_1k: 'real',
      output_cost_per_1k: 'real',
      input_cost_per_1m: 'real',
      output_cost_per_1m: 'real',
      effective_date: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['model_id'],
  },
  {
    name: 'onboarding_state',
    colTypes: {
      current_step: 'int',
      direction_done: 'bool',
      completed: 'bool',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },

  // ── Layer 2: FK → workspaces or users ──
  {
    name: 'teams',
    colTypes: { created_at: 'timestamp' },
    conflictCols: ['id'],
  },
  {
    name: 'refresh_tokens',
    colTypes: {
      expires_at: 'timestamp',
      revoked_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'github_connections',
    colTypes: {
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'workspace_context',
    colTypes: {
      schema_snapshot_at: 'timestamp',
      schema_table_count: 'int',
      git_memory_updated_at: 'timestamp',
      git_commit_count: 'int',
    },
    conflictCols: ['workspace_id'],
  },
  {
    name: 'workspace_env_vars',
    colTypes: {
      is_secret: 'bool',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'workspace_github_webhooks',
    colTypes: {
      webhook_id: 'int',
      last_webhook_at: 'timestamp',
      auto_pr_enabled: 'bool',
      auto_pr_reviewers: 'jsonb',
      created_at: 'timestamp',
    },
    conflictCols: ['workspace_id'],
  },
  {
    name: 'budget_config',
    colTypes: {
      alert_threshold_usd: 'real',
      hard_cap_usd: 'real',
      notify_emails: 'jsonb',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['workspace_id'],
    hasSerialPk: true,
  },
  {
    name: 'api_key_vault',
    colTypes: {
      spend_total_usd: 'real',
      last_used_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'integration_credentials',
    colTypes: {
      metadata: 'jsonb',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'user_settings',
    colTypes: {
      items_per_page: 'int',
      updated_at: 'timestamp',
    },
    conflictCols: ['user_id'],
  },
  {
    name: 'subscriptions',
    colTypes: {
      current_period_start: 'timestamp',
      current_period_end: 'timestamp',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'password_reset_tokens',
    colTypes: {
      expires_at: 'timestamp',
      created_at: 'timestamp',
      used_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'email_verification_tokens',
    colTypes: {
      expires_at: 'timestamp',
      created_at: 'timestamp',
      used_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'provider_defaults',
    colTypes: {
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },

  // ── Layer 3: FK → teams ──
  {
    name: 'team_members',
    colTypes: {
      invited_at: 'timestamp',
      accepted_at: 'timestamp',
      last_active_at: 'timestamp',
    },
    conflictCols: ['team_id', 'user_id'],
  },
  {
    name: 'workspace_access',
    colTypes: {},
    conflictCols: ['workspace_id', 'team_id'],
  },
  {
    name: 'team_invites',
    colTypes: {
      expires_at: 'timestamp',
      accepted_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },

  // ── Layer 4: direction_layers (FK → workspaces + teams) ──
  {
    name: 'direction_layers',
    colTypes: {
      layer: 'int',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },

  // ── Layer 5: templates (FK → users + teams) ──
  {
    name: 'templates',
    colTypes: {
      story_count: 'int',
      usage_count: 'int',
      last_used_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'template_ratings',
    colTypes: {
      rating: 'int',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
  },

  // ── Layer 6: spec_versions ──
  {
    name: 'spec_versions',
    colTypes: {
      version: 'int',
      content_json: 'jsonb',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },

  // ── Layer 7: pipeline_runs (FK → workspaces) ──
  {
    name: 'pipeline_runs',
    colTypes: {
      pid: 'int',
      started_at: 'timestamp',
      finished_at: 'timestamp',
      retried_from_run_id: 'int',
      opencode_server_pid: 'int',
      total_input_tokens: 'int',
      total_output_tokens: 'int',
      total_cost_usd: 'real',
      parallelism: 'int',
      queued_at: 'timestamp',
      queue_position: 'int',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },

  // ── Layer 8: FK → pipeline_runs ──
  {
    name: 'story_results',
    colTypes: {
      run_id: 'int',
      retries: 'int',
      started_at: 'timestamp',
      finished_at: 'timestamp',
      elapsed_seconds: 'int',
      input_tokens: 'int',
      output_tokens: 'int',
      cost_usd: 'real',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'token_usage',
    colTypes: {
      run_id: 'int',
      input_tokens: 'int',
      output_tokens: 'int',
      cost_usd: 'real',
      recorded_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'memory_proposals',
    colTypes: {
      run_id: 'int',
      proposed_at: 'timestamp',
      resolved_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },

  // ── Layer 9: misc FK → workspaces/users ──
  {
    name: 'spec_tags',
    colTypes: { created_at: 'timestamp' },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'kanban_columns',
    colTypes: {
      position: 'int',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'kanban_spec_assignments',
    colTypes: {
      column_id: 'int',
      assigned_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'pipeline_hooks',
    colTypes: {
      enabled: 'bool',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'pipeline_schedules',
    colTypes: {
      enabled: 'bool',
      last_triggered_at: 'timestamp',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'story_commits',
    colTypes: { pushed_at: 'timestamp' },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'story_comments',
    colTypes: {
      created_at: 'timestamp',
      resolved_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'spec_assignments',
    colTypes: { assigned_at: 'timestamp' },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'notifications',
    colTypes: {
      read_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'notification_preferences',
    colTypes: {
      in_app: 'bool',
      email: 'bool',
    },
    conflictCols: ['id'],
  },
  {
    name: 'review_tokens',
    colTypes: {
      expires_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
  },
  {
    name: 'convention_proposals',
    colTypes: {
      proposal_json: 'jsonb',
      created_at: 'timestamp',
      resolved_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'drift_reports',
    colTypes: {
      violations_json: 'jsonb',
      score: 'real',
      conventions_checked: 'int',
      files_sampled: 'int',
      impact_json: 'jsonb',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'spec_publications',
    colTypes: {
      tags: 'jsonb',
      sanitized_spec_json: 'jsonb',
      redaction_count: 'int',
      download_count: 'int',
      deleted_at: 'timestamp',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
    skipCols: ['search_vector'],
  },
  {
    name: 'spec_search_index',
    colTypes: {
      generated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
    skipCols: ['search_vector'],
  },
  {
    name: 'plan_quotas',
    colTypes: { quota_limit: 'int' },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'spec_research_cache',
    colTypes: {
      results_json: 'jsonb',
      created_at: 'timestamp',
    },
    conflictCols: ['spec_id', 'query', 'provider'],
  },
  {
    name: 'spec_generation_logs',
    colTypes: {
      duration_ms: 'int',
      input_tokens: 'int',
      output_tokens: 'int',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'rate_limits',
    colTypes: {
      max_requests: 'int',
      window_seconds: 'int',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },

  // ── Layer 10: wal_events (large, last among data tables) ──
  {
    name: 'wal_events',
    colTypes: {
      ts: 'timestamp',
      payload: 'jsonb',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },

  // ── Layer 11: agent config + skills + hooks ──
  {
    name: 'agent_hooks',
    colTypes: {
      enabled: 'bool',
      timeout_seconds: 'int',
      created_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'agent_profiles',
    colTypes: {
      allowed_tools: 'jsonb',
      is_active: 'bool',
      created_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'agent_config',
    colTypes: { updated_at: 'timestamp' },
    conflictCols: ['id'],
  },
  {
    name: 'run_queue',
    colTypes: {
      parallelism: 'int',
      auto_worktree: 'bool',
      position: 'int',
      created_at: 'timestamp',
      triggered_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'convention_packs',
    colTypes: {
      installed_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
  {
    name: 'installed_skills',
    colTypes: {
      installed_at: 'timestamp',
      updated_at: 'timestamp',
    },
    conflictCols: ['id'],
    hasSerialPk: true,
  },
];

// ---------------------------------------------------------------------------
// SQLite reader (dynamic import — better-sqlite3 is a peer dep)
// ---------------------------------------------------------------------------

interface SqliteDb {
  prepare(sql: string): { all(): Record<string, unknown>[] };
  pragma(sql: string): unknown;
  close(): void;
}

async function openSqlite(filePath: string): Promise<SqliteDb> {
  try {
    // Dynamic require — better-sqlite3 may not be installed
    const Database = require('better-sqlite3');
    return new Database(filePath, { readonly: true }) as SqliteDb;
  } catch {
    console.error(
      '\nError: better-sqlite3 is required for migration.\n' +
      'Install it with: npm install better-sqlite3\n' +
      '(Temporary dependency — only needed for migration, can uninstall after.)\n',
    );
    process.exit(1);
  }
}

function sqliteTableExists(db: SqliteDb, table: string): boolean {
  const rows = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
  ).all();
  return rows.length > 0;
}

function sqliteTableCount(db: SqliteDb, table: string): number {
  if (!sqliteTableExists(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).all()[0] as { cnt: number };
  return row.cnt;
}

function sqliteReadAll(db: SqliteDb, table: string): Record<string, unknown>[] {
  if (!sqliteTableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM "${table}"`).all();
}

// ---------------------------------------------------------------------------
// PostgreSQL writer
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

async function pgTableCount(pg: Pool, table: string): Promise<number> {
  try {
    const result = await pg.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
    return parseInt(result.rows[0].cnt, 10);
  } catch {
    return -1; // table doesn't exist
  }
}

/**
 * Transform a single row from SQLite types to PG types using the TableDef.
 */
function transformRow(
  row: Record<string, unknown>,
  def: TableDef,
  rowIdx: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const colTypes = def.colTypes ?? {};
  const skipSet = new Set(def.skipCols ?? []);

  for (const [col, val] of Object.entries(row)) {
    if (skipSet.has(col)) continue;

    const hint = colTypes[col];
    switch (hint) {
      case 'bool':
        out[col] = toBool(val);
        break;
      case 'timestamp':
        out[col] = toTimestamp(val);
        break;
      case 'jsonb': {
        const parsed = toJsonb(val);
        if (parsed === null && val !== null && val !== undefined) {
          // Malformed JSON — log error, insert raw text as fallback
          logError(def.name, rowIdx, row, `Malformed JSON in column ${col}: ${String(val).slice(0, 200)}`);
          out[col] = null;
        } else {
          out[col] = parsed !== null ? JSON.stringify(parsed) : null;
        }
        break;
      }
      case 'int':
        out[col] = val !== null && val !== undefined ? parseInt(String(val), 10) : null;
        break;
      case 'real':
        out[col] = val !== null && val !== undefined ? parseFloat(String(val)) : null;
        break;
      case 'raw':
        out[col] = val;
        break;
      default:
        // Default: pass through. If it looks like a JSON string in a non-typed column, leave as-is.
        out[col] = val;
    }
  }
  return out;
}

/**
 * Insert a batch of rows into PostgreSQL.
 * Uses ON CONFLICT DO NOTHING for idempotent re-runs.
 */
async function insertBatch(
  pg: Pool,
  def: TableDef,
  rows: Record<string, unknown>[],
  allColumns: string[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const cols = allColumns;
  const conflictStr = def.conflictCols.map((c) => `"${c}"`).join(', ');
  const overriding = def.hasSerialPk ? 'OVERRIDING SYSTEM VALUE' : '';

  let inserted = 0;
  const client = await pg.connect();
  try {
    await client.query('BEGIN');

    for (const row of rows) {
      const vals = cols.map((c) => row[c] ?? null);
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      const colStr = cols.map((c) => `"${c}"`).join(', ');

      const sql = `INSERT INTO "${def.name}" (${colStr}) ${overriding} VALUES (${placeholders}) ON CONFLICT (${conflictStr}) DO NOTHING`;

      try {
        const result = await client.query(sql, vals);
        inserted += result.rowCount ?? 0;
      } catch (err) {
        // Per-row error — log and continue
        const rowIdx = rows.indexOf(row);
        logError(def.name, rowIdx, row, err);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// Sequence reset — after inserting rows with explicit SERIAL IDs
// ---------------------------------------------------------------------------

async function resetSequences(pg: Pool, def: TableDef): Promise<void> {
  if (!def.hasSerialPk) return;

  // Find the sequence name for the 'id' column
  try {
    const seqResult = await pg.query(
      `SELECT pg_get_serial_sequence($1, 'id') AS seq`,
      [def.name],
    );
    const seqName = seqResult.rows[0]?.seq;
    if (seqName) {
      await pg.query(
        `SELECT setval($1, COALESCE((SELECT MAX(id) FROM "${def.name}"), 1))`,
        [seqName],
      );
    }
  } catch {
    // Not critical — sequence may not exist if table uses TEXT PKs
  }
}

// ---------------------------------------------------------------------------
// Main migration
// ---------------------------------------------------------------------------

interface MigrationSummary {
  table: string;
  sqliteCount: number;
  pgCountBefore: number;
  pgCountAfter: number;
  migrated: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}

async function migrateTable(
  sqliteDb: SqliteDb,
  pg: Pool,
  def: TableDef,
): Promise<MigrationSummary> {
  const startMs = Date.now();
  const tableName = def.sqliteName ?? def.name;

  const sqliteCount = sqliteTableCount(sqliteDb, tableName);
  const pgCountBefore = await pgTableCount(pg, def.name);

  if (sqliteCount === 0) {
    console.log(`  ${def.name}: 0 rows (skipping)`);
    return {
      table: def.name,
      sqliteCount: 0,
      pgCountBefore,
      pgCountAfter: pgCountBefore,
      migrated: 0,
      skipped: 0,
      errors: 0,
      elapsedMs: Date.now() - startMs,
    };
  }

  // Read all rows from SQLite
  const allRows = sqliteReadAll(sqliteDb, tableName);
  const skipSet = new Set(def.skipCols ?? []);

  // Legacy SQLite installed skills were global. Preserve them in the same
  // reserved, unreadable system scope used by the PostgreSQL migration rather
  // than guessing a workspace owner.
  const allColumns = Object.keys(allRows[0]).filter((c) => !skipSet.has(c));
  if (def.name === 'installed_skills') {
    await pg.query(
      `INSERT INTO workspaces (id, label, path)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [
        'rorca:system:legacy-installed-skills',
        '[System] Legacy Installed Skills (unscoped)',
        'system://legacy-installed-skills',
      ],
    );
    const reserved = await pg.query<{ label: string; path: string }>(
      'SELECT label, path FROM workspaces WHERE id = $1',
      ['rorca:system:legacy-installed-skills'],
    );
    if (
      reserved.rows[0]?.label !== '[System] Legacy Installed Skills (unscoped)'
      || reserved.rows[0]?.path !== 'system://legacy-installed-skills'
    ) {
      throw new Error('Reserved legacy installed-skills workspace id is already in use');
    }
    allColumns.push('workspace_id');
  }

  // Transform rows
  const errsBefore = totalErrors;
  const transformed: Record<string, unknown>[] = [];
  for (let i = 0; i < allRows.length; i++) {
    const transformedRow = transformRow(allRows[i], def, i);
    if (def.name === 'installed_skills') {
      transformedRow.workspace_id = 'rorca:system:legacy-installed-skills';
    }
    transformed.push(transformedRow);
  }

  // Insert in batches
  let totalInserted = 0;
  for (let batchStart = 0; batchStart < transformed.length; batchStart += BATCH_SIZE) {
    const batch = transformed.slice(batchStart, batchStart + BATCH_SIZE);
    const inserted = await insertBatch(pg, def, batch, allColumns);
    totalInserted += inserted;
    printProgress(def.name, Math.min(batchStart + BATCH_SIZE, transformed.length), transformed.length, startMs);
  }

  // Reset sequence for SERIAL PKs
  await resetSequences(pg, def);

  const pgCountAfter = await pgTableCount(pg, def.name);
  const errsThisTable = totalErrors - errsBefore;

  console.log(''); // newline after progress bar

  return {
    table: def.name,
    sqliteCount,
    pgCountBefore,
    pgCountAfter,
    migrated: totalInserted,
    skipped: sqliteCount - totalInserted - errsThisTable,
    errors: errsThisTable,
    elapsedMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function verifyResults(summaries: MigrationSummary[]): boolean {
  console.log('\n' + '='.repeat(70));
  console.log('VERIFICATION — Row Count Comparison');
  console.log('='.repeat(70));
  console.log(
    'Table'.padEnd(35) +
    'SQLite'.padStart(10) +
    'PG After'.padStart(10) +
    'Status'.padStart(10),
  );
  console.log('-'.repeat(65));

  let allMatch = true;
  for (const s of summaries) {
    const match = s.pgCountAfter >= s.sqliteCount;
    if (!match) allMatch = false;
    const status = s.sqliteCount === 0 ? 'EMPTY' : match ? 'OK' : 'MISMATCH';
    console.log(
      s.table.padEnd(35) +
      String(s.sqliteCount).padStart(10) +
      String(s.pgCountAfter).padStart(10) +
      status.padStart(10),
    );
  }

  return allMatch;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { sqlitePath, pgUrl } = parseArgs();

  console.log('='.repeat(70));
  console.log('Rorca SQLite → PostgreSQL Migration');
  console.log('='.repeat(70));
  console.log(`  SQLite: ${sqlitePath}`);
  console.log(`  PG:     ${pgUrl.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`);
  console.log(`  Tables: ${TABLE_DEFS.length}`);
  console.log('');

  initErrorLog();

  // Open SQLite
  const sqliteDb = await openSqlite(sqlitePath);

  // Open PostgreSQL
  const pg = new Pool({
    connectionString: pgUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
  });

  // Test PG connection
  try {
    await pg.query('SELECT 1');
    console.log('PostgreSQL connection: OK\n');
  } catch (err) {
    console.error(`PostgreSQL connection failed: ${err instanceof Error ? err.message : err}`);
    sqliteDb.close();
    await pg.end();
    process.exit(1);
  }

  const globalStart = Date.now();
  const summaries: MigrationSummary[] = [];
  let totalMigrated = 0;

  for (const def of TABLE_DEFS) {
    const summary = await migrateTable(sqliteDb, pg, def);
    summaries.push(summary);
    totalMigrated += summary.migrated;
  }

  // Close connections
  sqliteDb.close();

  // Verification
  const allMatch = verifyResults(summaries);

  // Summary
  const elapsed = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(70));
  console.log('MIGRATION SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total rows migrated: ${totalMigrated}`);
  console.log(`  Tables processed:    ${summaries.length}`);
  console.log(`  Errors encountered:  ${totalErrors}`);
  console.log(`  Elapsed time:        ${elapsed}s`);
  if (totalErrors > 0) {
    console.log(`  Error log:           ${ERROR_LOG_PATH}`);
  }
  console.log(`  Verification:        ${allMatch ? 'PASSED' : 'DISCREPANCIES FOUND'}`);
  console.log('='.repeat(70));

  errorLogStream.end();
  await pg.end();

  if (totalErrors > 0 || !allMatch) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
