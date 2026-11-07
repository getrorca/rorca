/**
 * Copyright (c) 2026 Rorca Inc.
 * SPDX-License-Identifier: Apache-2.0
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE file in the project root for full license text.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DEFAULT_BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const RETENTION_DAYS = 30;
const DEFAULT_BACKUP_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_BACKUP_TIMEOUT_MS = 60 * 60 * 1_000;
let activeBackup: Promise<{ filename: string; path: string; size: number }> | null = null;


export function getBackupDir(): string {
  return process.env.BACKUP_DIR || DEFAULT_BACKUP_DIR;
}

/**
 * Build libpq environment variables from the same connection URL as the pool.
 * A URI is valid for libpq's dbname command argument, but not for PGDATABASE.
 */
function buildPgDumpEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    env.PGHOST = process.env.PGHOST || 'localhost';
    env.PGPORT = process.env.PGPORT || '5432';
    env.PGUSER = process.env.PGUSER || 'rorca';
    env.PGPASSWORD = process.env.PGPASSWORD || 'rorca';
    env.PGDATABASE = process.env.PGDATABASE || 'rorca';
    return env;
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL for pg_dump');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql protocol for pg_dump');
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('DATABASE_URL must name a database for pg_dump');
  env.PGHOST = url.hostname;
  env.PGPORT = url.port || '5432';
  env.PGUSER = decodeURIComponent(url.username);
  env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = database;
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) env.PGSSLMODE = sslMode;
  return env;
}

function backupTimeoutMs(): number {
  const configured = Number.parseInt(process.env.BACKUP_TIMEOUT_MS ?? '', 10);
  return Number.isSafeInteger(configured) && configured >= 60_000 && configured <= MAX_BACKUP_TIMEOUT_MS
    ? configured
    : DEFAULT_BACKUP_TIMEOUT_MS;
}


/**
 * Create a PostgreSQL backup using pg_dump.
 * Produces a custom-format dump file for consistent snapshots.
 * Returns the absolute path to the backup file.
 */
export function createBackup(): Promise<{ filename: string; path: string; size: number }> {
  if (activeBackup) return activeBackup;

  const backup = createBackupOnce();
  const tracked = backup.finally(() => {
    if (activeBackup === tracked) activeBackup = null;
  });
  activeBackup = tracked;
  return tracked;
}

async function createBackupOnce(): Promise<{ filename: string; path: string; size: number }> {
  const backupDir = getBackupDir();
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `rorca-backup-${timestamp}-${randomUUID()}.sql`;
  const backupPath = path.join(backupDir, filename);
  const args: string[] = ['--format=custom', '--file', backupPath];
  const pgDumpBin = process.env.PG_DUMP_BIN || 'pg_dump';
  await execFileAsync(pgDumpBin, args, {
    env: buildPgDumpEnv(),
    timeout: backupTimeoutMs(),
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
