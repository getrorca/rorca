#!/usr/bin/env node
/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: BUSL-1.1
 * Licensed under the Business Source License 1.1.
 * See LICENSE file in the project root for full license text.
 */

/**
 * rename-migrations.ts — Convert sequential migration filenames (001–078) to timestamp format
 *
 * This script renames all existing sequential migration files in backend/src/db/pg-migrations/
 * to timestamp format (14-digit YYYYMMDDHHMMSS prefix). Timestamps are derived from git blame
 * (first commit date of each file) or monotonically increasing fallback timestamps if git is
 * unavailable.
 *
 * Usage:
 *   npx tsx backend/scripts/rename-migrations.ts [--dry-run]
 *
 * The script is idempotent: running it twice produces no changes on the second run.
 * Already-renamed files (matching /^\d{14}_/) are left untouched.
 *
 * Output:
 * - A table of old filename → new filename mappings
 * - A companion SQL UPDATE statement for schema_migrations table
 * - Actual file renames (unless --dry-run is specified)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'pg-migrations');
const DRY_RUN = process.argv.includes('--dry-run');

// Base timestamp for fallback (start of 2026-01-01 00:00:00 UTC)
const FALLBACK_BASE_TIMESTAMP = 20260101000000;

interface MigrationFile {
  oldName: string;
  numericPrefix: number;
  description: string;
  newName?: string;
  timestamp?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Extract version and description from filename
// ─────────────────────────────────────────────────────────────────────────────

function parseMigrationFilename(filename: string): MigrationFile | null {
  // Check if already in timestamp format (14-digit prefix)
  const timestampMatch = filename.match(/^(\d{14})_(.+)\.sql$/);
  if (timestampMatch) {
    return null; // Already converted, skip
  }

  // Extract numeric prefix and description from sequential format (NNN_description.sql)
  const sequentialMatch = filename.match(/^(\d{3})_(.+)\.sql$/);
  if (!sequentialMatch) {
    return null; // Not a valid migration file
  }

  const numericPrefix = parseInt(sequentialMatch[1], 10);
  const description = sequentialMatch[2];

  return {
    oldName: filename,
    numericPrefix,
    description,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Get git commit timestamp for a file
// ─────────────────────────────────────────────────────────────────────────────

function getGitCommitTimestamp(filePath: string): number | null {
  try {
    // Use git log with --follow (tracks renames) and --diff-filter=A (first add).
    // Get the last (earliest) timestamp by reversing the list.
    const cmd = `git log --follow --format=%at --diff-filter=A -- "${filePath}"`;
    const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

    if (!output) {
      return null;
    }

    // Split by newlines and take the LAST line (earliest commit)
    const lines = output.split('\n').filter(line => line.trim());
    if (lines.length === 0) {
      return null;
    }

    const unixTimestamp = parseInt(lines[lines.length - 1], 10);
    if (isNaN(unixTimestamp)) {
      return null;
    }

    // Convert unix timestamp (seconds since epoch) to YYYYMMDDHHMMSS format
    const date = new Date(unixTimestamp * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');

    return parseInt(`${year}${month}${day}${hours}${minutes}${seconds}`, 10);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: Rename migrations
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  // Check if migrations directory exists
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌ Migrations directory not found: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }

  // Read all .sql files
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'));

  // Parse and filter only sequential migrations (not already converted)
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const parsed = parseMigrationFilename(file);
    if (parsed) {
      migrations.push(parsed);
    }
  }

  if (migrations.length === 0) {
    console.log('✓ No sequential migrations found to rename. All files are already in timestamp format or invalid.');
    process.exit(0);
  }

  // Sort by numeric prefix, then by oldName for deterministic order (handles duplicate prefixes)
  migrations.sort((a, b) => {
    if (a.numericPrefix !== b.numericPrefix) {
      return a.numericPrefix - b.numericPrefix;
    }
    // Same prefix: sort by filename alphabetically for deterministic order
    return a.oldName.localeCompare(b.oldName);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 1: Collect timestamps (per file, not per prefix)
  // ───────────────────────────────────────────────────────────────────────────

  // Map from oldName → timestamp (not from prefix, to handle duplicate prefixes)
  const gitTimestamps = new Map<string, number>();
  const maxGitTimestamp: { value: number } = { value: FALLBACK_BASE_TIMESTAMP - 1 };

  for (const migration of migrations) {
    const filePath = path.join(MIGRATIONS_DIR, migration.oldName);
    const gitTs = getGitCommitTimestamp(filePath);

    if (gitTs) {
      gitTimestamps.set(migration.oldName, gitTs);
      maxGitTimestamp.value = Math.max(maxGitTimestamp.value, gitTs);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 2: Assign timestamps with monotonic deduplication
  // ───────────────────────────────────────────────────────────────────────────

  let fallbackCounter = 0;
  const timestamps = new Map<string, number>(); // Map from oldName → timestamp
  let previousTimestamp = Math.max(maxGitTimestamp.value, FALLBACK_BASE_TIMESTAMP - 1);

  for (const migration of migrations) {
    let timestamp = gitTimestamps.get(migration.oldName);

    // If no git timestamp, use fallback
    if (!timestamp) {
      // Always use previousTimestamp + 1 for fallback files (ensures monotonicity)
      timestamp = previousTimestamp + 1;
      fallbackCounter++;
    } else {
      // Deduplicate: if this git timestamp equals or precedes the previous assignment,
      // increment it by 1. This handles multiple files from the same commit or same prefix.
      if (timestamp <= previousTimestamp) {
        timestamp = previousTimestamp + 1;
      }
    }

    timestamps.set(migration.oldName, timestamp);
    previousTimestamp = timestamp;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 3: Generate new filenames and mapping table
  // ───────────────────────────────────────────────────────────────────────────

  const mapping: Array<{ oldName: string; newName: string; oldNumeric: number }> = [];

  for (const migration of migrations) {
    const timestamp = timestamps.get(migration.oldName)!;
    const newName = `${timestamp}_${migration.description}.sql`;
    migration.newName = newName;

    mapping.push({
      oldName: migration.oldName,
      newName,
      oldNumeric: migration.numericPrefix,
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 4: Print mapping table
  // ───────────────────────────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(80));
  console.log('MIGRATION RENAME MAPPING');
  console.log('='.repeat(80) + '\n');

  console.log('Old Filename'.padEnd(50) + 'New Filename');
  console.log('-'.repeat(50) + '-'.repeat(30));

  for (const { oldName, newName } of mapping) {
    console.log(oldName.padEnd(50) + newName);
  }

  console.log('\n' + '='.repeat(80));
  console.log('SCHEMA MIGRATIONS UPDATE STATEMENT');
  console.log('='.repeat(80) + '\n');

  console.log('Run the following SQL to update the schema_migrations table:');
  console.log('(Only required if migrations have already been applied)\n');

  console.log('BEGIN TRANSACTION;');
  for (const { oldName, newName, oldNumeric } of mapping) {
    // The old version is the numeric prefix (e.g., 001 → 1)
    console.log(`UPDATE schema_migrations SET filename = '${newName}' WHERE version = ${oldNumeric} AND filename = '${oldName}';`);
  }
  console.log('COMMIT;\n');

  // ───────────────────────────────────────────────────────────────────────────
  // Phase 5: Perform renames (unless --dry-run)
  // ───────────────────────────────────────────────────────────────────────────

  if (DRY_RUN) {
    console.log('🏁 DRY RUN — No files were renamed.');
    console.log('   Re-run without --dry-run to apply changes.\n');
    process.exit(0);
  }

  console.log('🔄 Renaming files...\n');

  for (const migration of migrations) {
    const oldPath = path.join(MIGRATIONS_DIR, migration.oldName);
    const newPath = path.join(MIGRATIONS_DIR, migration.newName!);

    try {
      fs.renameSync(oldPath, newPath);
      console.log(`✓ ${migration.oldName} → ${migration.newName}`);
    } catch (err) {
      console.error(`✗ Failed to rename ${migration.oldName}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(`✅ Successfully renamed ${mapping.length} migration files.`);
  console.log('='.repeat(80) + '\n');

  console.log('⚠️  IMPORTANT: Update your database!');
  console.log('   If migrations have already been applied, run the SQL UPDATE statements above.');
  console.log('   See backend/src/db/pg-index.ts for integration details.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Execute
// ─────────────────────────────────────────────────────────────────────────────

try {
  main();
} catch (err) {
  console.error('❌ Error:', (err as Error).message);
  process.exit(1);
}
