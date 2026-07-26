/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const RETENTION_DAYS = 30;

export function getBackupDir(): string {
  return process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

/**
 * Build the pg_dump connection args from the same env vars the pool uses.
 */
function buildPgDumpEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  if (process.env.DATABASE_URL) {
    // Keep credentials out of argv and child-process error messages. libpq accepts
    // a connection URI through PGDATABASE, so pg_dump still uses the pool's exact
    // database identity without exposing it in process listings or logs.
    env.PGDATABASE = process.env.DATABASE_URL;
  } else {
    env.PGHOST = process.env.PGHOST || 'localhost';
    env.PGPORT = process.env.PGPORT || '5432';
    env.PGUSER = process.env.PGUSER || 'rorca';
    env.PGPASSWORD = process.env.PGPASSWORD || 'rorca';
    env.PGDATABASE = process.env.PGDATABASE || 'rorca';
  }

  return env;
}

/**
 * Create a PostgreSQL backup using pg_dump.
 * Produces a custom-format dump file for consistent snapshots.
 * Returns the absolute path to the backup file.
 */
export async function createBackup(): Promise<{ filename: string; path: string; size: number }> {
  const backupDir = getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `rorca-backup-${timestamp}.sql`;
  const backupPath = path.join(backupDir, filename);

  const args: string[] = ['--format=custom', '--file', backupPath];

  const pgDumpBin = process.env.PG_DUMP_BIN || 'pg_dump';
  await execFileAsync(pgDumpBin, args, {
    env: buildPgDumpEnv(),
    timeout: 120_000,
  });

  const stat = fs.statSync(backupPath);
  return { filename, path: backupPath, size: stat.size };
}

export interface BackupInfo {
  filename: string;
  size: number;
  createdAt: string;
}

/**
 * List available backups sorted by creation time (newest first).
 */
export function listBackups(): BackupInfo[] {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return [];

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('rorca-backup-') && f.endsWith('.sql'));

  return files
    .map(filename => {
      const stat = fs.statSync(path.join(backupDir, filename));
      return {
        filename,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Delete backups older than RETENTION_DAYS.
 * Returns count of deleted files.
 */
export function pruneOldBackups(): number {
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) return 0;

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deleted = 0;

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('rorca-backup-') && f.endsWith('.sql'));

  for (const filename of files) {
    const filePath = path.join(backupDir, filename);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(filePath);
      deleted++;
    }
  }

  return deleted;
}
